/* ============================================================================
 * Array Operator, Analysis tab › Files (analysis-files.js)
 *
 * PowerTrack's per-site document storage, adapted to Array Operator. Operators
 * keep the paperwork that lives with a solar site, interconnection agreements,
 * layouts, O&M contracts, inverter warranties, attached to the site they
 * belong to. This section is the one Analysis panel that fetches its OWN data
 * (a real document store), rather than reading the shared FleetStore snapshot.
 *
 * Signed in → talks to /v1/array-owners/files (list / upload / download /
 * delete), Bearer from localStorage `so_session`. Codes defensively
 * against the endpoint not existing yet in a local preview: any
 * non-200 is treated as "empty / unavailable", never thrown.
 * Demo → synthesizes a few plausible SAMPLE documents from ctx.arrays and
 * renders them READ-ONLY, clearly marked as samples. Upload / delete
 * are disabled and demo files are NEVER presented as real.
 *
 * Self-contained: registers on window.AnalysisSections, injects one scoped
 * <style id="anfiles-css">, namespaces every class anfiles-*. render() is called
 * on first show AND every live re-paint; it rebuilds container.innerHTML each
 * time (idempotent) and reads its file list from a module-level cache so a live
 * re-render never blanks the panel mid-flight.
 * ========================================================================== */
