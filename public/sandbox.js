/* ============================================================================
 * Array Operator — Sandbox view (sandbox.js)
 *
 * Renders the three-tier fleet structure that mirrors the backend data model:
 *
 *     Alerts   (top row)    — one per array, rolled-up worst inverter state
 *       │
 *     Arrays   (middle row) — one column per array
 *       │
 *     Inverters(bottom row) — the "comb": N real inverter prongs per array
 *
 * Top controls bottom: each Alert sits above its Array, each Array fans out to
 * its inverters. Data: GET /v1/array-owners/fleet-tree (live SolarEdge per-
 * inverter telemetry, peer-analyzed within each site). The organization of this
 * canvas IS the schema: Tenant → Array → Inverter, with alerts riding on top.
 * ==========================================================================*/
(function(){
  const SESSION_KEY = "so_session";
  const STATUS_LABEL = {
    ok: "Pulling its weight", underperforming: "Below its neighbors",
    comm_gap: "Gone quiet", dead: "Not coming home", fault: "Fault"
  };
  const STATUS_CLASS = {
    ok: "ok", underperforming: "warn", comm_gap: "warn", dead: "bad", fault: "bad"
  };
  const ALERT_CLASS = { ok: "ok", warn: "warn", critical: "bad" };

  function el(html){ const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

  // peer-index bar (0..~1.2 clamped) — green at/above 1, amber/ red below
  function peerBar(pi){
    if(pi==null) return `<div class="sb-pi none">solo · no peers</div>`;
    const pct = Math.max(4, Math.min(100, Math.round(pi*100)));
    const cls = pi>=0.85 ? "ok" : pi>=0.6 ? "warn" : "bad";
    return `<div class="sb-pi"><div class="sb-pi-bar ${cls}" style="width:${pct}%"></div><span>${pi.toFixed(2)}</span></div>`;
  }

  function render(tree){
    const host = document.getElementById("sandbox");
    if(!host) return;
    const cols = tree.columns || [];
    if(!cols.length){
      host.innerHTML = `<div class="sb-empty">No arrays connected yet — connect an inverter to populate your fleet tree.</div>`;
      return;
    }

    const summary = tree.summary || {};
    const head = `
      <div class="sb-head">
        <div>
          <div class="sb-tiers">
            <span class="sb-tier-tag a">Alerts</span>
            <span class="sb-arrow">→ control →</span>
            <span class="sb-tier-tag b">Arrays</span>
            <span class="sb-arrow">→ control →</span>
            <span class="sb-tier-tag c">Inverters</span>
          </div>
          <div class="sb-sub">${summary.arrays_total||0} arrays · ${summary.inverters_total||0} inverters · ${summary.attention||0} need a look — this layout is your live system, top controls bottom</div>
        </div>
        <div class="sb-legend">
          <span><i class="sw ok"></i>healthy</span>
          <span><i class="sw warn"></i>watch</span>
          <span><i class="sw bad"></i>critical</span>
        </div>
      </div>`;

    const columns = cols.map(col => {
      const a = col.alert || {level:"ok"};
      const aCls = ALERT_CLASS[a.level] || "ok";
      const invs = col.inverters || [];
      const srcTag = col.inverter_source === "solaredge"
        ? `<span class="sb-srctag live">live · per-inverter</span>`
        : col.inverter_source === "array"
          ? `<span class="sb-srctag">array-level</span>`
          : `<span class="sb-srctag off">no data</span>`;

      // bottom comb — one prong per inverter
      const teeth = invs.map(inv => {
        const sCls = STATUS_CLASS[inv.status] || "ok";
        const np = inv.nameplate_kw!=null ? `${inv.nameplate_kw} kW` : "";
        const power = inv.current_power_w!=null ? `${(inv.current_power_w/1000).toFixed(2)} kW now` : "";
        return `
          <div class="sb-inv ${sCls}" tabindex="0"
               data-name="${esc(inv.name)}" data-status="${esc(inv.status)}"
               data-diag="${esc(inv.diagnosis||"")}" data-model="${esc(inv.model||"")}"
               data-np="${esc(np)}" data-win="${esc(inv.window_kwh!=null?inv.window_kwh+' kWh / 14d':'')}"
               data-mode="${esc(inv.last_mode||"")}" data-power="${esc(power)}">
            <div class="sb-inv-dot"></div>
            <div class="sb-inv-name">${esc(inv.name)}</div>
            <div class="sb-inv-meta">${esc(np)}</div>
            ${peerBar(inv.peer_index)}
            <div class="sb-inv-status ${sCls}">${esc(STATUS_LABEL[inv.status]||inv.status||"")}</div>
          </div>`;
      }).join("");

      return `
        <div class="sb-col">
          <!-- TIER 1: Alert -->
          <div class="sb-alert ${aCls}">
            <div class="sb-alert-k">Alerts</div>
            <div class="sb-alert-h">${esc(a.headline||"All clear")}</div>
            <div class="sb-alert-c">${a.count? a.count+' inverter'+(a.count>1?'s':'')+' flagged' : 'nothing to do'}</div>
          </div>
          <div class="sb-link v1 ${aCls}"></div>

          <!-- TIER 2: Array -->
          <div class="sb-array">
            <div class="sb-array-k">Array</div>
            <div class="sb-array-name">${esc(col.array_name)}</div>
            <div class="sb-array-meta">${col.inverter_count} inverter${col.inverter_count===1?'':'s'} ${srcTag}</div>
          </div>
          <div class="sb-link v2"></div>

          <!-- TIER 3: Inverters comb -->
          <div class="sb-comb">
            <div class="sb-bus"></div>
            <div class="sb-teeth">${teeth}</div>
          </div>
        </div>`;
    }).join("");

    host.innerHTML = head + `<div class="sb-canvas">${columns}</div>
      <div class="sb-foot" id="sbFoot">Tip: click any inverter for its diagnosis. The three rows are the three layers of our backend — Alert → Array → Inverter.</div>`;

    // click/keyboard → detail line
    host.querySelectorAll(".sb-inv").forEach(node => {
      const show = () => {
        const d = node.dataset;
        const bits = [
          d.model && `model ${d.model}`, d.np, d.power,
          d.win, d.mode && `mode ${d.mode}`,
          d.diag
        ].filter(Boolean).join(" · ");
        const foot = document.getElementById("sbFoot");
        if(foot) foot.innerHTML = `<b>${esc(d.name)}</b> — <span class="sb-foot-status ${STATUS_CLASS[d.status]||'ok'}">${esc(STATUS_LABEL[d.status]||d.status)}</span> · ${esc(bits)}`;
        host.querySelectorAll(".sb-inv.sel").forEach(n=>n.classList.remove("sel"));
        node.classList.add("sel");
      };
      node.addEventListener("click", show);
      node.addEventListener("keydown", e => { if(e.key==="Enter"||e.key===" ") { e.preventDefault(); show(); } });
    });
  }

  function load(){
    const host = document.getElementById("sandbox");
    if(!host) return;
    let session = null;
    try { session = localStorage.getItem(SESSION_KEY); } catch(e){}
    host.innerHTML = `<div class="sb-empty">Loading your fleet tree…</div>`;

    if(!session){
      // Anonymous — show the demo tree so the structure still reads.
      fetch("fleet-tree-demo.json").then(r=>{if(!r.ok)throw 0;return r.json()}).then(render)
        .catch(()=>{ host.innerHTML = `<div class="sb-empty">Sign in to see your live fleet tree. <a href="onboarding.html" style="color:var(--good)">Get started →</a></div>`; });
      return;
    }
    fetch("/v1/array-owners/fleet-tree", { headers: { Authorization: "Bearer " + session } })
      .then(r => { if(!r.ok) throw new Error("fleet-tree " + r.status); return r.json(); })
      .then(render)
      .catch(() => {
        fetch("fleet-tree-demo.json").then(r=>{if(!r.ok)throw 0;return r.json()}).then(render)
          .catch(()=>{ host.innerHTML = `<div class="sb-empty">Couldn't load your fleet tree — please refresh.</div>`; });
      });
  }

  // Toggle between dashboard and sandbox (hash-driven so it's linkable).
  function applyView(){
    const sandboxOn = location.hash === "#sandbox";
    document.body.classList.toggle("view-sandbox", sandboxOn);
    const tBtn = document.getElementById("sbToggle");
    if(tBtn) tBtn.textContent = sandboxOn ? "← Dashboard" : "Sandbox view";
    if(sandboxOn) load();
  }
  window.addEventListener("hashchange", applyView);
  document.addEventListener("DOMContentLoaded", applyView);
  // expose for the inline toggle button
  window.__sbLoad = load;
})();
