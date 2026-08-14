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
  // Each sub owns a PERSISTENT pane. A late async write from a sub you've
  // switched away from lands in ITS OWN hidden pane instead of painting over the
  // active view — that race is what swapped RECs back to Credit Exchange while
  // the pill still read RECs (Ford 2026-07-19). Panes also make re-switching
  // instant: the DOM is already built, we just toggle visibility.
  function paneFor(subId){
    const c = document.getElementById("mkSubContent");
    if(!c) return null;
    let p = c.querySelector('[data-mkpane="'+subId+'"]');
    if(!p){
      p = document.createElement("div");
      p.className = "mk-pane";
      p.setAttribute("data-mkpane", subId);
      c.appendChild(p);
    }
    return p;
  }
  function mountActive(){
    const list = window.__aoMarketplace.list();
    const sub = list.find(s=>s.id===_activeSub) || list[0];
    const c = document.getElementById("mkSubContent");
    if(!sub || !c) return;
    _mountedSub = sub.id;
    list.forEach(function(s){
      const p = paneFor(s.id);
      if(!p) return;
      const on = (s.id === sub.id);
      p.hidden = !on;
      p.setAttribute("aria-hidden", on ? "false" : "true");
    });
    const pane = paneFor(sub.id);
    if(!pane) return;
    // Mount into the sub's OWN pane. Subs guard their loading states on cached
    // data, so a re-mount refreshes in place without flashing a spinner.
    try { sub.mount(pane); }
    catch(e){
      pane.innerHTML = '<div class="mk-empty">Couldn’t load this view. '+
        '<button type="button" class="mk-submit" data-mkretry="'+esc(sub.id)+'">Retry</button></div>';
      if(window.console) console.warn("marketplace sub mount failed:", e);
    }
  }
  document.addEventListener("click", function(e){
    const t = e.target;
    if(!t || !t.closest) return;
    const b = t.closest(".mk-subnav [data-mksub]");
    if(b){
      const id = b.getAttribute("data-mksub");
      if(id === _activeSub) return;
      _activeSub = id;
      try { localStorage.setItem("ao_mk_subtab", id); } catch(_){}
      // Repaint the pills IMMEDIATELY so the bar never lags the content, then
      // swap panes (already-rendered panes appear instantly).
      renderSubtabs(true);
      return;
    }
    const rb = t.closest("[data-mkretry]");
    if(rb){
      const rid = rb.getAttribute("data-mkretry");
      const sub = window.__aoMarketplace.list().find(s=>s.id===rid);
      const pane = paneFor(rid);
      if(sub && pane){
        pane.innerHTML = '<div class="mk-empty">Loading…</div>';
        try { sub.mount(pane); } catch(_){}
      }
    }
  });

  // ── Credit Exchange sub ─────────────────────────────────────────────────────
  let _vac = null, _leads = null, _sugg = null;

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

  function statusSelect(l){
    const cur = (l.status || "new").toLowerCase();
    const opts = ["new","suggested","drafted","utility_pending","live","dead"];
    return '<select class="mk-status-sel" data-mk-status="'+esc(l.id)+'" aria-label="Lead status">'+
      opts.map(function(s){
        return '<option value="'+s+'"'+(s===cur?" selected":"")+'>'+s.replace(/_/g," ")+'</option>';
      }).join("")+
    '</select>';
  }

  function leadRow(l){
    const who = l.contact_name || l.contact_email || "(unnamed)";
    const bits = [l.utility ? String(l.utility).toUpperCase() : null, l.desired_band,
      l.desired_kwh_mo ? ("~"+Math.round(l.desired_kwh_mo)+" kWh/mo parsed") : null,
      l.monthly_bill_usd ? money0(l.monthly_bill_usd)+"/mo" : null]
      .filter(Boolean).join(" · ");
    const drafted = l.linked_subscription_id
      ? '<a class="mk-lead-link" href="#reports">Offtaker #'+esc(l.linked_subscription_id)+' →</a>'
      : '<button type="button" class="mk-lead-draft" data-mk-draft="'+esc(l.id)+'"'
        +(l.suggested_array_id ? ' data-mk-array="'+esc(l.suggested_array_id)+'"' : '')+
        '>Draft offtaker →</button>';
    return '<div class="mk-lead" data-lead-id="'+esc(l.id)+'">'+
      '<div class="mk-lead-main"><span class="mk-lead-who">'+esc(who)+'</span>'+
      (bits?'<span class="mk-lead-meta">'+esc(bits)+'</span>':"")+'</div>'+
      '<div class="mk-lead-actions">'+statusSelect(l)+drafted+'</div></div>';
  }

  function suggCard(s){
    const who = s.lead_name || s.lead_email || ("Lead #"+s.lead_id);
    const alloc = s.suggested_allocation_pct != null
      ? (Math.round(s.suggested_allocation_pct*1000)/10).toFixed(1)+"%"
      : "—";
    const reasons = (s.reasons || []).slice(0, 3).map(function(r){
      return '<li>'+esc(r)+'</li>';
    }).join("");
    return '<div class="mk-sugg">'+
      '<div class="mk-sugg-head"><b>'+esc(who)+'</b> → <b>'+esc(s.array_name || ("Array "+s.array_id))+'</b>'+
        (s.provider ? '<span class="mk-vac-prov">'+esc(String(s.provider).toUpperCase())+'</span>' : '')+
      '</div>'+
      '<div class="mk-sugg-meta">Suggested share <b>'+esc(alloc)+'</b> · vacancy ~'+money0(s.vacancy_usd)+'/yr'+
        (s.expiring_soon_kwh ? ' · <span class="mk-expiry-inline">expiry risk</span>' : '')+
      '</div>'+
      (reasons ? '<ul class="mk-sugg-why">'+reasons+'</ul>' : '')+
      '<button type="button" class="mk-submit mk-sugg-go" data-mk-draft="'+esc(s.lead_id)+'" data-mk-array="'+esc(s.array_id)+'"'
        +(s.suggested_allocation_pct!=null?' data-mk-alloc="'+esc(s.suggested_allocation_pct)+'"':'')+
        '>Draft this offtaker →</button>'+
    '</div>';
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
    const suggs = (_sugg && _sugg.suggestions) || [];

    const vacBlock = arrays.length
      ? '<div class="mk-vac-grid">'+arrays.map(vacancyCard).join("")+'</div>'
      : '<div class="mk-empty">No arrays with measurable vacancy yet. Connect a host utility login so we can read each bill’s retained excess.</div>';

    const suggBlock = suggs.length
      ? '<div class="mk-sugg-grid">'+suggs.slice(0, 8).map(suggCard).join("")+'</div>'
      : '<div class="mk-empty mk-empty-sm">No pairings yet — add waitlist leads in the same utility as your vacant arrays.</div>';

    container.innerHTML =
      '<div class="mk-wrap">'+
        '<section class="mk-sec mk-sec-vac">'+
          '<div class="mk-sec-head"><h3>Your unallocated credits</h3></div>'+
          totalsHero(totals)+
          vacBlock+
        '</section>'+

        '<section class="mk-sec mk-sec-sugg">'+
          '<div class="mk-sec-head"><h3>Suggested pairings</h3>'+
            '<span class="mk-sec-sub">Same utility · size fit · expiry first. You confirm every draft.</span></div>'+
          suggBlock+
        '</section>'+

        '<section class="mk-sec mk-sec-demand">'+
          '<div class="mk-sec-head"><h3>Waitlist</h3><span class="mk-sec-sub">People who want bill credits in your territory. Draft → Statements pipeline.</span></div>'+
          intakeForm()+
          (leads.length
            ? '<div class="mk-leads">'+leads.map(leadRow).join("")+'</div>'
            : '<div class="mk-empty mk-empty-sm">No one on the waitlist yet.</div>')+
        '</section>'+

        '<section class="mk-sec mk-sec-board">'+
          '<div class="mk-board">'+
            '<div class="mk-board-ic" aria-hidden="true">⚙</div>'+
            '<div class="mk-board-copy"><b>Host confirms. Utility files.</b> Suggestions never auto-enroll. Drafting creates an offtaker in Statements — you still submit the GNM membership change to the utility.</div>'+
          '</div>'+
        '</section>'+
      '</div>';

    wireCredit(container);
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

  function wireCredit(container){
    const form = container.querySelector("#mkIntake");
    if(form && !form._wired){
      form._wired = true;
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
        }).then(function(r){ return r.json().catch(function(){ return {}; }); }).then(function(){
          _leads = null; _sugg = null;
          loadData(document.getElementById("mkSubContent"), { keepVac: true });
        }).catch(function(){
          if(btn){ btn.disabled = false; btn.textContent = "Add to waitlist"; }
          if(hint){ hint.textContent = "Couldn’t save that — try again."; }
        });
      });
    }

    if(container._mkClickWired) return;
    container._mkClickWired = true;
    container.addEventListener("click", function(e){
      const findBtn = e.target && e.target.closest ? e.target.closest("[data-mk-find]") : null;
      if(findBtn){
        const u = findBtn.getAttribute("data-mk-find");
        const sel = container.querySelector("#mkUtil");
        if(sel && (u === "gmp" || u === "vec")) sel.value = u;
        const nm = container.querySelector("#mkName");
        if(nm) nm.focus();
        const f = container.querySelector("#mkIntake");
        if(f) f.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const draftBtn = e.target && e.target.closest ? e.target.closest("[data-mk-draft]") : null;
      if(draftBtn){
        e.preventDefault();
        runDraft(draftBtn, container);
      }
    });
    container.addEventListener("change", function(e){
      const sel = e.target && e.target.closest ? e.target.closest("[data-mk-status]") : null;
      if(!sel) return;
      const hdrs = authHeaders();
      if(!hdrs) return;
      const id = sel.getAttribute("data-mk-status");
      fetch(API + "/exchange/demand/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, hdrs),
        body: JSON.stringify({ status: sel.value })
      }).then(function(r){
        if(!r.ok) throw new Error("status");
        _leads = null; _sugg = null;
        return loadData(document.getElementById("mkSubContent"), { keepVac: true });
      }).catch(function(){ /* leave UI; next refresh fixes */ });
    });
  }

  function runDraft(btn, container){
    const hdrs = authHeaders();
    if(!hdrs){ alert("Sign in to draft an offtaker."); return; }
    const leadId = btn.getAttribute("data-mk-draft");
    const arrayId = btn.getAttribute("data-mk-array");
    const allocRaw = btn.getAttribute("data-mk-alloc");
    const body = {};
    if(arrayId) body.array_id = parseInt(arrayId, 10);
    if(allocRaw != null && allocRaw !== "") body.allocation_pct = parseFloat(allocRaw);
    if(!body.array_id){
      // No array pinned — pick top vacancy if any
      const arrays = (_vac && _vac.arrays) || [];
      const top = arrays.find(function(a){ return (a.vacancy_frac || 0) > 0.02; }) || arrays[0];
      if(!top){ alert("No array with vacancy to attach. Connect a host bill first."); return; }
      body.array_id = top.array_id;
    }
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Drafting…";
    fetch(API + "/exchange/demand/" + encodeURIComponent(leadId) + "/draft-offtaker", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, hdrs),
      body: JSON.stringify(body)
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j, status: r.status }; }); })
    .then(function(res){
      if(!res.ok){
        const msg = (res.j && (res.j.detail || res.j.message)) || ("HTTP "+res.status);
        alert(typeof msg === "string" ? msg : JSON.stringify(msg));
        btn.disabled = false; btn.textContent = prev;
        return;
      }
      _leads = null; _sugg = null;
      // Land in Statements so the operator finishes share / utility paper.
      try { location.hash = "#reports"; } catch(_){}
      loadData(document.getElementById("mkSubContent"), { keepVac: true });
    }).catch(function(err){
      alert("Draft failed: " + (err && err.message ? err.message : "network"));
      btn.disabled = false; btn.textContent = prev;
    });
  }

  function loadData(container, opts){
    opts = opts || {};
    const hdrs = authHeaders();
    if(!hdrs){ renderSignedOut(container); return; }
    if(!_vac && !opts.keepVac){
      container.innerHTML = '<div class="mk-wrap"><div class="mk-empty">Measuring your fleet’s unallocated credits…</div></div>';
    }
    const needVac = !opts.keepVac || !_vac;
    const pVac = needVac
      ? fetch(API + "/vacancy", { headers: hdrs }).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){ if(j) _vac = j; }).catch(function(){})
      : Promise.resolve();
    const pLeads = fetch(API + "/exchange/demand", { headers: hdrs }).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){ _leads = j || { leads:[] }; }).catch(function(){ _leads = { leads:[] }; });
    const pSugg = fetch(API + "/exchange/suggestions", { headers: hdrs }).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){ _sugg = j || { suggestions:[] }; }).catch(function(){ _sugg = { suggestions:[] }; });
    return Promise.all([pVac, pLeads, pSugg]).then(function(){ renderCredit(container); });
  }

  function mountCreditExchange(container){
    loadData(container, {});
  }

  window.__aoMarketplace.register({ id: "credit-exchange", label: "Credit Exchange", order: 10, mount: mountCreditExchange });
  window.__aoMarketplace.onChange(function(){ renderSubtabs(false); });

  // Public entry — applyView calls this when the Marketplace tab activates.
  window.__aoLoadMarketplace = function(){ ensureShell(); renderSubtabs(true); };
})();
