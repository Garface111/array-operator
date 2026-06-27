"""Verify the generation-spreadsheet tracker UI on the Offtaker Invoice Generator:

  1. the MASTER operator-wide sheet (#rbGlobalTracker) renders pinned at the TOP
     ("Master generation spreadsheet", auto-built shape), and
  2. each offtaker's OWN sheet (.rb-track-sub) renders INSIDE its accordion card —
     an empty upload state, then a DETECTED column mapping after upload, a
     Download-latest button, and Remove returns it to empty.

Mocks /v1/**. The master tracker endpoint is /v1/array-operator/tracker; each
offtaker's is /v1/array-operator/billing/subscriptions/{id}/tracker — the mock
branches on the URL so the two scopes return their own shapes.
Run: <venv-with-playwright+openpyxl>/python scripts/verify_tracker_ui.py
"""
import os, threading, functools, http.server, socketserver, time, json, io
from playwright.sync_api import sync_playwright

PORT = 8207
PUBLIC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))
OUT = "/tmp/tracker_shots"; os.makedirs(OUT, exist_ok=True)

DRAFT = {"id": 8, "subscription_id": 42, "customer_name": "Maple Farm Solar",
    "status": "pending", "period_label": "2026-05-21 → 2026-06-22",
    "array_total_kwh": 2310, "allocation_pct": 1.0, "customer_kwh": 2310,
    "amount_usd": 595.1, "invoice_number": "2026-06", "has_gmp_pdf": False,
    "gmp_filename": None, "note": None, "client_email": "ops@maplefarm.test",
    "send_mode": "to_me", "include_summary": False, "operator_name": "Dyson Swarm",
    "auto_attach_gmp": True, "gmp_auto_status": "pending", "cadence": "monthly",
    "cc_emails": "", "discount_pct": 0.10, "net_rate_per_kwh": None,
    "utility_account_id": 1378, "has_workbook": False,
    "created_at": "2026-06-24T00:00:00", "sent_at": None}
ACCTS = {"utility_accounts": [
    {"utility_account_id": 1378, "account_number": "5738500000",
     "array_name": "Maple Farm", "nickname": None, "bill_count": 3}]}

# The MASTER sheet the tenant endpoint serves: auto-built, a column per array.
MASTER_AUTO = {"enabled": True, "auto": True, "has_sheet": True,
    "filename": "generation_by_array.xlsx",
    "headers": ["Period", "Maple Farm", "River Road", "Total"],
    "columns": {"Period": 0, "Maple Farm": 1, "River Road": 2, "Total": 3},
    "header_row": 1, "sheet": "Generation by array", "data_rows": 3,
    "last_period": "2026-06", "updated_at": "2026-06-27T12:00:00", "warnings": []}

# The detected-mapping the per-offtaker endpoint returns after our sample upload.
DETECTED = {"enabled": True, "has_sheet": True, "filename": "maple_log.xlsx",
    "columns": {"period": 0, "generation": 1, "consumption": 2, "rate": 3, "amount": 4},
    "headers": ["Billing Month", "Solar Produced (kWh)", "Home Usage",
                "Credit $/kWh", "Total Credit"],
    "header_row": 1, "sheet": "MyLedger", "data_rows": 3,
    "last_period": "2026-05", "updated_at": "2026-06-26T12:00:00",
    "warnings": []}
EMPTY_TRACKER = {"enabled": True, "has_sheet": False, "filename": None,
    "columns": None, "headers": None, "warnings": []}

# A tiny valid xlsx to "download".
def _xlsx_bytes():
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.append(["Billing Month", "Solar Produced (kWh)"])
    ws.append(["2026-06", 2450]); buf = io.BytesIO(); wb.save(buf); return buf.getvalue()
XLSX = _xlsx_bytes()

STATE = {"uploaded": False}

def _is_master(u):
    return "array-operator/tracker" in u and "/subscriptions/" not in u

def body_for(u):
    if "/drafts" in u: return json.dumps({"drafts": [DRAFT]})
    if "/utility-accounts" in u: return json.dumps(ACCTS)
    if "/account" in u and "utility" not in u:
        return '{"email":"x","active":true,"subscription_status":"active","name":"Dyson Swarm"}'
    if "/setup-state" in u: return '{"ok":true,"has_customers":true}'
    if "/subscriptions" in u and "/tracker" not in u: return '{"subscriptions":[]}'
    if "/fleet-tree" in u: return '{"columns":[]}'
    if "/global-rate" in u:
        return '{"ok":true,"default_discount_pct":0.1,"effective_net_rate_per_kwh":0.18,"effective_discount_pct":0.1}'
    if "/invoice-template" in u: return '{"template":null}'
    return "{}"

def handle(rt):
    req = rt.request; u = req.url; m = req.method
    if "/tracker/download" in u:
        rt.fulfill(status=200, body=XLSX,
            headers={"Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                     "Content-Disposition": 'attachment; filename="maple_log.xlsx"'})
        return
    if "/tracker" in u:
        # MASTER (tenant) endpoint: always serve the auto-built sheet.
        if _is_master(u):
            rt.fulfill(status=200, content_type="application/json",
                       body=json.dumps({"ok": True, "tracker": MASTER_AUTO})); return
        # PER-OFFTAKER endpoint: empty until uploaded, DETECTED after.
        if m == "POST":
            STATE["uploaded"] = True
            rt.fulfill(status=200, content_type="application/json",
                       body=json.dumps({"ok": True, "tracker": DETECTED})); return
        if m == "DELETE":
            STATE["uploaded"] = False
            rt.fulfill(status=200, content_type="application/json",
                       body=json.dumps({"ok": True, "tracker": EMPTY_TRACKER})); return
        t = DETECTED if STATE["uploaded"] else EMPTY_TRACKER
        rt.fulfill(status=200, content_type="application/json",
                   body=json.dumps({"ok": True, "tracker": t})); return
    if m == "PATCH" and "/subscriptions/" in u:
        rt.fulfill(status=200, content_type="application/json", body='{"ok":true}'); return
    if m == "POST" and u.rstrip("/").endswith("/draft"):
        rt.fulfill(status=200, content_type="application/json",
                   body=json.dumps({"ok": True, "draft": DRAFT})); return
    rt.fulfill(status=200, content_type="application/json", body=body_for(u))

H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=PUBLIC)
hd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=hd.serve_forever, daemon=True).start(); time.sleep(0.4)

