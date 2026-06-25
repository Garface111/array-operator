import os, threading, functools, http.server, socketserver, time, json, sys
from playwright.sync_api import sync_playwright
PORT = 8252; PUBLIC = "/root/array-operator/public"
daily = [{"date": f"2026-06-{d:02d}", "kwh": k} for d, k in
         zip(range(11, 25), [120, 135, 118, 142, 150, 96, 88, 140, 138, 145, 130, 152, 149, 151])]
INV = {"inverter_id": 701, "name": "#1 24Kw 191226865", "model": "STP 24kTL-US-10",
       "nameplate_kw": 24, "status": "ok", "current_power_w": 24000, "peer_index": 1.03,
       "window_kwh": 1788, "min_kwh": 88, "peak_kwh": 152, "daily": daily,
       "diagnosis": "Pulling its weight — right in line with its neighbors."}
TREE = {"columns": [
    {"array_id": 9, "array_name": "Timberworks", "vendor": "sma", "current_power_w": 150000,
     "produced_today_kwh": 1133, "is_daylight": True, "inverter_count": 2,
     "inverters": [INV, {"inverter_id": 702, "name": "#2 24Kw 191225636", "model": "STP 24kTL-US-10",
                         "nameplate_kw": 24, "status": "ok", "current_power_w": 24000}]},
]}
def body_for(u):
    if "fleet-tree" in u: return json.dumps(TREE)
    if "/account" in u and "utility" not in u: return '{"email":"x","active":true,"subscription_status":"active","name":"Test"}'
    return "{}"
def handle(rt): rt.fulfill(status=200, content_type="application/json", body=body_for(rt.request.url))
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=PUBLIC)
hd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=hd.serve_forever, daemon=True).start(); time.sleep(0.4)
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1100, "height": 760}, device_scale_factor=2)
    pg.route("**/v1/**", handle)
    pg.add_init_script("try{localStorage.setItem('so_session','f');localStorage.setItem('ao_theme','day');localStorage.setItem('ao_vendor_view','spreadsheet');}catch(e){}")
    pg.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="domcontentloaded"); pg.wait_for_timeout(1600)
    pg.evaluate("()=>{const t=document.getElementById('tabArrays'); if(t)t.click();}"); pg.wait_for_timeout(500)
    pg.evaluate("()=>{const s=document.getElementById('vsSegSheet'); if(s)s.click();}"); pg.wait_for_timeout(1000)
    res["array_rows"] = pg.eval_on_selector_all('[data-arr]', "els=>els.length")
    pg.eval_on_selector('[data-arr="9"]', "e=>e.click()"); pg.wait_for_timeout(400)
    res["inv_rows"] = pg.eval_on_selector_all('[data-inv]', "els=>els.length")
    res["detail_before_click"] = pg.query_selector(".vs-inv-detail") is not None
    pg.eval_on_selector('[data-inv="9:701"]', "e=>e.click()"); pg.wait_for_timeout(400)
    d = pg.query_selector(".vs-inv-detail")
    res["detail_after_click"] = d is not None
    if d:
        res["has_diagnosis"] = "Pulling its weight" in pg.inner_text(".vs-id-diag")
        res["cell_keys"] = pg.eval_on_selector_all(".vs-id-k", "els=>els.map(e=>e.textContent)")
        res["has_sparkline"] = pg.query_selector(".vs-id-spark") is not None
        res["spark_bars"] = pg.eval_on_selector_all(".vs-id-spark rect", "els=>els.length")
        res["detail_text"] = pg.inner_text(".vs-inv-detail")[:200]
        try:
            sec = pg.query_selector("#vendorSheet")
            (sec or pg).screenshot(path="/root/array-operator/scripts/vinv.png")
        except Exception as e: res["shot_err"] = str(e)[:60]
    pg.eval_on_selector('[data-inv="9:701"]', "e=>e.click()"); pg.wait_for_timeout(300)
    res["detail_after_toggle"] = pg.query_selector(".vs-inv-detail") is not None
    b.close()
hd.shutdown()
print(json.dumps(res, indent=1), file=sys.stderr)
