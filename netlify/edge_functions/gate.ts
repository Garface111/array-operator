// Array Operator — PREPROD access gate (Netlify Edge Function)
//
// Runs on EVERY request to the preprod preview site and decides who gets in:
//   1. Requests from an allowlisted IP (Ford's computer / network) pass
//      SILENTLY — no prompt, no friction.
//   2. Everyone else must present HTTP Basic Auth matching the beta
//      credentials (the "beta program" password). This is the durable
//      fallback for Ford too, since a residential IP rotates.
//   3. Anything else gets a branded 401 "Private Preview" page + a Basic-Auth
//      challenge, with a link to request beta access.
//
// This file NEVER runs on production: arrayoperator.com deploys only
// `git archive HEAD public` (the public/ dir) via the REST helper, so the
// root-level netlify.toml + this edge function are simply not part of the prod
// artifact. The gate is structurally preprod-only.
//
// Config (Netlify site env vars on the preprod site only):
//   PREPROD_ALLOW_IPS  comma-separated IP allowlist (silent pass)
//   PREPROD_BETA_USER  Basic-Auth username (default "beta")
//   PREPROD_BETA_PASS  Basic-Auth password (the beta gate; required)
//   PREPROD_REQUEST_EMAIL  where "request access" mailto points

import type { Context } from "https://edge.netlify.com";

function env(k: string): string {
  // Netlify.env is the documented accessor; fall back to Deno.env.
  try { return (globalThis as any).Netlify?.env?.get(k) ?? (globalThis as any).Deno?.env?.get(k) ?? ""; }
  catch { return ""; }
}

const ALLOW_IPS = env("PREPROD_ALLOW_IPS").split(",").map((s) => s.trim()).filter(Boolean);
const BETA_USER = env("PREPROD_BETA_USER") || "beta";
const BETA_PASS = env("PREPROD_BETA_PASS");
const REQUEST_EMAIL = env("PREPROD_REQUEST_EMAIL") || "ford.genereaux@gmail.com";

const REALM = "Array Operator — Private Preview";

function gatePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Array Operator — Private Preview</title>
<style>
  :root{--bg:#f6f8fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#e2e8f0;
        --blue:#2563eb;--blue2:#1d4ed8}
  @media (prefers-color-scheme:dark){:root{--bg:#0a0e14;--card:#0e131c;--ink:#eaf0f7;
        --muted:#8b97a8;--line:rgba(255,255,255,.10)}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);
       color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}
  .card{max-width:440px;width:calc(100% - 40px);background:var(--card);border:1px solid var(--line);
        border-radius:18px;padding:34px 30px;box-shadow:0 1px 3px rgba(15,23,42,.07),0 24px 60px -34px rgba(15,23,42,.35)}
  .orb{width:38px;height:38px;border-radius:11px;background:linear-gradient(150deg,#3b82f6,#1d4ed8);
       box-shadow:0 6px 18px -6px rgba(37,99,235,.6);margin-bottom:18px}
  .eyebrow{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--blue)}
  h1{font-size:22px;margin:.35em 0 .3em;letter-spacing:-.01em}
  p{color:var(--muted);margin:.4em 0}
  .cta{display:inline-block;margin-top:16px;padding:11px 18px;border-radius:11px;
       background:linear-gradient(180deg,#3b82f6,#1d4ed8);color:#fff;text-decoration:none;
       font-weight:650;box-shadow:0 8px 22px -12px rgba(37,99,235,.8)}
  .hint{margin-top:20px;font-size:12.5px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
  code{background:rgba(37,99,235,.10);padding:1px 6px;border-radius:6px;font-size:12.5px}
</style></head><body>
  <div class="card">
    <div class="orb"></div>
    <div class="eyebrow">Array Operator</div>
    <h1>Private preview</h1>
    <p>This is the Array Operator <b>preprod</b> environment — where new changes
       are tested before they reach the live product. It's invite-only.</p>
    <p>If you have beta access, your browser will prompt for it. Otherwise, ask
       to join the beta program.</p>
    <a class="cta" href="mailto:${REQUEST_EMAIL}?subject=Array%20Operator%20beta%20access">Request beta access →</a>
    <div class="hint">Already in the beta? Reload and enter your <code>beta</code> credentials when prompted.
       The live product is at <a href="https://arrayoperator.com" style="color:var(--blue)">arrayoperator.com</a>.</div>
  </div>
</body></html>`;
}

export default async (req: Request, context: Context): Promise<Response | void> => {
  const ip = (context as any).ip || req.headers.get("x-nf-client-connection-ip") || "";

  // 1. Silent IP allowlist
  if (ALLOW_IPS.length && ip && ALLOW_IPS.includes(ip)) {
    return context.next();
  }

  // 2. Basic-Auth beta credentials
  const auth = req.headers.get("authorization") || "";
  if (BETA_PASS && auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const i = decoded.indexOf(":");
      const user = decoded.slice(0, i);
      const pass = decoded.slice(i + 1);
      if (user === BETA_USER && pass === BETA_PASS) return context.next();
    } catch { /* fall through to challenge */ }
  }

  // 3. Challenge + branded page
  return new Response(gatePage(), {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
};

export const config = { path: "/*" };