# write the sample upload file
SAMPLE = "/tmp/maple_log.xlsx"
open(SAMPLE, "wb").write(_xlsx_bytes())

res = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 1500}, device_scale_factor=2)
    pg.route("**/v1/**", handle)
    pg.add_init_script("try{localStorage.setItem('so_session','f');localStorage.setItem('ao_theme','day');}catch(e){}")
    pg.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="domcontentloaded")
    pg.wait_for_timeout(900)
    pg.evaluate("()=>{const t=document.getElementById('tabReports'); if(t)t.click();}")
    pg.wait_for_timeout(1800)

    # 1) MASTER sheet pinned at the top.
    mb = pg.query_selector("#rbGlobalTracker:not([hidden])")
    res["masterVisible"] = bool(mb)
    res["masterTitle"] = pg.eval_on_selector("#rbGlobalTracker .rb-track-h .rl", "e=>e.textContent.trim()") if mb else None
    res["masterChips"] = pg.eval_on_selector_all("#rbGlobalTracker .rb-track-chip", "els=>els.map(e=>e.textContent.trim())")
    res["masterHasDownload"] = bool(pg.query_selector("#rbGlobalTracker .rb-track-dl"))
    res["masterHasRemove"] = bool(pg.query_selector("#rbGlobalTracker .rb-track-rm"))  # auto sheet → should be False

    # The default offtaker card auto-opens; make sure its body is open.
    if not pg.query_selector(".rb-track-sub:not([hidden])"):
        head = pg.query_selector(".rb-acc-head")
        if head: head.click(); pg.wait_for_timeout(1200)

    # 2) PER-OFFTAKER card present inside the accordion (empty state).
    sub = pg.query_selector(".rb-track-sub:not([hidden])")
    res["offtakerCardVisible"] = bool(sub)
    res["offtakerTitle"] = pg.eval_on_selector(".rb-track-sub .rb-track-h .rl", "e=>e.textContent.trim()") if sub else None
    res["offtakerHasUpload"] = bool(pg.query_selector(".rb-track-sub [data-tup]"))
    res["offtakerEmptyHint"] = pg.eval_on_selector(".rb-track-sub .rb-track-hint", "e=>e.textContent.trim()") if sub else None
    pg.screenshot(path=os.path.join(OUT, "tracker_master_plus_offtaker.png"), full_page=True)

    # 3) Upload the sample sheet to the OFFTAKER card → detected mapping chips appear.
    with pg.expect_file_chooser() as fc_info:
        pg.eval_on_selector(".rb-track-sub [data-tup]", "e=>e.click()")
    fc_info.value.set_files(SAMPLE)
    pg.wait_for_timeout(900)
    res["offtakerMapChips"] = pg.eval_on_selector_all(".rb-track-sub .rb-track-chip", "els=>els.map(e=>e.textContent.trim())")
    res["offtakerHasDownloadAfterUpload"] = bool(pg.query_selector(".rb-track-sub .rb-track-dl"))
    res["offtakerHasRemoveAfterUpload"] = bool(pg.query_selector(".rb-track-sub .rb-track-rm"))
    res["offtakerMeta"] = pg.eval_on_selector(".rb-track-sub .rb-track-meta", "e=>e.textContent.trim()") if pg.query_selector(".rb-track-sub .rb-track-meta") else None
    pg.screenshot(path=os.path.join(OUT, "tracker_offtaker_detected.png"), full_page=True)
    _m = pg.query_selector("#rbGlobalTracker")
    if _m: _m.screenshot(path=os.path.join(OUT, "card_master.png"))
    _s = pg.query_selector(".rb-track-sub")
    if _s: _s.screenshot(path=os.path.join(OUT, "card_offtaker.png"))

    # 4) Download latest → a file download is triggered (per-offtaker).
    try:
        with pg.expect_download(timeout=5000) as dl_info:
            pg.eval_on_selector(".rb-track-sub .rb-track-dl", "e=>e.click()")
        dl = dl_info.value
        res["downloadFilename"] = dl.suggested_filename
        res["downloadOk"] = True
    except Exception as e:
        res["downloadOk"] = False; res["downloadErr"] = str(e)[:120]
    pg.wait_for_timeout(400)

    # 5) Remove → back to empty state (re-GET returns EMPTY).
    if pg.query_selector(".rb-track-sub .rb-track-rm"):
        pg.eval_on_selector(".rb-track-sub .rb-track-rm", "e=>e.click()")
        pg.wait_for_timeout(800)
    res["afterRemoveHasUpload"] = bool(pg.query_selector(".rb-track-sub [data-tup]"))
    res["afterRemoveNoChips"] = (len(pg.query_selector_all(".rb-track-sub .rb-track-chip")) == 0)

    # Console errors?
    b.close()
hd.shutdown()
print(json.dumps(res, indent=1, ensure_ascii=False))
