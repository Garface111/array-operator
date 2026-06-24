"""Approval inbox: confirm the inline live offtaker editor renders in the empty
box, persists edits, recomputes money figures, and live-updates the preview."""
import os, threading, functools, http.server, socketserver, time, json
from playwright.sync_api import sync_playwright
PORT=8198; PUBLIC=os.path.abspath(os.path.join(os.path.dirname(__file__),"..","public"))
OUT="/tmp/offedit_shots"; os.makedirs(OUT, exist_ok=True)
DESK="/mnt/c/Users/fordg/Desktop/EnergyAgent Web Store Submission"
DRAFT={"id":8,"subscription_id":42,"customer_name":"Rick Lunt","status":"pending",
 "period_label":"2026-05-21 → 2026-06-22","array_total_kwh":108,"allocation_pct":0.25,
 "customer_kwh":27,"amount_usd":5.19,"invoice_number":"2026-06","has_gmp_pdf":False,
 "gmp_filename":None,"note":None,"client_email":"rick@example.com","send_mode":"to_me",
 "include_summary":True,"operator_name":"Dyson Swarm Technologies","auto_attach_gmp":True,
 "gmp_auto_status":"pending","cadence":"monthly","cc_emails":"","discount_pct":0.10,
 "net_rate_per_kwh":None,"utility_account_id":1378,"has_workbook":False,
 "created_at":"2026-06-24T00:00:00","sent_at":None}
ACCTS={"utility_accounts":[
 {"utility_account_id":1378,"account_number":"5738500000","array_name":"Rutland Yard","nickname":None,"bill_count":3},
 {"utility_account_id":1366,"account_number":"2778764040","array_name":"Londonderry","nickname":None,"bill_count":12}]}
# Server "recompute" for share 25%→30%: 108×0.30=32.4 kWh, $6.23.
REGEN={"ok":True,"draft":{"id":8,"array_total_kwh":108,"allocation_pct":0.30,
 "customer_kwh":32.4,"amount_usd":6.23,"invoice_number":"2026-06",
 "period_label":"2026-05-21 → 2026-06-22"}}
def body_for(u):
    if "/drafts" in u: return json.dumps({"drafts":[DRAFT]})
    if "/utility-accounts" in u: return json.dumps(ACCTS)
    if "/account" in u and "utility" not in u: return '{"email":"x","active":true,"subscription_status":"active","name":"Dyson Swarm Technologies"}'
    if "/setup-state" in u: return '{"ok":true,"has_customers":true}'
    if "/subscriptions" in u: return '{"subscriptions":[]}'
    if "/fleet-tree" in u: return '{"columns":[]}'
    if "/global-rate" in u: return '{"ok":true,"default_discount_pct":0.1,"effective_net_rate_per_kwh":0.18,"effective_discount_pct":0.1}'
    if "/invoice-template" in u: return '{"template":null}'
    return "{}"
def handle(rt):
    req=rt.request; u=req.url; m=req.method
    if m=="PATCH" and "/subscriptions/" in u:
        rt.fulfill(status=200,content_type="application/json",body='{"ok":true}'); return
    if m=="POST" and u.rstrip("/").endswith("/draft"):
        rt.fulfill(status=200,content_type="application/json",body=json.dumps(REGEN)); return
    rt.fulfill(status=200,content_type="application/json",body=body_for(u))
H=functools.partial(http.server.SimpleHTTPRequestHandler,directory=PUBLIC); hd=socketserver.TCPServer(("127.0.0.1",PORT),H)
threading.Thread(target=hd.serve_forever,daemon=True).start(); time.sleep(0.4)
res={}
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1440,"height":1200}, device_scale_factor=2)
    pg.route("**/v1/**", handle); pg.add_init_script("try{localStorage.setItem('so_session','f');localStorage.setItem('ao_theme','day');}catch(e){}")
    pg.goto(f"http://127.0.0.1:{PORT}/index.html",wait_until="domcontentloaded"); pg.wait_for_timeout(900)
    pg.evaluate("()=>{const t=document.getElementById('tabReports'); if(t)t.click();}")
    pg.wait_for_timeout(1500)
    res["editorFields"]=pg.eval_on_selector_all(".rb-offedit [data-of]", "els=>els.map(e=>e.getAttribute('data-of'))")
    res["billPickerSel"]=pg.eval_on_selector('.rb-offedit [data-of="utility_account_id"]', "e=>e.value") if pg.query_selector('.rb-offedit [data-of="utility_account_id"]') else None
    res["billOptionLabels"]=pg.eval_on_selector_all('.rb-offedit [data-of="utility_account_id"] option', "els=>els.map(e=>e.textContent)")
    res["beforeGridAmount"]=pg.eval_on_selector(".rb-draft-grid .rb-v.rb-amt","e=>e.textContent")
    # screenshot the filled left column
    col=pg.query_selector(".rb-draft")
    if col: col.screenshot(path=os.path.join(OUT,"offtaker_editor.png"))
    try:
        if col and os.path.isdir(DESK): col.screenshot(path=os.path.join(DESK,"offtaker_editor.png"))
    except Exception: pass
    # ── live COPY update: rename → preview subject/to reflects it instantly ──
    pg.fill('.rb-offedit [data-of="customer_name"]', "Rick Lunt (Shelburne)")
    pg.wait_for_timeout(250)
    res["previewHasNewName"]="Rick Lunt (Shelburne)" in (pg.inner_text("#rbDraftDocPane") if pg.query_selector("#rbDraftDocPane") else "")
    # ── live MONEY recompute: share 25→30 → grid + preview show $6.23 ──
    pg.fill('.rb-offedit [data-of="allocation_pct"]', "30")
    pg.wait_for_timeout(1400)   # debounce(600) + PATCH + regen
    res["afterGridAmount"]=pg.eval_on_selector(".rb-draft-grid .rb-v.rb-amt","e=>e.textContent")
    res["afterGridShare"]=pg.eval_on_selector_all(".rb-draft-grid .rb-v","els=>els[1].textContent")
    res["afterGridProd"]=pg.eval_on_selector_all(".rb-draft-grid .rb-v","els=>els[2].textContent")
    ptxt=pg.inner_text("#rbDraftDocPane") if pg.query_selector("#rbDraftDocPane") else ""
    res["previewHas623"]="6.23" in ptxt
    res["noteHas623"]="6.23" in pg.eval_on_selector("textarea[data-draftmsg]","e=>e.value")
    res["editStatus"]=pg.eval_on_selector(".rb-offedit-status","e=>e.textContent") if pg.query_selector(".rb-offedit-status") else None
    col=pg.query_selector(".rb-draft")
    if col: col.screenshot(path=os.path.join(OUT,"offtaker_editor_after.png"))
    try:
        if col and os.path.isdir(DESK): col.screenshot(path=os.path.join(DESK,"offtaker_editor_after.png"))
    except Exception: pass
    b.close()
hd.shutdown(); print(json.dumps(res,indent=1,ensure_ascii=False))
