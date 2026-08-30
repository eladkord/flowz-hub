# Flowz Hub → Mini-Drive — Build Plan (Handoff)

**Status:** approved plan, ready to build · **Owner:** Elad Kord · **Written:** 2026-08-25
**Prime directive: do NOT touch the production hub until the final merge step.** The hub is actively used in a live, time-sensitive business negotiation. Everything ships to a preview branch first.

---

## 1 · Context — what exists today (read before writing any code)

- **Site:** https://flowz-hub.pages.dev — Cloudflare Pages project `flowz-hub`, **direct-upload** (git pushes do NOT deploy; the repo `eladkord/flowz-hub` is a mirror only).
- **Source folder:** `C:\Users\eladk\Projects\flowz-site` (this folder).
- **Deploy command (production):**
  `npx wrangler pages deploy . --project-name=flowz-hub --branch=main --commit-dirty=true`
  Wrangler is OAuth-authenticated on Elad's machine.
- **Current content (all static HTML, all must keep working untouched):**
  - `/` — hub index (door grid, two sections: main + "To Review")
  - `/tdd/` `/mission/` `/tiers/` — decks & docs
  - `/nda/` — NDA page + PDF — **PUBLIC carve-out, link already shared with an external counterparty. Breaking or gating this path is a critical failure.**
  - `/deal-tmx-8k3/` + `/eventim/` `/roee/` `/roee-script/` under it — confidential deal decks (these also have a legacy client-side sessionStorage gate, key `tmx-gate-ok`, code `2houses`; keep as-is)
- **Server-side auth (already live):** `functions/_middleware.js` —
  - Session cookie `fz_auth` = `b64u(email).expiry.hmacSHA256(SESSION_SECRET, ...)`, 7 days, HttpOnly/Secure/Lax.
  - Routes handled in-middleware: `GET/POST /login` (RTL Hebrew login page), `/logout`.
  - Public paths: `/^\/nda(\/|$)/`, `/^\/favicon/`. Everything else 302 → `/login?next=…`.
  - **Project secrets (Cloudflare, never in repo):** `USERS` = `email:password;email:password`, `SESSION_SECRET`.
- **Design system:** cream/ink/orange, Rubik (Hebrew) + Sora/Inter, rounded cards — copy tokens from `index.html` or any deck. New UI must look native to it.

## 2 · Goal

Turn the hub into a mini Google Drive for the Flowz founders:

1. Folders (create, nest), file upload, **drag & drop** (upload + move).
2. Rename files and folders inline.
3. **Archive** (soft-hide, restorable) — not hard delete by default.
4. **Share links per file/folder** — revocable, optional expiry, per-link choice: public-with-token OR login-required.
5. **Login with permissions across the whole hub** (extend existing auth with roles).
6. **Search** — instant by filename, and by **file content**.
7. **Connect more Claude users** — Aviv gets an account and his Claude Code sessions can deploy/upload too.

## 3 · Architecture

Stay 100% on Cloudflare, extend what exists:

| Layer | Choice | Notes |
|---|---|---|
| Storage | **R2 bucket `flowz-drive`** | User-managed files only. Git-deployed decks stay a read-only "System" section in the UI (they are code, versioned, session-deployed) |
| Metadata / ACL / search | **D1 database `flowz-drive-db`** | SQLite; content search via **FTS5** virtual table |
| Backend | **Pages Functions** under `functions/api/drive/*` + `functions/s/[token].js` | Same project, same middleware chain |
| Auth roles | Extend `USERS` secret format → `email:password:role` (role ∈ admin/editor/viewer; missing role = admin for backward-compat) | Parse in middleware; put `role` into the session cookie payload |
| UI | SPA at `/drive/` (single `index.html`, vanilla JS, hub design system) | Tree sidebar · file grid · dropzone · inline rename · archive view · search box · share dialog |
| Bindings | `wrangler.toml` in repo root (Pages supports config-file bindings) | `r2_buckets = [{binding="DRIVE", bucket_name="flowz-drive"}]`, `d1_databases = [{binding="DB", database_name="flowz-drive-db", database_id="…"}]` |

**One-time setup:** `npx wrangler r2 bucket create flowz-drive` · `npx wrangler d1 create flowz-drive-db` · add new secret `SHARE_SECRET`.

## 4 · D1 schema (sketch — refine as needed)

