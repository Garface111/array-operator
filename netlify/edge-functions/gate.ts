// Array Operator — PREPROD access gate (Netlify Edge Function)
//
// Runs on every request to the preprod preview site:
//   1. Allowlisted IP (Ford's computer/network) -> pass silently.
//   2. Everyone else -> branded 403 "Private Preview" page (no login prompt).
//
// Registered via netlify.toml ([[edge_functions]] path="/*" function="gate").
// Structurally preprod-only: prod deploys only public/ via the REST helper, so
// this file is never part of the prod artifact.
//
// Site env vars (preprod site only): PREPROD_ALLOW_IPS (comma-sep IP allowlist),
// PREPROD_REQUEST_EMAIL (where the "request access" mailto points).

function getEnv(k) {
  try {
    // Netlify global is the documented accessor in the edge runtime.
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(k) || "";
  } catch (_e) {}
  return "";
}

function gatePage(requestEmail) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Array Operator — Private Preview</title>
<style>
  :root{--bg:#f6f8fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#e2e8f0;--blue:#2563eb}
  @media (prefers-color-scheme:dark){:root{--bg:#0a0e14;--card:#0e131c;--ink:#eaf0f7;--muted:#8b97a8;--line:rgba(255,255,255,.10)}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}
  .card{max-width:440px;width:calc(100% - 40px);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:34px 30px;box-shadow:0 1px 3px rgba(15,23,42,.07),0 24px 60px -34px rgba(15,23,42,.35)}
  .orb{width:38px;height:38px;border-radius:11px;background:linear-gradient(150deg,#3b82f6,#1d4ed8);box-shadow:0 6px 18px -6px rgba(37,99,235,.6);margin-bottom:18px}
  .eyebrow{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--blue)}
  h1{font-size:22px;margin:.35em 0 .3em;letter-spacing:-.01em}
  p{color:var(--muted);margin:.4em 0}
  .cta{display:inline-block;margin-top:16px;padding:11px 18px;border-radius:11px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);color:#fff;text-decoration:none;font-weight:650;box-shadow:0 8px 22px -12px rgba(37,99,235,.8)}
  .hint{margin-top:20px;font-size:12.5px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
</style></head><body>
  <div class="card">
    <div class="orb"></div>
    <div class="eyebrow">Array Operator</div>
    <h1>Private preview</h1>
    <p>This is the Array Operator <b>preprod</b> environment — where new changes are tested before they reach the live product. Access is limited to approved networks.</p>
    <a class="cta" href="mailto:${requestEmail}?subject=Array%20Operator%20preview%20access">Request access →</a>
    <div class="hint">The live product is at <a href="https://arrayoperator.com" style="color:var(--blue)">arrayoperator.com</a>.</div>
  </div>
</body></html>`;
}

export default async (request, context) => {
  const allow = getEnv("PREPROD_ALLOW_IPS").split(",").map((s) => s.trim()).filter(Boolean);
  const requestEmail = getEnv("PREPROD_REQUEST_EMAIL") || "ford.genereaux@gmail.com";

  const ip = (context && context.ip) || request.headers.get("x-nf-client-connection-ip") || "";

  // Allowlisted IP -> pass silently. Everyone else -> branded page (no prompt).
  if (allow.length && ip && allow.indexOf(ip) !== -1) return;

  return new Response(gatePage(requestEmail), {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
};