(function () {
 "use strict";

 var SESSION_KEY = "so_session";
 var MAX_BYTES = 10 * 1024 * 1024; // ~10 MB client cap
 var API = "/v1/array-owners/files";

 function getSession() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }

 // ---- module-level state (survives live re-renders) -------------------------
 var STATE = "idle"; // idle | loading | ready | error (real-fetch lifecycle)
 var FILES = null; // Array of real file rows once fetched; null until first load
 var LOADED_FOR = null; // session token the current FILES belongs to (re-fetch on change)
 var FETCH_SEQ = 0; // monotonic guard against out-of-order fetch resolutions
 var UPLOADING = false; // upload in flight → disable the composer
 var NOTICE = null; // {tone:'bad'|'ok', text} transient banner (errors, confirmations)
 var SEL_ARRAY = ""; // last chosen upload-target array_id (persist across renders)
 var _pendingFile = null; // {filename,mime,data_b64,size} staged from the file picker
 var _lastContainer = null; // so async handlers can request a repaint of the live panel

 // ---- byte-size + date helpers ----------------------------------------------
 function humanSize(bytes) {
 var b = (typeof bytes === "number" && isFinite(bytes)) ? bytes : null;
 if (b == null || b < 0) return "—";
 if (b < 1024) return b + " B";
 var u = ["KB", "MB", "GB", "TB"], i = -1, v = b;
 do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
 return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + " " + u[i];
 }
 function fmtDate(x) {
 if (x == null || x === "") return "—";
 var d = (typeof x === "number") ? new Date(x) : new Date(String(x));
 if (isNaN(d.getTime())) return "—";
 try { return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
 catch (e) { return d.toISOString().slice(0, 10); }
 }

 // file extension → a short human "kind" label + tone class
 function kindFor(row) {
 var name = String(row.filename || ""), mime = String(row.mime || "");
 var ext = (name.split(".").pop() || "").toLowerCase();
 if (ext === "pdf" || mime.indexOf("pdf") >= 0) return { label: "PDF", cls: "pdf" };
 if (/^(png|jpg|jpeg|gif|webp|svg|heic)$/.test(ext) || mime.indexOf("image/") === 0) return { label: "Image", cls: "img" };
 if (/^(xls|xlsx|csv)$/.test(ext) || mime.indexOf("spreadsheet") >= 0 || mime.indexOf("csv") >= 0) return { label: "Sheet", cls: "sheet" };
 if (/^(doc|docx)$/.test(ext) || mime.indexOf("word") >= 0) return { label: "Doc", cls: "doc" };
 if (/^(zip|7z|rar)$/.test(ext) || mime.indexOf("zip") >= 0) return { label: "Archive", cls: "arch" };
 if (ext) return { label: ext.toUpperCase(), cls: "gen" };
 return { label: "File", cls: "gen" };
 }

 // ---- demo synthesis: plausible SAMPLE docs from the fleet -------------------
 // Deterministic so it doesn't jitter between paints. Clearly marked sample data;
 // never shown as real, upload/delete disabled in demo.
 var DEMO_DOCS = [
 { filename: "Interconnection Agreement.pdf", mime: "application/pdf", size: 412000 },
 { filename: "Site Layout.png", mime: "image/png", size: 1680000 },
 { filename: "O&M Contract.pdf", mime: "application/pdf", size: 268000 },
 { filename: "Warranty, inverters.pdf", mime: "application/pdf", size: 95000 },
 { filename: "As-built, single-line.pdf", mime: "application/pdf", size: 640000 }
 ];
 function _h(n, salt) { var x = ((Number(n) || 0) * 2654435761 + (salt || 0) * 40503) % 4294967296; return ((x >>> 0) % 1000) / 1000; }
 function buildDemoFiles(arrays) {
 var out = [];
 var sites = (arrays || []).filter(function (a) { return a && a.name; }).slice(0, 4);
 if (!sites.length) return out;
 var base = Date.UTC(2026, 4, 1); // a fixed recent-ish anchor for sample dates
 sites.forEach(function (a, si) {
 // 1–3 docs per site, drawn deterministically from the sample set
 var n = 1 + Math.floor(_h(si + 3, 11) * 3);
 for (var k = 0; k < n; k++) {
 var doc = DEMO_DOCS[(si * 2 + k) % DEMO_DOCS.length];
 var jitter = Math.floor(_h(si * 7 + k, 19) * 60); // day offset
 out.push({
 id: "demo-" + si + "-" + k,
 array_id: a.id, array_name: a.name,
 filename: doc.filename, mime: doc.mime,
 size: Math.round(doc.size * (0.8 + _h(si + k, 23) * 0.6)),
 uploaded_at: base - jitter * 86400000,
 _demo: true
 });
 }
 });
 return out;
 }

 // ---- real data: fetch the file list ----------------------------------------
 // Non-200 / network error → treat as empty & unavailable, never throw. On a
 // fresh signed-in session we lazily kick a fetch; results land in FILES and
 // request a repaint. A monotonic seq guards against out-of-order resolutions.
 function fetchList() {
 var s = getSession(); if (!s) return;
 var seq = ++FETCH_SEQ;
 STATE = "loading";
 LOADED_FOR = s;
 fetch(API, { headers: { Authorization: "Bearer " + s } })
 .then(function (r) { return r.ok ? r.json() : null; })
 .then(function (d) {
 if (seq !== FETCH_SEQ) return; // superseded
 if (d && Array.isArray(d.files)) { FILES = d.files; STATE = "ready"; }
 else { FILES = []; STATE = "ready"; } // no such endpoint yet → empty, not broken
 repaint();
 })
 .catch(function () {
 if (seq !== FETCH_SEQ) return;
 // A genuine network/parse failure (endpoint reachable but errored). If we
 // already had a list, keep it; otherwise surface a gentle retryable state.
 STATE = (FILES && FILES.length) ? "ready" : "error";
 repaint();
 });
 }
 function ensureLoaded() {
 var s = getSession();
 if (!s) return; // demo path handles its own data
 if (LOADED_FOR !== s) { FILES = null; STATE = "idle"; } // session changed → reload
 if (STATE === "idle") fetchList();
 }

 // ---- real data: upload / delete --------------------------------------------
 function doUpload(ctx) {
 var s = getSession(); if (!s) return;
 if (UPLOADING) return;
 if (!_pendingFile) { setNotice("bad", "Choose a file to upload first."); return; }
 if (!SEL_ARRAY) { setNotice("bad", "Pick a site to attach the file to."); return; }
 if (_pendingFile.size > MAX_BYTES) { setNotice("bad", "That file is over 10 MB, please upload a smaller file."); return; }

 UPLOADING = true; NOTICE = null; repaint();
 fetch(API, {
 method: "POST",
 headers: { Authorization: "Bearer " + s, "Content-Type": "application/json" },
 body: JSON.stringify({
 array_id: SEL_ARRAY,
 filename: _pendingFile.filename,
 mime: _pendingFile.mime,
 data_b64: _pendingFile.data_b64
 })
 })
 .then(function (r) { return r.ok ? r.json() : null; })
 .then(function (d) {
 UPLOADING = false;
 if (d && (d.ok || d.file)) {
 _pendingFile = null;
 setNotice("ok", "Uploaded.");
 STATE = "idle"; fetchList(); // refetch the canonical list
 } else {
 setNotice("bad", "Upload didn’t go through, try again.");
 repaint();
 }
 })
 .catch(function () {
 UPLOADING = false;
 setNotice("bad", "Upload failed, check your connection and try again.");
 repaint();
 });
 }

 function doDelete(id) {
 var s = getSession(); if (!s || !id) return;
 // optimistic: drop it locally so the row disappears immediately, then confirm
 var prev = FILES ? FILES.slice() : null;
 if (FILES) FILES = FILES.filter(function (f) { return String(f.id) !== String(id); });
 NOTICE = null; repaint();
 fetch(API + "/" + encodeURIComponent(id), { method: "DELETE", headers: { Authorization: "Bearer " + s } })
 .then(function (r) {
 if (r.ok) { STATE = "idle"; fetchList(); }
 else { FILES = prev; setNotice("bad", "Couldn’t delete that file, try again."); repaint(); }
 })
 .catch(function () { FILES = prev; setNotice("bad", "Delete failed, try again."); repaint(); });
 }

 function doDownload(id, filename) {
 var s = getSession(); if (!s || !id) return;
 fetch(API + "/" + encodeURIComponent(id) + "/download", { headers: { Authorization: "Bearer " + s } })
 .then(function (r) { return r.ok ? r.blob() : null; })
 .then(function (blob) {
 if (!blob) { setNotice("bad", "Couldn’t download that file, try again."); repaint(); return; }
 var url = URL.createObjectURL(blob);
 var a = document.createElement("a");
 a.href = url; a.download = filename || "document";
 document.body.appendChild(a); a.click(); a.remove();
 setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
 })
 .catch(function () { setNotice("bad", "Download failed, try again."); repaint(); });
 }

 // read a chosen File → base64 (strip data:*;base64, prefix), stage it
 function stageFile(file) {
 if (!file) { _pendingFile = null; repaint(); return; }
 if (file.size > MAX_BYTES) { _pendingFile = null; setNotice("bad", "That file is over 10 MB, please upload a smaller file."); return; }
 var reader = new FileReader();
 reader.onload = function () {
 var res = String(reader.result || "");
 var comma = res.indexOf(",");
 var b64 = comma >= 0 ? res.slice(comma + 1) : res;
 _pendingFile = { filename: file.name, mime: file.type || "application/octet-stream", data_b64: b64, size: file.size };
 NOTICE = null; repaint();
 };
 reader.onerror = function () { _pendingFile = null; setNotice("bad", "Couldn’t read that file, try another."); };
 reader.readAsDataURL(file);
 }

 function setNotice(tone, text) { NOTICE = { tone: tone, text: text }; repaint(); }
 function repaint() { if (window.__aoLoadAnalysis) { /* orchestrator owns the loop */ } if (_lastContainer && _lastContainer.isConnected) render(_lastContainer, _lastContainer._anfilesCtx); }

 // ---- one-time scoped CSS ---------------------------------------------------
 function ensureCss() {
 if (document.getElementById("anfiles-css")) return;
 var st = document.createElement("style");
 st.id = "anfiles-css";
 st.textContent = [
 /* header total */
 ".anfiles-tot{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}",
 ".anfiles-tot b{color:var(--muted);font-weight:680}",

 /* upload composer */
 ".anfiles-up{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--bg2)}",
 ".anfiles-up-lead{font-size:12.5px;font-weight:640;color:var(--muted);margin-right:2px}",
 ".anfiles-sel{font:inherit;font-size:13px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 11px;min-width:170px;max-width:280px}",
 ".anfiles-sel:disabled{opacity:.55;cursor:not-allowed}",
 ".anfiles-pick{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13px;font-weight:640;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 12px;cursor:pointer}",
 ".anfiles-pick:hover{border-color:var(--good)}",
 ".anfiles-pick svg{width:15px;height:15px;opacity:.8}",
 ".anfiles-chosen{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;max-width:32ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
 ".anfiles-chosen b{color:var(--ink);font-weight:640}",
 ".anfiles-go{font:inherit;font-size:13px;font-weight:700;color:#fff;background:var(--good);border:1px solid var(--good);border-radius:9px;padding:8px 16px;cursor:pointer;margin-left:auto}",
 ".anfiles-go:hover{filter:brightness(1.06)}",
 ".anfiles-go:disabled{opacity:.5;cursor:not-allowed;filter:none}",
 ".anfiles-hint{width:100%;font-size:11.5px;color:var(--faint);margin-top:-2px}",

 /* notice banner */
 ".anfiles-note{display:flex;align-items:center;gap:8px;padding:9px 18px;font-size:12.5px;border-bottom:1px solid var(--line)}",
 ".anfiles-note.bad{color:var(--bad);background:rgba(220,38,38,.07)}",
 ".anfiles-note.ok{color:var(--good);background:rgba(37,99,235,.07)}",

 /* demo asterisk */
 ".anfiles-demo{display:flex;align-items:center;gap:8px;padding:10px 18px;border-bottom:1px solid var(--line);color:var(--faint);font-size:12px;line-height:1.4}",
 ".anfiles-demo svg{width:14px;height:14px;flex:0 0 auto;opacity:.7}",
 ".anfiles-demo b{color:var(--muted);font-weight:640}",

 /* site groups */
 ".anfiles-list{display:flex;flex-direction:column}",
 ".anfiles-grp{border-bottom:1px solid var(--line)}",
 ".anfiles-grp:last-child{border-bottom:0}",
 ".anfiles-ghead{display:flex;align-items:center;gap:10px;padding:11px 18px;background:var(--card2)}",
 ".anfiles-gname{font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
 ".anfiles-gcount{flex:0 0 auto;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}",
 ".anfiles-gsize{margin-left:auto;flex:0 0 auto;font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums}",

 /* file rows */
 ".anfiles-row{display:grid;grid-template-columns:minmax(0,1fr) 96px 120px auto;align-items:center;gap:14px;padding:10px 18px 10px 30px;border-top:1px solid var(--line)}",
 ".anfiles-row:hover{background:var(--bg2)}",
 ".anfiles-fn{display:flex;align-items:center;gap:10px;min-width:0}",
 ".anfiles-badge{flex:0 0 auto;width:34px;height:34px;border-radius:8px;display:grid;place-items:center;font-size:9.5px;font-weight:800;letter-spacing:.02em;color:var(--muted);background:var(--card);border:1px solid var(--line)}",
 ".anfiles-badge.pdf{color:#b91c1c;background:rgba(220,38,38,.09);border-color:rgba(220,38,38,.2)}",
 ".anfiles-badge.img{color:#0891b2;background:rgba(8,145,178,.1);border-color:rgba(8,145,178,.2)}",
 ".anfiles-badge.sheet{color:#15803d;background:rgba(22,128,61,.1);border-color:rgba(22,128,61,.2)}",
 ".anfiles-badge.doc{color:var(--good);background:rgba(37,99,235,.1);border-color:rgba(37,99,235,.2)}",
 ".anfiles-fname{font-size:13px;font-weight:620;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
 ".anfiles-meta{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}",
 ".anfiles-date{font-size:12.5px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}",
 ".anfiles-acts{display:flex;align-items:center;justify-content:flex-end;gap:6px}",
 ".anfiles-act{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;background:transparent;border:1px solid transparent;color:var(--muted);cursor:pointer}",
 ".anfiles-act:hover{background:var(--card);border-color:var(--line);color:var(--ink)}",
 ".anfiles-act.del:hover{color:var(--bad);border-color:rgba(220,38,38,.3)}",
 ".anfiles-act svg{width:16px;height:16px}",
 ".anfiles-act[disabled]{opacity:.35;cursor:not-allowed}",

 /* empty / loading / error states */
 ".anfiles-state{padding:34px 18px;text-align:center;color:var(--muted);font-size:13px;line-height:1.5}",
 ".anfiles-state b{color:var(--ink);font-weight:680;display:block;margin-bottom:4px}",
 ".anfiles-retry{margin-top:12px;font:inherit;font-size:12.5px;font-weight:640;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:7px 14px;cursor:pointer}",
 ".anfiles-retry:hover{border-color:var(--good)}",
 ".anfiles-skel{padding:24px 18px;color:var(--faint);font-size:13px}",

 "@media (max-width:760px){",
 " .anfiles-row{grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;padding-left:18px}",
 " .anfiles-meta,.anfiles-date{grid-column:1;font-size:12px}",
 " .anfiles-acts{grid-column:2;grid-row:1 / span 3;align-self:center}",
 " .anfiles-go{margin-left:0}",
 "}"
 ].join("\n");
 document.head.appendChild(st);
 }

 // ---- svg snippets -----------------------------------------------------------
 var ICO_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"></path><path d="M7 9l5-5 5 5"></path><path d="M5 20h14"></path></svg>';
 var ICO_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"></path><path d="M7 10l5 5 5-5"></path><path d="M5 20h14"></path></svg>';
 var ICO_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
 var ICO_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="11" x2="12" y2="16"></line><circle cx="12" cy="7.5" r=".6" fill="currentColor"></circle></svg>';

 // ---- render one file row ----------------------------------------------------
 function rowHtml(f, ctx, demo) {
 var esc = ctx.esc;
 var k = kindFor(f);
 var acts;
 if (demo) {
 acts = '<div class="anfiles-acts">' +
 '<span class="anfiles-act" title="Sign in to download" disabled>' + ICO_DL + '</span>' +
 '</div>';
 } else {
 acts = '<div class="anfiles-acts">' +
 '<button type="button" class="anfiles-act" data-dl="' + esc(f.id) + '" data-fn="' + esc(f.filename || "document") + '" title="Download">' + ICO_DL + '</button>' +
 '<button type="button" class="anfiles-act del" data-del="' + esc(f.id) + '" data-fn="' + esc(f.filename || "this file") + '" title="Delete">' + ICO_DEL + '</button>' +
 '</div>';
 }
 return '<div class="anfiles-row">' +
 '<div class="anfiles-fn">' +
 ' <span class="anfiles-badge ' + k.cls + '">' + esc(k.label) + '</span>' +
 ' <span class="anfiles-fname" title="' + esc(f.filename || "") + '">' + esc(f.filename || "Untitled") + '</span>' +
 '</div>' +
 '<span class="anfiles-meta">' + esc(humanSize(f.size)) + '</span>' +
 '<span class="anfiles-date">' + esc(fmtDate(f.uploaded_at)) + '</span>' +
 acts +
 '</div>';
 }

 // ---- render one site group --------------------------------------------------
 function groupHtml(name, files, ctx, demo) {
 var esc = ctx.esc;
 var totBytes = files.reduce(function (s, f) { return s + (typeof f.size === "number" ? f.size : 0); }, 0);
 var head = '<div class="anfiles-ghead">' +
 '<span class="anfiles-gname">' + esc(name || "Unassigned") + '</span>' +
 '<span class="anfiles-gcount">' + files.length + (files.length === 1 ? " doc" : " docs") + '</span>' +
 '<span class="anfiles-gsize">' + esc(humanSize(totBytes)) + '</span>' +
 '</div>';
 var rows = files.map(function (f) { return rowHtml(f, ctx, demo); }).join("");
 return '<div class="anfiles-grp">' + head + rows + '</div>';
 }

 // group a flat file list by array_name, preserving fleet order from ctx.arrays
 function groupByArray(files, arrays) {
 var order = [], seen = Object.create(null), byName = Object.create(null);
 (arrays || []).forEach(function (a) { if (a && a.name && !seen[a.name]) { seen[a.name] = true; order.push(a.name); byName[a.name] = []; } });
 files.forEach(function (f) {
 var name = f.array_name || "Unassigned";
 if (!byName[name]) { byName[name] = []; order.push(name); }
 byName[name].push(f);
 });
 return order.filter(function (n) { return byName[n] && byName[n].length; })
 .map(function (n) { return { name: n, files: byName[n] }; });
 }

 // ---- render (idempotent full rebuild) --------------------------------------
 function render(container, ctx) {
 ensureCss();
 _lastContainer = container;
 container._anfilesCtx = ctx;

 var esc = ctx.esc, demo = !ctx.signedIn;
 var arrays = ctx.arrays || [];

 // pick the data source
 var files;
 if (demo) {
 files = buildDemoFiles(arrays);
 } else {
 ensureLoaded(); // may kick an async fetch → repaint later
 files = FILES || [];
 }

 var total = files.length;
 var totalBytes = files.reduce(function (s, f) { return s + (typeof f.size === "number" ? f.size : 0); }, 0);

 // ---- header (right side: count + total size) ----
 var totLabel = total
 ? '<span class="anfiles-tot"><b>' + ctx.fmt.num(total) + '</b> ' + (total === 1 ? "document" : "documents") + ' · ' + esc(humanSize(totalBytes)) + '</span>'
 : '<span class="anfiles-tot">No documents</span>';
 var head =
 '<div class="an-card-head">' +
 ' <h3>Files</h3>' + totLabel +
 '</div>';

 // ---- upload composer (real only) ----
 var composer = "";
 if (!demo) {
 var opts = '<option value="">Choose a site…</option>' + arrays.map(function (a) {
 return '<option value="' + esc(a.id) + '"' + (String(a.id) === String(SEL_ARRAY) ? " selected" : "") + '>' + esc(a.name || ("Array " + a.id)) + '</option>';
 }).join("");
 var chosen = _pendingFile
 ? '<span class="anfiles-chosen">Selected <b>' + esc(_pendingFile.filename) + '</b> · ' + esc(humanSize(_pendingFile.size)) + '</span>'
 : '<span class="anfiles-chosen"></span>';
 var canGo = !UPLOADING && !!_pendingFile && !!SEL_ARRAY;
 composer =
 '<div class="anfiles-up">' +
 ' <span class="anfiles-up-lead">Upload</span>' +
 ' <select class="anfiles-sel" data-role="site"' + (UPLOADING ? " disabled" : "") + '>' + opts + '</select>' +
 ' <button type="button" class="anfiles-pick" data-role="pick"' + (UPLOADING ? " disabled" : "") + '>' + ICO_UP + ' Choose file</button>' +
 chosen +
 ' <button type="button" class="anfiles-go" data-role="go"' + (canGo ? "" : " disabled") + '>' + (UPLOADING ? "Uploading…" : "Upload") + '</button>' +
 ' <input type="file" data-role="file" style="display:none">' +
 ' <div class="anfiles-hint">Interconnection agreements, layouts, O&amp;M contracts, warranties. Up to 10&nbsp;MB per file.</div>' +
 '</div>';
 }

 // ---- demo asterisk ----
 var demoNote = demo
 ? '<div class="anfiles-demo">' + ICO_INFO + '<span><b>Sample documents</b>, sign in to upload and manage your own files. These are illustrative, not real files.</span></div>'
 : "";

 // ---- transient notice ----
 var notice = (!demo && NOTICE)
 ? '<div class="anfiles-note ' + esc(NOTICE.tone) + '">' + esc(NOTICE.text) + '</div>'
 : "";

 // ---- body: list / empty / loading / error ----
 var body;
 if (!demo && STATE === "loading" && (!FILES || !FILES.length)) {
 body = '<div class="anfiles-skel">Loading files…</div>';
 } else if (!demo && STATE === "error") {
 body = '<div class="anfiles-state"><b>Couldn’t load files</b>There was a problem reaching your document store.' +
 '<div><button type="button" class="anfiles-retry" data-role="retry">Try again</button></div></div>';
 } else if (!files.length) {
 body = '<div class="anfiles-state"><b>No documents yet</b>Upload interconnection agreements, layouts, O&amp;M contracts, and warranties, they’ll be filed under the site they belong to.</div>';
 } else {
 var groups = groupByArray(files, arrays);
 body = '<div class="anfiles-list">' +
 groups.map(function (g) { return groupHtml(g.name, g.files, ctx, demo); }).join("") +
 '</div>';
 }

 container.innerHTML = '<div class="an-card">' + head + composer + demoNote + notice + body + '</div>';

 // ---- wire handlers (bind once per container; delegate) ----
 if (container._anfilesBound !== true) {
 container.addEventListener("change", function (e) {
 var t = e.target; if (!t) return;
 if (t.getAttribute && t.getAttribute("data-role") === "site") { SEL_ARRAY = t.value; NOTICE = null; }
 else if (t.getAttribute && t.getAttribute("data-role") === "file") {
 stageFile(t.files && t.files[0]);
 }
 });
 container.addEventListener("click", async function (e) {
 var el = e.target && e.target.closest ? e.target.closest("[data-role],[data-dl],[data-del]") : null;
 if (!el || !container.contains(el)) return;
 var role = el.getAttribute("data-role");
 if (role === "pick") {
 var input = container.querySelector('input[data-role="file"]');
 if (input) input.click();
 } else if (role === "go") {
 doUpload(container._anfilesCtx || ctx);
 } else if (role === "retry") {
 STATE = "idle"; ensureLoaded(); repaint();
 } else if (el.hasAttribute("data-dl")) {
 doDownload(el.getAttribute("data-dl"), el.getAttribute("data-fn"));
 } else if (el.hasAttribute("data-del")) {
 var name = el.getAttribute("data-fn") || "this file";
 var ok = await AODialog.confirm("This can’t be undone.", { title: "Delete " + name + "?", danger: true, confirmLabel: "Delete" });
 if (ok) doDelete(el.getAttribute("data-del"));
 }
 });
 container._anfilesBound = true;
 }
 }

 window.AnalysisSections = window.AnalysisSections || [];
 window.AnalysisSections.push({ id: "files", title: "Files", order: 60, render: render });
})();
