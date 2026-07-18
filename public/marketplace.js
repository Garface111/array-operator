/* ==========================================================================
 * Marketplace tab — the Offtaker Exchange (v0).
 *
 * Group-net-metering arrays bank excess credit no offtaker absorbs; it expires
 * unused. This tab makes that vacancy visible and gives the operator a place to
 * collect demand (a waitlist Ford brokers by hand at first). v0 is single-player
 * valuable — no live cross-tenant marketplace, no money.
 *
 * SUB-TAB REGISTRY (coordination contract): a second agent concurrently builds an
 * "Array Market" sub-tab into this same panel. To avoid collisions the panel's
 * sub-tabs render from a shared idempotent registry. The stub below is IDENTICAL
 * in both files — first to load wins, second no-ops. Each sub is
 * {id,label,order,mount(container)}. This file owns the SHELL (renders whatever
 * subs are present) and registers its own {id:'credit-exchange', order:10}. It
 * does NOT build the Array Market sub — the other agent registers that (order 20).
 * ==========================================================================*/
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

  const API = "/v1/array-operator/billing";
  function session(){ try { return localStorage.getItem("so_session"); } catch(_){ return null; } }
  function authHeaders(){ const s = session(); return s ? { Authorization: "Bearer " + s } : null; }
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
  function money0(n){ const v = Number(n)||0; return "$" + Math.round(v).toLocaleString(); }
  function kwh0(n){ return (Math.round(Number(n)||0)).toLocaleString() + " kWh"; }
  function pct1(f){ return (Math.round((Number(f)||0)*1000)/10).toFixed(1) + "%"; }

  // ── shell + sub-tab bar (renders whatever the registry holds) ───────────────
  let _activeSub = null, _mountedSub = null;
  function root(){ return document.getElementById("marketplaceRoot"); }
  function ensureShell(){
    const r = root(); if(!r) return null;
    if(!r._mkBuilt){
      r.innerHTML =
        '<div class="mk-subnav-wrap ao-subnav" hidden>' +
          '<div class="vs-seg mk-subnav" role="group" aria-label="Marketplace view"></div>' +
        '</div>' +
        '<div class="mk-subcontent" id="mkSubContent"></div>';
      r._mkBuilt = true;
    }
    return r;
  }
  function renderSubtabs(force){
    const r = ensureShell(); if(!r) return;
    const list = window.__aoMarketplace.list();
    if(!list.length) return;
    if(!_activeSub || !list.some(s=>s.id===_activeSub)){
      let saved=null; try{ saved=localStorage.getItem("ao_mk_subtab"); }catch(_){}
      _activeSub = (saved && list.some(s=>s.id===saved)) ? saved : list[0].id;
    }
    const wrap = r.querySelector(".mk-subnav-wrap");
    const nav = r.querySelector(".mk-subnav");
    // Don't show a redundant single-tab bar — only reveal it once a second sub
    // (Array Market) registers.
    if(list.length <= 1){ wrap.hidden = true; }
    else {
      wrap.hidden = false;
      nav.innerHTML = list.map(s =>
        '<button class="vs-seg-btn mk-seg-btn'+(s.id===_activeSub?" on":"")+'" type="button" '+
        'data-mksub="'+esc(s.id)+'" aria-pressed="'+(s.id===_activeSub?"true":"false")+'">'+esc(s.label)+'</button>'
      ).join("");
    }
    if(force || _mountedSub !== _activeSub) mountActive();
  }
  function mountActive(){
    const list = window.__aoMarketplace.list();
    const sub = list.find(s=>s.id===_activeSub) || list[0];
    const c = document.getElementById("mkSubContent");
    if(!sub || !c) return;
    _mountedSub = sub.id;
    try { sub.mount(c); }
    catch(e){ c.innerHTML = '<div class="mk-empty">Something went wrong loading this view.</div>'; if(window.console) console.warn("marketplace sub mount failed:", e); }
  }
  document.addEventListener("click", function(e){
    const b = e.target && e.target.closest ? e.target.closest(".mk-subnav [data-mksub]") : null;
    if(!b) return;
    const id = b.getAttribute("data-mksub");
    if(id === _activeSub) return;
    _activeSub = id;
    try { localStorage.setItem("ao_mk_subtab", id); } catch(_){}
    renderSubtabs(true);
  });

  // ── Credit Exchange sub ─────────────────────────────────────────────────────
  let _vac = null, _leads = null;

  function confChip(v){
    const c = v.confidence;
    if(c === "high") return '<span class="mk-conf mk-conf-high">Measured</span>';
    if(c === "medium") return '<span class="mk-conf mk-conf-med">Estimate</span>';
    return '<span class="mk-conf mk-conf-none">Connect login</span>';
  }

  function vacancyCard(v){
    const frac = v.vacancy_frac;
    const hasNum = frac != null;
    const pctTxt = hasNum ? pct1(frac) : "—";
    const usd = v.vacancy_usd || 0;
    const kwh = v.vacancy_kwh || 0;
    const provider = (v.provider || "").toUpperCase();
    const expiring = (v.expiring_soon_kwh || 0) > 0;
    const expLine = expiring
      ? '<div class="mk-expiry" role="note">'+
          '<span class="mk-expiry-dot" aria-hidden="true"></span>'+
          '≈ '+kwh0(v.expiring_soon_kwh)+' ('+money0(v.expiring_soon_usd)+') approaching expiry'+
        '</div>'
      : "";
    const rate = v.credit_rate != null ? ' · '+('$'+Number(v.credit_rate).toFixed(3))+'/kWh' : "";
    // Only surface a "find a taker" action when there's real vacancy to place.
    const action = (hasNum && frac > 0.02)
      ? '<button type="button" class="mk-find" data-mk-find="'+esc(provider.toLowerCase())+'">Find a taker →</button>'
      : "";
    return (
      '<div class="mk-vac-card'+(expiring?" mk-vac-card--exp":"")+'">'+
        '<div class="mk-vac-head">'+
          '<div class="mk-vac-name">'+esc(v.array_name || "Array "+v.array_id)+
            (provider?'<span class="mk-vac-prov">'+esc(provider)+'</span>':"")+'</div>'+
          confChip(v)+
        '</div>'+
        '<div class="mk-vac-num"><span class="mk-vac-pct">'+pctTxt+'</span><span class="mk-vac-lbl">unallocated</span></div>'+
        '<div class="mk-vac-sub">'+(hasNum?('~'+money0(usd)+'/yr · '+kwh0(kwh)+'/yr'+rate):esc(v.confidence_note||""))+'</div>'+
        expLine+
        (hasNum ? '<div class="mk-vac-note">'+esc(v.confidence_note||"")+'</div>' : "")+
        action+
      '</div>'
    );
  }

  function totalsHero(t){
    const usd = t.vacancy_usd || 0;
    const kwh = t.vacancy_kwh || 0;
    const exp = t.expiring_soon_usd || 0;
    const expBadge = exp > 0
      ? '<div class="mk-hero-exp"><span class="mk-expiry-dot" aria-hidden="true"></span>'+money0(exp)+' approaching expiry</div>'
      : "";
    return (
      '<div class="mk-hero">'+
        '<div class="mk-hero-main">'+
          '<div class="mk-hero-num">'+money0(usd)+'</div>'+
          '<div class="mk-hero-lbl">unallocated credit value, trailing 12 months · '+kwh0(kwh)+'</div>'+
        '</div>'+
        expBadge+
      '</div>'
    );
  }

  function leadRow(l){
    const who = l.contact_name || l.contact_email || "(unnamed)";
    const bits = [l.utility ? String(l.utility).toUpperCase() : null, l.desired_band, l.monthly_bill_usd ? money0(l.monthly_bill_usd)+"/mo" : null]
      .filter(Boolean).join(" · ");
    return '<div class="mk-lead"><span class="mk-lead-who">'+esc(who)+'</span>'+
      (bits?'<span class="mk-lead-meta">'+esc(bits)+'</span>':"")+
      '<span class="mk-lead-status">'+esc(l.status||"new")+'</span></div>';
  }

  function intakeForm(){
    return (
      '<form class="mk-intake" id="mkIntake" autocomplete="off">'+
        '<div class="mk-intake-grid">'+
          '<input class="mk-in" id="mkName" type="text" placeholder="Name">'+
          '<input class="mk-in" id="mkEmail" type="email" placeholder="Email">'+
          '<input class="mk-in" id="mkPhone" type="tel" placeholder="Phone (optional)">'+
          '<select class="mk-in" id="mkUtil"><option value="">Utility…</option><option value="gmp">GMP</option><option value="vec">VEC</option><option value="other">Other</option></select>'+
          '<input class="mk-in" id="mkBand" type="text" placeholder="Wants ~ kWh/mo">'+
          '<input class="mk-in" id="mkBill" type="number" min="0" step="1" placeholder="Their bill $/mo">'+
        '</div>'+
        '<textarea class="mk-in mk-in-notes" id="mkNotes" rows="2" placeholder="Notes (how they reached out, timing…)"></textarea>'+
        '<div class="mk-intake-foot"><span class="mk-intake-hint" id="mkIntakeHint">Stored on your waitlist. Nothing is sent.</span>'+
          '<button type="submit" class="mk-submit">Add to waitlist</button></div>'+
      '</form>'
    );
  }

  function renderCredit(container){
    const totals = (_vac && _vac.totals) || { vacancy_usd:0, vacancy_kwh:0, expiring_soon_usd:0 };
    const arrays = (_vac && _vac.arrays) || [];
    const leads = (_leads && _leads.leads) || [];

    const vacBlock = arrays.length
      ? '<div class="mk-vac-grid">'+arrays.map(vacancyCard).join("")+'</div>'
      : '<div class="mk-empty">No arrays with measurable vacancy yet. Connect a host utility login so we can read each bill’s retained excess.</div>';

    container.innerHTML =
      '<div class="mk-wrap">'+
        '<section class="mk-sec mk-sec-vac">'+
          '<div class="mk-sec-head"><h3>Your unallocated credits</h3></div>'+
          totalsHero(totals)+
          vacBlock+
        '</section>'+

        '<section class="mk-sec mk-sec-demand">'+
          '<div class="mk-sec-head"><h3>Waitlist</h3><span class="mk-sec-sub">People who want bill credits in your territory.</span></div>'+
          intakeForm()+
          (leads.length
            ? '<div class="mk-leads">'+leads.map(leadRow).join("")+'</div>'
            : '<div class="mk-empty mk-empty-sm">No one on the waitlist yet.</div>')+
        '</section>'+

        '<section class="mk-sec mk-sec-board">'+
          '<div class="mk-board">'+
            '<div class="mk-board-ic" aria-hidden="true">⚙</div>'+
            '<div class="mk-board-copy"><b>Matches are brokered by hand.</b> Add takers to your waitlist and we pair them with your vacancy inside the same utility territory. Automatic matching comes next.</div>'+
          '</div>'+
        '</section>'+
      '</div>';

    wireIntake(container);
  }

  function renderSignedOut(container){
    container.innerHTML =
      '<div class="mk-wrap"><div class="mk-empty mk-empty-signedout">'+
        '<b>See what your arrays are leaving on the table.</b>'+
        '<span>Group-net-metering arrays bank excess credit no offtaker absorbs — it expires unused. '+
        'Sign in to measure each array’s unallocated credit value and collect takers.</span>'+
        '<a class="mk-submit" href="/login">Sign in →</a>'+
      '</div></div>';
  }

  function wireIntake(container){
    const form = container.querySelector("#mkIntake");
    if(!form || form._wired) return;
    form._wired = true;
    // A per-array "Find a taker" jumps to the form + preselects the utility.
    container.addEventListener("click", function(e){
      const b = e.target && e.target.closest ? e.target.closest("[data-mk-find]") : null;
      if(!b) return;
      const u = b.getAttribute("data-mk-find");
      const sel = container.querySelector("#mkUtil");
      if(sel && (u === "gmp" || u === "vec")) sel.value = u;
      const nm = container.querySelector("#mkName");
      if(nm) nm.focus();
      form.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    form.addEventListener("submit", function(e){
      e.preventDefault();
      const hdrs = authHeaders();
      const hint = container.querySelector("#mkIntakeHint");
      if(!hdrs){ if(hint){ hint.textContent = "Sign in to save a lead."; } return; }
      const body = {
        contact_name: (container.querySelector("#mkName")||{}).value || "",
        contact_email: (container.querySelector("#mkEmail")||{}).value || "",
        contact_phone: (container.querySelector("#mkPhone")||{}).value || "",
        utility: (container.querySelector("#mkUtil")||{}).value || "",
        desired_band: (container.querySelector("#mkBand")||{}).value || "",
        monthly_bill_usd: parseFloat((container.querySelector("#mkBill")||{}).value) || null,
        notes: (container.querySelector("#mkNotes")||{}).value || ""
      };
      if(!body.contact_name.trim() && !body.contact_email.trim()){
        if(hint){ hint.textContent = "Add at least a name or an email."; }
        return;
      }
      const btn = form.querySelector(".mk-submit");
      if(btn){ btn.disabled = true; btn.textContent = "Adding…"; }
      fetch(API + "/exchange/demand", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, hdrs),
        body: JSON.stringify(body)
      }).then(r => r.json().catch(()=>({}))).then(() => {
        _leads = null;                       // force refetch
        loadData(document.getElementById("mkSubContent"), { keepVac: true });
      }).catch(() => {
        if(btn){ btn.disabled = false; btn.textContent = "Add to waitlist"; }
        if(hint){ hint.textContent = "Couldn’t save that — try again."; }
      });
    });
  }

  function loadData(container, opts){
    opts = opts || {};
    const hdrs = authHeaders();
    if(!hdrs){ renderSignedOut(container); return; }
    // Paint a light loading state only on a cold load (keep content on refresh).
    if(!_vac && !opts.keepVac){
      container.innerHTML = '<div class="mk-wrap"><div class="mk-empty">Measuring your fleet’s unallocated credits…</div></div>';
    }
    const needVac = !opts.keepVac || !_vac;
    const pVac = needVac
      ? fetch(API + "/vacancy", { headers: hdrs }).then(r => r.ok ? r.json() : null).then(j => { if(j) _vac = j; }).catch(()=>{})
      : Promise.resolve();
    const pLeads = fetch(API + "/exchange/demand", { headers: hdrs }).then(r => r.ok ? r.json() : null).then(j => { _leads = j || { leads:[] }; }).catch(()=>{ _leads = { leads:[] }; });
    Promise.all([pVac, pLeads]).then(() => renderCredit(container));
  }

  function mountCreditExchange(container){
    loadData(container, {});
  }

  window.__aoMarketplace.register({ id: "credit-exchange", label: "Credit Exchange", order: 10, mount: mountCreditExchange });
  window.__aoMarketplace.onChange(function(){ renderSubtabs(false); });

  // Public entry — applyView calls this when the Marketplace tab activates.
  window.__aoLoadMarketplace = function(){ ensureShell(); renderSubtabs(true); };
})();