```sql
CREATE TABLE folders(id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
  archived INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER);
CREATE TABLE files(id TEXT PRIMARY KEY, folder_id TEXT, name TEXT NOT NULL,
  r2_key TEXT NOT NULL, size INTEGER, mime TEXT,
  archived INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE shares(token TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('file','folder')),
  target_id TEXT NOT NULL, mode TEXT CHECK(mode IN ('public','login')),
  expires_at INTEGER, created_by TEXT, created_at INTEGER, revoked INTEGER DEFAULT 0);
CREATE VIRTUAL TABLE file_fts USING fts5(file_id UNINDEXED, name, content);
```

## 5 · API surface (`/api/drive/*`, JSON, auth required; editor+ for writes)

- `GET  list?folder=…&archived=0|1` — folder tree node + files
- `POST upload` (multipart) — streams to R2, inserts row, queues text extraction
- `POST mkdir` · `POST rename` · `POST move` (drag & drop target) · `POST archive` / `restore` · `POST delete` (admin only, permanent — confirm dialog)
- `GET  download?id=…` — streams from R2 with Content-Disposition
- `POST share` → `{url:"/s/{token}"}` · `POST share/revoke`
- `GET  search?q=…&scope=name|content`
- `GET  /s/{token}` — share route (middleware must let `mode=public` tokens through pre-auth; validate token, expiry, revocation; folder shares render a minimal listing)

## 6 · Content search pipeline

On upload, extract text → `file_fts`: phase-1 native (`txt md html json csv`), phase-3 `pdf` (unpdf/pdf.js WASM in Functions) and `docx` (unzip `word/document.xml`, strip tags — no external services). Files without extractable text are name-search only.

## 7 · Multi-user & Claude sessions

1. **Aviv account:** add `aviv@…:pw:admin` to `USERS` secret. Zero code.
2. **Aviv's Claude deploys:** he runs `npx wrangler login` once on his machine (same CF account or a scoped API token) → same deploy command works. Document in README.
3. **Phase 4:** `POST /api/drive/upload` accepts `Authorization: Bearer $DRIVE_API_TOKEN` (new secret) so any Claude session can push files without wrangler.

## 8 · Phases & acceptance

- **P1 — Core (first session):** bindings setup · roles in middleware (backward-compatible!) · `/drive/` UI with tree, upload+drag&drop, mkdir, rename, move, archive, filename search. ✔ Accept: full flow works on preview URL; production untouched; `/nda` still public; old sessions still valid.
- **P2 — Sharing:** share dialog, `/s/{token}` both modes, revoke, expiry, archive view polish. ✔ Accept: public link works logged-out; revoked link 404s.
- **P3 — Content search:** FTS + extraction (txt/md/html first, then pdf/docx). ✔ Accept: search finds a word inside an uploaded PDF.
- **P4 — Users & API:** user management UI (admin), bearer-token upload API, README for Aviv. ✔ Accept: Aviv logs in with viewer/editor role limits enforced; API upload lands in Drive.

## 9 · Guardrails (hard rules)

1. **All work deploys to a preview branch:** `npx wrangler pages deploy . --project-name=flowz-hub --branch=drive-dev --commit-dirty=true` → served at `https://drive-dev.flowz-hub.pages.dev`. Production (`--branch=main`) only after Elad walks through the preview and says go.
2. `/nda` public carve-out survives every middleware change. Add a regression check before each deploy: `curl -s -o /dev/null -w "%{http_code}" https://drive-dev.flowz-hub.pages.dev/nda/` must be `200`.
3. Existing USERS entries without a `:role` suffix must keep working as admin (don't lock Elad out).
4. Secrets only via `wrangler pages secret put` — never committed. The repo is public.
5. Deck folders (`/tdd /mission /tiers /deal-tmx-8k3 …`) are not migrated, moved, or renamed.
6. Rollback story: Pages keeps previous deployments — re-deploy the last good build from the local git history if needed (repo mirror: `git log` in this folder).

## 10 · Open questions — recommended defaults (proceed with these unless Elad says otherwise)

1. Existing decks in Drive? → **No.** Read-only "System" section linking to them; Drive manages uploaded documents only.
2. Share links → **Both modes, chosen per link** (public-with-token / login-required).
3. Launch users → **Elad (admin) + Aviv (admin).** Others later via P4 UI.
