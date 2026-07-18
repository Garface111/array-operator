/* rec-desk.js — Marketplace "RECs" sub-tab (Certificate Desk v0).
 *
 * Ownership + readiness + expected inventory from generation.
 * No brokerage, no GIS transfer, no money. Registers into window.__aoMarketplace
 * (order 30) alongside Credit Exchange (10) and Array Market (20).
 */
window.__aoMarketplace = window.__aoMarketplace || (function () {
  const subs = []; let onChange = null;
  return {
    register(sub){ if (subs.some(s=>s.id===sub.id)) return; subs.push(sub); subs.sort((a,b)=>(a.order||0)-(b.order||0)); if(onChange) onChange(); },
    list(){ return subs.slice(); },
    onChange(fn){ onChange = fn; if (subs.length) fn(); }
  };
})();

(function () {
  "use strict";

  const API = "/v1/array-owners";
  function session(){ try { return localStorage.getItem("so_session"); } catch(_){ return null; } }
  function authHeaders(){ const s = session(); return s ? { Authorization: "Bearer " + s } : null; }
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }

  let _desk = null;

  const OWN_OPTS = [
    { v: "unknown", l: "Unknown" },
    { v: "owner_retained", l: "I retain RECs" },
    { v: "assigned_to_utility", l: "Assigned to utility / program" },
    { v: "counterparty", l: "PPA / counterparty holds" },
    { v: "split", l: "Split / complex" }
  ];

  function pathChip(path){
    const map = {
      sell_ready: ["mk-rec-chip mk-rec-chip-go", "Sell path ready"],
      sell_blocked: ["mk-rec-chip mk-rec-chip-warn", "Owner-retained — finish readiness"],
      unknown: ["mk-rec-chip mk-rec-chip-muted", "Ownership unknown"],
      utility_assigned: ["mk-rec-chip mk-rec-chip-info", "Utility / program"],
      counterparty: ["mk-rec-chip mk-rec-chip-info", "Counterparty"]
    };
    const m = map[path] || map.unknown;
    return '<span class="'+m[0]+'">'+esc(m[1])+'</span>';
  }

  function totalsHero(t){
    t = t || {};
    return '<div class="mk-hero mk-rec-hero">'+
      '<div class="mk-hero-main">'+
        '<div class="mk-hero-num">'+(t.expected_recs_total||0)+'</div>'+
        '<div class="mk-hero-lbl">expected RECs from metered generation (floor MWh, mint-lag window)</div>'+
      '</div>'+
      '<div class="mk-rec-hero-side">'+
        '<div><b>'+(t.sell_ready||0)+'</b> sell-ready</div>'+
        '<div><b>'+(t.owner_retained||0)+'</b> owner-retained</div>'+
        '<div><b>'+(t.assigned_to_utility||0)+'</b> utility-assigned</div>'+
        '<div><b>'+(t.unknown_ownership||0)+'</b> unknown</div>'+
      '</div>'+
    '</div>';
  }

  function checkList(checks){
    return '<ul class="mk-rec-checks">'+(checks||[]).map(function(c){
      return '<li class="'+(c.ok?"ok":"miss")+'"><span class="mk-rec-ck">'+(c.ok?"✓":"·")+'</span> '+
        esc(c.label)+(c.detail && !c.ok ? '<span class="mk-rec-ckd"> — '+esc(c.detail)+'</span>' : '')+
      '</li>';
    }).join("")+'</ul>';
  }

  function vintageStrip(vs){
    if(!vs || !vs.length) return '';
    return '<div class="mk-rec-vint">'+(vs||[]).map(function(v){
      return '<div class="mk-rec-vq"><span class="mk-rec-vql">'+esc(v.label)+'</span>'+
        '<span class="mk-rec-vqn">'+(v.expected_recs||0)+'</span>'+
        '<span class="mk-rec-vqs">RECs · '+(v.mwh||0)+' MWh</span></div>';
    }).join("")+'</div>';
  }

  function arrayCard(a){
    const own = a.ownership || "unknown";
    const opts = OWN_OPTS.map(function(o){
      return '<option value="'+o.v+'"'+(o.v===own?" selected":"")+'>'+esc(o.l)+'</option>';
    }).join("");
    return '<div class="mk-rec-card" data-rec-array="'+esc(a.array_id)+'">'+
      '<div class="mk-rec-card-head">'+
        '<div class="mk-rec-name">'+esc(a.array_name || ("Array "+a.array_id))+'</div>'+
        pathChip(a.path)+
      '</div>'+
      '<p class="mk-rec-path">'+esc(a.path_label||"")+'</p>'+
      '<div class="mk-rec-form">'+
        '<label>Ownership<select class="mk-in mk-rec-own" data-f="ownership">'+opts+'</select></label>'+
        '<label>GIS / unit id<input class="mk-in" data-f="nepool_gis_id" value="'+esc(a.nepool_gis_id||"")+'" placeholder="NEPOOL-GIS id"></label>'+
        '<label>Independent Verifier<input class="mk-in" data-f="verifier_name" value="'+esc(a.verifier_name||"")+'" placeholder="Who files to GIS?"></label>'+
        '<label class="mk-rec-note-lab">Note<textarea class="mk-in mk-in-notes" data-f="ownership_note" rows="2" placeholder="Tariff / SMART / REG notes…">'+esc(a.ownership_note||"")+'</textarea></label>'+
        '<button type="button" class="mk-submit mk-rec-save" data-rec-save="'+esc(a.array_id)+'">Save</button>'+
        '<span class="mk-rec-save-hint" hidden></span>'+
      '</div>'+
      '<div class="mk-rec-meta">Readiness '+(a.readiness_score||0)+'/'+(a.readiness_max||0)+
        ' · expected '+(a.expected_recs_total||0)+' RECs · '+(a.fuel_type||"solar")+' · '+(a.cert_registry||"NEPOOL-GIS")+
      '</div>'+
      checkList(a.checks)+
      vintageStrip(a.expected_vintages)+
    '</div>';
  }

  function render(container){
    if(!_desk){
      container.innerHTML = '<div class="mk-wrap"><div class="mk-empty">Loading certificate desk…</div></div>';
      return;
    }
    const t = _desk.totals || {};
    const arrays = _desk.arrays || [];
    container.innerHTML =
      '<div class="mk-wrap">'+
        '<section class="mk-sec">'+
          '<div class="mk-sec-head"><h3>Certificate desk</h3>'+
            '<span class="mk-sec-sub">Who owns the RECs · what’s missing · expected inventory. Not a broker desk.</span></div>'+
          totalsHero(t)+
          '<p class="mk-rec-legal">'+esc(_desk.legal_note || "")+'</p>'+
          '<p class="mk-rec-legal mk-rec-legal-soft">'+esc(_desk.market_note || "")+'</p>'+
        '</section>'+
        '<section class="mk-sec">'+
          (arrays.length
            ? '<div class="mk-rec-grid">'+arrays.map(arrayCard).join("")+'</div>'
            : '<div class="mk-empty">No arrays yet — connect a fleet first.</div>')+
        '</section>'+
        '<section class="mk-sec mk-sec-board">'+
          '<div class="mk-board">'+
            '<div class="mk-board-ic" aria-hidden="true">◈</div>'+
            '<div class="mk-board-copy"><b>How RECs actually trade.</b> NEPOOL-GIS issues and transfers certificates; it does not price them. When ownership is owner-retained and readiness is green, use Generation reports for the mint pack, then a broker or bilateral GIS transfer. AO never holds certificates or sale proceeds.</div>'+
          '</div>'+
        '</section>'+
      '</div>';
    wire(container);
  }

  function wire(container){
    if(container._recWired) return;
    container._recWired = true;
    container.addEventListener("click", function(e){
      const btn = e.target && e.target.closest ? e.target.closest("[data-rec-save]") : null;
      if(!btn) return;
      const id = btn.getAttribute("data-rec-save");
      const card = container.querySelector('[data-rec-array="'+id+'"]');
      if(!card) return;
      const hdrs = authHeaders();
      if(!hdrs){ alert("Sign in to save."); return; }
      const body = {};
      card.querySelectorAll("[data-f]").forEach(function(el){
        const k = el.getAttribute("data-f");
        body[k] = el.value;
      });
      // map field names to API
      const payload = {
        ownership: body.ownership,
        ownership_note: body.ownership_note,
        verifier_name: body.verifier_name,
        nepool_gis_id: body.nepool_gis_id
      };
      const hint = card.querySelector(".mk-rec-save-hint");
      btn.disabled = true;
      fetch(API + "/arrays/" + encodeURIComponent(id) + "/rec-position", {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, hdrs),
        body: JSON.stringify(payload)
      }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
      .then(function(res){
        btn.disabled = false;
        if(!res.ok){
          if(hint){ hint.hidden = false; hint.textContent = (res.j && res.j.detail) || "Save failed"; }
          return;
        }
        // Patch local desk row
        if(_desk && _desk.arrays && res.j && res.j.array){
          const i = _desk.arrays.findIndex(function(a){ return String(a.array_id) === String(id); });
          if(i >= 0) _desk.arrays[i] = res.j.array;
          // refresh totals lightly
          _desk = null;
          load(container);
        }
      }).catch(function(){ btn.disabled = false; });
    });
  }

  function load(container){
    const hdrs = authHeaders();
    if(!hdrs){
      container.innerHTML = '<div class="mk-wrap"><div class="mk-empty mk-empty-signedout">'+
        '<b>Certificate desk</b><span>Sign in to see which arrays still own their RECs and what’s missing for mint/sale readiness.</span>'+
        '<a class="mk-submit" href="/login">Sign in →</a></div></div>';
      return;
    }
    if(!_desk){
      container.innerHTML = '<div class="mk-wrap"><div class="mk-empty">Loading certificate desk…</div></div>';
    }
    fetch(API + "/rec-desk", { headers: hdrs })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ _desk = j; render(container); })
      .catch(function(){
        container.innerHTML = '<div class="mk-wrap"><div class="mk-empty">Couldn’t load the certificate desk.</div></div>';
      });
  }

  window.__aoMarketplace.register({
    id: "recs",
    label: "RECs",
    order: 30,
    mount: function(container){ _desk = null; load(container); }
  });
})();
