"""Draft card: the '✨ Write with AI' button calls /ai-email and fills the editable
email textarea with the returned cover note (then it's review/editable)."""
import os, threading, functools, http.server, socketserver, time, json
from playwright.sync_api import sync_playwright
PORT=8207; PUBLIC=os.path.abspath(os.path.join(os.path.dirname(__file__),"..","public"))
OUT="/tmp/aiemail_shots"; os.makedirs(OUT, exist_ok=True)
DESK="/mnt/c/Users/fordg/OneDrive/Desktop"
DRAFT={"id":8,"subscription_id":42,"customer_name":"Rick Lunt","status":"pending",
 "period_label":"2026-05-21 → 2026-06-22","array_total_kwh":108,"allocation_pct":0.25,
 "customer_kwh":27,"amount_usd":5.19,"invoice_number":"2026-06","has_gmp_pdf":False,
 "gmp_filename":None,"note":None,"client_email":"rick@example.com","send_mode":"to_me",
 "include_summary":True,"operator_name":"Dyson Swarm Technologies","auto_attach_gmp":True,
 "gmp_auto_status":"pending","cadence":"monthly","cc_emails":"","discount_pct":0.10,
 "net_rate_per_kwh":None,"utility_account_id":1378,"has_workbook":False,"budget_amount_usd":None,
 "created_at":"2026-06-24T00:00:00","sent_at":None}
ACCTS={"utility_accounts":[{"utility_account_id":1378,"account_number":"5738500000","array_name":"Rutland Yard","nickname":None,"bill_count":3}]}
AI_EMAIL=("Hi Rick,\n\nThank you for your continued partnership during the May 21 - Jun 22, 2026 "
 "billing period. Your amount due is $5.19, and the invoice PDF and a production summary are "
 "attached for your records.\n\nWarm regards,\nDyson Swarm Technologies")
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
    if m=="POST" and "/ai-email" in u:
        rt.fulfill(status=200,content_type="application/json",body=json.dumps({"ok":True,"email":AI_EMAIL})); return
    if m=="PATCH": rt.fulfill(status=200,content_type="application/json",body='{"ok":true}'); return
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
    btn=pg.query_selector('[data-dact="aiemail"]')
    res["buttonPresent"]=bool(btn)
    res["buttonText"]=btn.inner_text() if btn else None
    res["beforeTextarea"]=(pg.eval_on_selector("textarea[data-draftmsg]","e=>e.value") or "")[:60]
    if btn:
        btn.click(); pg.wait_for_timeout(1200)
    res["afterTextarea"]=(pg.eval_on_selector("textarea[data-draftmsg]","e=>e.value") or "")[:120]
    res["filledWithAI"]="continued partnership" in (pg.eval_on_selector("textarea[data-draftmsg]","e=>e.value") or "")
    res["previewHasAI"]="continued partnership" in (pg.inner_text("#rbDraftDocPane") if pg.query_selector("#rbDraftDocPane") else "")
    col=pg.query_selector(".rb-draft")
    if col: col.screenshot(path=os.path.join(OUT,"ai_email_btn.png"))
    try:
        if col and os.path.isdir(DESK): col.screenshot(path=os.path.join(DESK,"ai_email_button.png"))
    except Exception: pass
    b.close()
hd.shutdown()
import sys; print(json.dumps(res,indent=1,ensure_ascii=False), file=sys.stderr)
