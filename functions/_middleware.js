// Flowz Hub — server-side auth (Cloudflare Pages Functions middleware).
// Credentials live in project secrets (USERS, SESSION_SECRET) — never in this file.
// USERS format: "email:password;email:password"  ·  Session: signed cookie, 7 days.
// Public carve-outs: /nda (link already shared externally), /login, /logout.

const PUBLIC_PATHS = [/^\/nda(\/|$)/, /^\/favicon/];
const SESSION_DAYS = 7;
const COOKIE = "fz_auth";

const enc = new TextEncoder();

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const b64u = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDec = s => { try { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); } catch { return null; } };

function getCookie(request, name) {
  const h = request.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function validSession(request, env) {
  const c = getCookie(request, COOKIE);
  if (!c) return null;
  const [emailB64, exp, sig] = c.split(".");
  if (!emailB64 || !exp || !sig) return null;
  if (Date.now() > Number(exp)) return null;
  const expect = await hmacHex(env.SESSION_SECRET || "", emailB64 + "." + exp);
  if (sig !== expect) return null;
  return b64uDec(emailB64);
}

function parseUsers(env) {
  const map = new Map();
  (env.USERS || "").split(";").forEach(pair => {
    const i = pair.indexOf(":");
    if (i > 0) map.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1));
  });
  return map;
}

function loginPage(err, next) {
  const html = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex,nofollow">
<title>Flowz Hub — כניסה</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%23F0641E'/><text x='50' y='72' font-size='62' font-weight='800' font-family='Arial' text-anchor='middle' fill='white'>Z</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;800&family=Rubik:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{margin:0;font-family:'Rubik',system-ui,sans-serif;background:#FAF6EF;color:#2B2620;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#FFFDF9;border-radius:22px;box-shadow:0 10px 34px rgba(90,70,40,.10);border:1px solid rgba(120,95,60,.06);padding:38px 42px;max-width:400px;width:calc(100% - 48px);text-align:center}
.brand{font-family:'Sora';font-weight:800;font-size:26px;letter-spacing:.02em}.brand span{color:#F0641E}
p.sub{font-size:13.5px;color:#6E6659;margin:8px 0 22px;line-height:1.6}
label{display:block;text-align:right;font-size:12.5px;font-weight:600;color:#6E6659;margin:12px 2px 5px}
input{width:100%;box-sizing:border-box;font-family:'Sora';font-size:14px;padding:11px 13px;border:1.5px solid #E4DACB;border-radius:12px;direction:ltr;background:#fff}
input:focus{outline:none;border-color:#F0641E}
button{width:100%;margin-top:20px;font-family:'Rubik';font-weight:700;font-size:15px;background:#F0641E;color:#fff;border:none;border-radius:12px;padding:12px;cursor:pointer}
button:hover{filter:brightness(1.05)}
.err{color:#D14343;font-size:13px;min-height:18px;margin-top:12px;font-weight:600}
.foot{margin-top:18px;font-size:11px;color:#B4A890;font-weight:600;letter-spacing:.06em}
</style></head><body>
<form class="box" method="POST" action="/login?next=${encodeURIComponent(next)}">
  <div class="brand">FLOW<span>Z</span> · HUB</div>
  <p class="sub">אזור פנימי. כניסה עם המייל והסיסמה שהוגדרו.</p>
  <label>אימייל</label><input type="email" name="email" autocomplete="username" required autofocus>
  <label>סיסמה</label><input type="password" name="password" autocomplete="current-password" required>
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
  <button type="submit">כניסה</button>
  <div class="err">${err || ""}</div>
  <div class="foot">FLOWZ · PRIVATE WORKSPACE</div>
</form></body></html>`;
  return new Response(html, { status: err ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function safeNext(v) {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/";
}

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/logout") {
    return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, "Cache-Control": "no-store" } });
  }

  if (path === "/login") {
    if (request.method === "POST") {
      const form = await request.formData();
      const email = String(form.get("email") || "").trim().toLowerCase();
      const pass = String(form.get("password") || "");
      const nxt = safeNext(url.searchParams.get("next") || String(form.get("next") || "/"));
      const users = parseUsers(env);
      if (users.has(email) && users.get(email) === pass && pass.length > 0) {
        const exp = Date.now() + SESSION_DAYS * 864e5;
        const emailB64 = b64u(email);
        const sig = await hmacHex(env.SESSION_SECRET || "", emailB64 + "." + exp);
        const cookie = `${COOKIE}=${emailB64}.${exp}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
        return new Response(null, { status: 302, headers: { Location: nxt, "Set-Cookie": cookie, "Cache-Control": "no-store" } });
      }
      return loginPage("מייל או סיסמה לא נכונים", nxt);
    }
    if (await validSession(request, env)) {
      return new Response(null, { status: 302, headers: { Location: safeNext(url.searchParams.get("next") || "/"), "Cache-Control": "no-store" } });
    }
    return loginPage("", safeNext(url.searchParams.get("next") || "/"));
  }

  if (PUBLIC_PATHS.some(re => re.test(path))) return next();

  if (await validSession(request, env)) return next();

  return new Response(null, { status: 302, headers: { Location: "/login?next=" + encodeURIComponent(path + url.search), "Cache-Control": "no-store" } });
}
