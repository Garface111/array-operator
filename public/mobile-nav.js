/* Mobile bottom-nav enhancer (Ford 2026-07-12 mobile overhaul).
 *
 * On phones the tab bar becomes a fixed BOTTOM nav (thumb zone): 5 primary tabs +
 * a "More" sheet for the rest. This script only ADORNS the existing tabs, it
 * injects an icon + a short label into each, and builds the More sheet, so routing
 * (hash links handled by app.js) is untouched. Everything is progressive: it runs
 * once, guards every step, and if anything throws the original tab bar still works.
 * All bottom-nav LAYOUT lives in mobile.css under @media(max-width:600px); this file
 * only adds the elements those rules style, so desktop is unaffected.
 */
(function () {
 "use strict";
 try {
 var bar = document.getElementById("tabbar");
 if (!bar || bar._mobNav) return;

 // Icon set, simple 24px stroke glyphs, inherit currentColor. Keep in sync with
 // the sections; `more` is the overflow control.
 var I = {
 fleet: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
 arrays: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
 analysis: '<path d="M4 20V10M10 20V4M16 20v-7M4 20h16"/>',
 invoices: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
 account: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3"/>',
 trends: '<path d="M4 16l5-5 4 4 7-7"/><path d="M15 8h5v5"/>',
 resources: '<path d="M4 5a2 2 0 0 1 2-2h9v18H6a2 2 0 0 1-2-2z"/><path d="M15 3l5 2v16l-5-2"/>',
 ops: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
 market: '<path d="M4 9h16l-1 3H5z"/><path d="M5 12v7h14v-7"/><path d="M4 9l1.5-4h13L20 9"/><path d="M10 19v-4h4v4"/>',
 more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
 };
 function svg(name) {
 return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[name] || "") + "</svg>";
 }

 // id -> {short label, icon, primary?}. Primary tabs sit in the bar; the rest go
 // to the More sheet. Order here is the bar order.
 var MAP = [
 { id: "tabDashboard", short: "Fleet", ic: "fleet", primary: true },
 // Inverters folded into Fleet — Marketplace takes the free primary slot
 // so the phone bar stays at 5 thumb targets.
 { id: "tabAnalysis", short: "Analysis", ic: "analysis", primary: true },
 { id: "tabReports", short: "Invoices", ic: "invoices", primary: true },
 { id: "tabMarketplace", short: "Market", ic: "market", primary: true },
 { id: "tabOps", short: "Repairs", ic: "ops", primary: true },
 { id: "tabAccount", short: "Account", ic: "account", primary: false },
 /* Resources is a sub-view under Analysis. Trends → Analysis. */
 ];

 MAP.forEach(function (m) {
 var a = document.getElementById(m.id);
 if (!a || a._mobDone) return;
 a._mobDone = true;
 // Move the tab's current contents (label text + any dot span) into a .tab-full
 // wrapper so mobile can hide the long desktop label without losing the dot.
 var full = document.createElement("span");
 full.className = "tab-full";
 while (a.firstChild) full.appendChild(a.firstChild);
 var ic = document.createElement("span");
 ic.className = "tab-ic";
 ic.innerHTML = svg(m.ic);
 var sh = document.createElement("span");
 sh.className = "tab-short";
 sh.textContent = m.short;
 a.appendChild(ic);
 a.appendChild(full);
 a.appendChild(sh);
 a.classList.add(m.primary ? "tab-primary" : "tab-overflow");
 });

 // --- More control + sheet (only the overflow tabs) ---
 var overflow = MAP.filter(function (m) { return !m.primary; });
 if (overflow.length) {
 var more = document.createElement("button");
 more.type = "button";
 more.className = "tab tab-more tab-primary";
 more.setAttribute("aria-expanded", "false");
 more.innerHTML = '<span class="tab-ic">' + svg("more") + '</span><span class="tab-short">More</span>';

 var sheet = document.createElement("div");
 sheet.className = "mob-more";
 sheet.hidden = true;
 var inner = '<div class="mob-more-grip" aria-hidden="true"></div>';
 overflow.forEach(function (m) {
 var src = document.getElementById(m.id);
 var href = src ? src.getAttribute("href") : "#";
 inner += '<a class="mob-more-item" href="' + href + '" data-for="' + m.id + '">' +
 '<span class="mob-more-ic">' + svg(m.ic) + "</span>" + m.short +
 '<span class="mob-more-go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></a>';
 });
 sheet.innerHTML = inner;

 var backdrop = document.createElement("div");
 backdrop.className = "mob-more-backdrop";
 backdrop.hidden = true;

 function closeMore() {
 sheet.hidden = true; backdrop.hidden = true;
 more.setAttribute("aria-expanded", "false");
 more.classList.remove("on");
 }
 function openMore() {
 sheet.hidden = false; backdrop.hidden = false;
 more.setAttribute("aria-expanded", "true");
 more.classList.add("on");
 }
 more.addEventListener("click", function (e) {
 e.preventDefault();
 if (sheet.hidden) openMore(); else closeMore();
 });
 backdrop.addEventListener("click", closeMore);
 // Route via the real hash then close (app.js handles the actual view switch).
 sheet.addEventListener("click", function (e) {
 var it = e.target.closest ? e.target.closest(".mob-more-item") : null;
 if (it) setTimeout(closeMore, 10);
 });
 // Any hash change (incl. tapping a primary tab) collapses the sheet.
 window.addEventListener("hashchange", closeMore);

 bar.appendChild(more);
 document.body.appendChild(backdrop);
 document.body.appendChild(sheet);

 // Reflect "an overflow section is active" on the More button.
 function syncMore() {
 var h = location.hash || "";
 var active = overflow.some(function (m) {
 var src = document.getElementById(m.id);
 return src && src.getAttribute("href") === h;
 });
 more.classList.toggle("has-active", active);
 }
 window.addEventListener("hashchange", syncMore);
 syncMore();
 }

 bar._mobNav = true;
 } catch (e) {
 // Progressive enhancement, never break the page over nav chrome.
 if (window.console && console.warn) console.warn("mobile-nav enhance skipped:", e);
 }
})();
