// DOM unit tests only: all requests and timers are controlled locally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
const src = readFileSync(new URL('../public/reports.js', import.meta.url), 'utf8');
function extract(name) {
  const start = src.search(new RegExp(`^ (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const next = src.slice(start + 1).search(/^ (?:async )?function \w+\(/m);
  const region = next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
  return region.slice(0, region.lastIndexOf('\n }') + 3);
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = data => ({ ok: true, json: async () => data, text: async () => data });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function uiSetup(t) {
  const h = setup(t);
  h.c._syncArchiveEntryPoints = () => {};
  h.c.localStorage = {getItem: () => null};
  h.c.mrRunAudit = options => h.calls.push(options);
  vm.runInContext([
    src.slice(src.indexOf(' let MAIL_VIEW ='), src.indexOf(' function mrNeedsAttention')),
    src.slice(src.indexOf(' let MAIL_SEV_FILTER ='), src.indexOf(' function renderMailAudit')),
    'let _mailSearchTimer = null;',
    ...['mrNeedsAttention','mrViewRows','mrMatches','mrMailCard','renderMailroomPanel','renderMailAudit','mrLoadHistory','wireMailroomPanel'].map(extract),
  ].join('\n'), h.c);
  const host = h.doc.createElement('div'); h.doc.body.append(host);
  h.c.renderArchive = () => { host.innerHTML = h.c.renderMailroomPanel(); h.c.wireMailroomPanel(host); };
  h.render = h.c.renderArchive; h.host = host;
  return h;
}
function setup(t) {
  const dom = new JSDOM('<button id="origin">Invoice</button>'); t.after(() => dom.window.close());
  let timerId = 0; const timers = new Map(), calls = [];
  const c = vm.createContext({ document: dom.window.document, API: '/billing', console,
    authHeaders: () => ({ Authorization: 'test' }), renderArchive() {}, bulkToast() {},
    OFFTAKER_QUERY: 'hidden', OFFTAKER_FILTER: 'unpaid', LAST_LIST_ARGS: [[], [], [], []], ACTIVE_SUB_ID: null,
    renderAccordion() { const card = dom.window.document.createElement('div'); card.className = 'rb-acc'; card.dataset.id = '7'; dom.window.document.body.append(card); },
    expandAccordion: id => calls.push(id), fmt0: String,
    fetch: async () => { throw new Error('Unexpected request'); },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
  });
  const helpers = src.slice(src.indexOf(' const mrMoney ='), src.indexOf(' function mrWhen'));
  const globals = src.slice(src.indexOf(' let MAILROOM ='), src.indexOf(' function loadMailroom'));
  const esc = src.slice(src.indexOf(' const esc ='), src.indexOf(' const money ='));
  vm.runInContext([globals, helpers, esc, ...['apiErr', 'loadMailroom', 'loadMailAudit', 'mrAuditExpired', 'mrRunAudit', 'mrPollAudit',
    'mrOpenOfftaker', 'mrDrawerBuild', 'openMailDrawer', 'mrRenderDrawer', 'mrRow', 'mrWhen', 'mrUtil', 'mrDeliveryChip', 'mrPayChip'].map(extract)].join('\n'), c);
  return { c, doc: dom.window.document, calls, get: expr => vm.runInContext(expr, c), set: expr => vm.runInContext(expr, c),
    tick: async () => { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); }, timers,
    key: (key, shiftKey = false) => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, cancelable: true })) };
}
test('failed refresh retains last successful board and exposes stale state', async t => {
  const h = setup(t); h.set('MAILROOM = {ok:true,sent:[{id:7}]}');
  h.c.fetch = async () => ({ ok: false }); await h.c.loadMailroom(true); await flush();
  assert.equal(h.get('MAILROOM.sent[0].id'), 7); assert.equal(h.get('_mailroomFailed'), true);
  assert.match(h.get('_mailroomError'), /last loaded/);
});
test('audit start is single-flight and older list response cannot replace it', async t => {
  const h = setup(t), old = deferred(), start = deferred(); let posts = 0;
  h.c.fetch = (url, opts) => { if (opts.method === 'POST') { posts++; return start.promise; } return old.promise; };
  const history = h.c.loadMailAudit(), run = h.c.mrRunAudit(); await h.c.mrRunAudit();
  assert.equal(posts, 1); start.resolve(reply({ok:true,run_id:12})); await run;
  old.resolve(reply({latest:{id:1,status:'running'}})); await history;
  assert.equal(h.get('MAIL_AUDIT.id'), 12); assert.equal(h.get('_mailAuditStarting'), false);
});
test('old polling result cannot overwrite a newer run and failed polling stops', async t => {
  const h = setup(t), old = deferred(); h.c.fetch = () => old.promise;
  h.set('MAIL_AUDIT={id:1,status:"running"}'); h.c.mrPollAudit(1); const pending = h.tick();
  h.set('MAIL_AUDIT={id:2,status:"running"}'); h.c.mrPollAudit(2);
  old.resolve(reply({run:{id:1,status:'done'}})); await pending;
  assert.equal(h.get('MAIL_AUDIT.id'), 2);
  h.c.fetch = async () => ({ok:false}); await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.timers.size, 0); assert.match(h.get('_mailAuditError'), /result is unknown/);
});
test('check and deep review use distinct explicit routes', async t => {
  const h = setup(t), urls = [];
  h.c.fetch = async url => { urls.push(url); return reply({ok:true,run_id:3}); };
  await h.c.mrRunAudit({check:true,force:true}); assert.equal(urls[0], '/billing/mailroom/check?force=true');
  h.set('MAIL_AUDIT=null'); await h.c.mrRunAudit(); assert.equal(urls[1], '/billing/mailroom/audit');
});
test('stale running check stops polling and allows another check', async t => {
  const h = setup(t); h.set('MAIL_AUDIT={id:1,status:"running",started_at:new Date(Date.now()-16*60000).toISOString()}');
  h.c.fetch = async (url, opts) => opts.method === 'POST' ? reply({ok:true,run_id:2}) : reply({run:h.get('MAIL_AUDIT')});
  h.c.mrPollAudit(1); await h.tick(); assert.equal(h.timers.size, 0);
  assert.match(h.get('_mailAuditError'), /15 minutes/);
  await h.c.mrRunAudit({check:true}); assert.equal(h.get('MAIL_AUDIT.id'), 2);
});
test('cached older quick check cannot replace newer deep review', async t => {
  const h = setup(t); h.set('MAIL_AUDIT={id:9,status:"done",model:"deep",findings:[{title:"Keep me"}]}');
  h.c.fetch = async () => reply({ok:true,run_id:4,cached:true}); h.c.loadMailroom = async () => null;
  await h.c.mrRunAudit({check:true}); assert.equal(h.get('MAIL_AUDIT.id'), 9);
  assert.equal(h.get('MAIL_AUDIT.findings[0].title'), 'Keep me');
});
test('history requested before a poll update cannot restore its older running state', async t => {
  const h = setup(t), old = deferred();
  h.set('MAIL_AUDIT={id:4,status:"running"}');
  h.c.fetch = url => url.includes('?limit=5') ? old.promise : Promise.resolve(reply({run:{id:4,status:'done',findings:[]}}));
  const history = h.c.loadMailAudit();
  // Isolate the terminal poll from its independent board refresh.
  h.c.loadMailroom = async () => null;
  h.c.mrPollAudit(4); await h.tick();
  old.resolve(reply({latest:{id:4,status:'running'}})); await history;
  assert.equal(h.get('MAIL_AUDIT.status'), 'done');
});
test('slow invoice response never replaces the newer drawer', async t => {
  const h = setup(t), a = deferred(), b = deferred();
  h.c.mrRenderDrawer = inv => h.calls.push(inv.id);
  h.c.fetch = url => url.endsWith('/1') ? a.promise : b.promise;
  const first = h.c.openMailDrawer(1), second = h.c.openMailDrawer(2);
  b.resolve(reply({invoice:{id:2,customer_name:'B'}})); await second;
  a.resolve(reply({invoice:{id:1,customer_name:'A'}})); await first;
  assert.deepEqual(h.calls, [2]); assert.match(h.doc.querySelector('#mrTitle').textContent, /B/);
});
test('missing detail does not masquerade as full invoice and offers retry', async t => {
  const h = setup(t); h.set('MAILROOM={sent:[{id:1,customer_name:"Summary",amount_usd:100}]}');
  h.c.fetch = async () => ({ok:false}); await h.c.openMailDrawer(1);
  assert.match(h.doc.querySelector('#mrLeft').textContent, /details unavailable/);
  assert.ok(h.doc.querySelector('#mrRetry')); assert.equal(h.doc.querySelector('#mrRight').textContent, '');
});
test('old email cannot enter new invoice and billed amount is honest', async t => {
  const h = setup(t), a = deferred(), b = deferred(); h.c.fetch = url => url.includes('/1/') ? a.promise : b.promise;
  const ov = h.c.mrDrawerBuild(), left = ov.querySelector('#mrLeft'), right = ov.querySelector('#mrRight');
  h.c.mrRenderDrawer({id:1,amount_usd:100}, left, right);
  h.c.mrRenderDrawer({id:2,amount_usd:200,payment_summary:'paid',outstanding_usd:0}, left, right);
  b.resolve(reply('EMAIL B')); await flush(); a.resolve(reply('EMAIL A')); await flush();
  assert.equal(left.querySelector('iframe').srcdoc, 'EMAIL B');
  assert.match(right.textContent, /Invoice amount/); assert.doesNotMatch(right.textContent, /Amount due/);
});
test('drawer focuses, traps tab, closes and returns focus; navigation clears filters', async t => {
  const h = setup(t); h.c.fetch = async () => ({ok:false}); const origin = h.doc.querySelector('#origin'); origin.focus();
  await h.c.openMailDrawer(1); const ov = h.doc.querySelector('#mrOverlay');
  assert.equal(ov.getAttribute('role'), 'dialog'); assert.equal(h.doc.activeElement.id, 'mrClose');
  h.doc.querySelector('#mrRetry').focus(); h.key('Tab'); assert.equal(h.doc.activeElement.id, 'mrClose');
  h.key('Escape'); assert.equal(ov.hidden, true); assert.equal(h.doc.activeElement, origin);
  assert.equal(h.c.mrOpenOfftaker(7), true); assert.equal(h.get('OFFTAKER_QUERY'), ''); assert.equal(h.get('OFFTAKER_FILTER'), 'all');
  assert.deepEqual(h.calls, ['7']);
});
test('UI paginates 300 records twelve at a time and keyboard switches views', t => {
  const h = uiSetup(t);
  h.c.board = {sent:[],outgoing:Array.from({length:300},(_,i)=>({subscription_id:i+1,kind:'held',customer_name:`Customer ${i}`})),counts:{}};
  h.set('MAILROOM=board'); h.render();
  const seen = new Set();
  for(let p=0;p<25;p++) {
    const cards = [...h.host.querySelectorAll('[data-mr-sub]')]; assert.equal(cards.length,12);
    cards.forEach(el=>seen.add(el.dataset.mrSub)); if(p<24) h.host.querySelector('[data-mr-page="1"]').click();
  }
  assert.equal(seen.size,300); assert.equal(h.host.querySelector('[data-mr-page="1"]').disabled,true);
  h.host.querySelector('#rbMrTab-attention').onkeydown({key:'End',preventDefault(){}});
  assert.equal(h.get('MAIL_VIEW'),'sent'); assert.equal(h.doc.activeElement.id,'rbMrTab-sent');
  assert.equal(h.host.querySelector('#rbMrResults').getAttribute('aria-labelledby'),'rbMrTab-sent');
});
test('UI escapes search and records and discloses limited history', t => {
  const h = uiSetup(t); h.c.evil = '<img src=x onerror=alert(1)>';
  h.set('MAIL_FILTER=evil; MAIL_VIEW="sent"; MAILROOM={sent:[{id:1,customer_name:evil}],outgoing:[],counts:{sent_total:500,sent_frozen:500}}'); h.render();
  assert.equal(h.host.querySelectorAll('img').length,0); assert.equal(h.host.querySelector('input').value,h.c.evil);
  assert.match(h.host.textContent,/Search covers 1 of 500/);
  assert.equal(h.host.querySelectorAll('[data-mr-inv]').length,1);
});
test('history merges unique records and ignores a stale board response', async t => {
  const h = uiSetup(t); h.set('MAILROOM={sent:[{id:1}],outgoing:[],counts:{sent_frozen:4}}');
  h.c.fetch = async () => reply({ok:true,sent:[{id:1},{id:2},{id:2}]}); await h.c.mrLoadHistory();
  assert.equal(h.get('MAILROOM.sent.length'),2);
  const old=deferred(); h.c.fetch=()=>old.promise; const pending=h.c.mrLoadHistory();
  h.set('MAILROOM={sent:[{id:99}],outgoing:[],counts:{}}'); old.resolve(reply({ok:true,sent:[{id:3}]})); await pending;
  assert.equal(h.get('MAILROOM.sent[0].id'),99); assert.equal(h.get('MAILROOM.sent.length'),1);
});
test('repairs and unresolved findings remain distinct; automatic opening uses rules only once per15minutes', t => {
  const h=uiSetup(t);
  h.set('MAILROOM={sent:[],outgoing:[],counts:{}}; MAIL_AUDIT={id:1,status:"done",stats:{check_mode:"check",repaired_count:1,repairs:[{status:"repaired",reason:"Recovered send"}]},findings:[{severity:"high",title:"Still needs review"}]}; _mailroomOpen=true');
  h.render(); assert.match(h.host.textContent,/1 issue automatically fixed/); assert.match(h.host.textContent,/1 finding need review/);
  assert.match(h.host.textContent,/Still needs review/); assert.match(h.host.textContent,/Recovered send/);
  assert.equal(h.calls.length,1); assert.equal(h.calls[0].check,true); assert.equal(h.calls[0].force,false);
  h.render(); assert.equal(h.calls.length,1);
  h.set('_mailCheckRequestedAt=Date.now()-16*60000'); h.render(); assert.equal(h.calls.length,2);
});
