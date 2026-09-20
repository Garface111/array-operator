/** DOM-only tests. No browser or real network. Run with node --test.
 * Resolve jsdom locally, or supply NODE_PATH to an existing node_modules.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(new URL('../public/reports.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^ (?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `production function ${name} must exist`);
  const next = source.slice(start + 1).search(/^ (?:async )?function \w+\(/m);
  const region = next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
  const end = region.lastIndexOf('\n }');
  assert.ok(end >= 0, `production function ${name} must end`);
  return region.slice(0, end + 3);
}
const state = source.slice(source.indexOf(' let HOLD_PAGE ='), source.indexOf(' function holdPeriodLabel'));
const escapeHelper = source.slice(source.indexOf(' const esc ='), source.indexOf(' const money ='));
// Exercise the actual list-loading prelude, including names and holds refresh.
// The unrelated remainder of the large accordion is outside this unit's scope.
const list = extract('renderAccordion');
const boundary = list.indexOf(' const stillOpen =');
assert.ok(boundary > 0);
const prelude = list.slice(0, boundary).replace('function renderAccordion(', 'function indexArrivingList(') + '\n }';
function harness() {
  const dom = new JSDOM('<div id="rbDeliveryHolds"></div><div id="rbList"></div>');
  const calls = { fetch: [], open: [], accordion: [], mailroom: [], reload: 0 };
  const c = vm.createContext({ document: dom.window.document, console,
    PIPE: { holds: [], dispatch_holds: [] }, OFFTAKERS: [], INBOX_DRAFTS: [], DRAFT_BY_SUB: {}, ACC_ARRS: [],
    OFFTAKER_QUERY: 'filtered', OFFTAKER_FILTER: 'other', LAST_LIST_ARGS: [[], [], [], []], ACTIVE_SUB_ID: null,
    API: 'https://api.invalid/billing', moneyFmt: n => '$' + Number(n).toFixed(2),
    $: s => dom.window.document.querySelector(s), parkTpl() {}, jsonHdr: () => ({ 'Content-Type': 'application/json' }),
    mrOpenOfftaker: id => calls.open.push(id), renderAccordion: (...a) => calls.accordion.push(a),
    toggleArchivePanel: p => calls.mailroom.push(p),
    fetch: async () => { throw new Error('Unexpected unstubbed request'); },
    loadPipeline: async () => { calls.reload++; }, renderPipeline() {},
  });
  vm.runInContext([escapeHelper, state, extract('apiErr'), extract('holdPeriodLabel'), extract('renderDeliveryHolds'),
    extract('_draftNewer'), extract('_indexInbox'), prelude].join('\n'), c);
  return { c, calls, host: dom.window.document.getElementById('rbDeliveryHolds'), document: dom.window.document,
    render: () => c.renderDeliveryHolds(), index: subs => c.indexArrivingList(subs, [], [], []), close: () => dom.window.close() };
}
const holds = n => Array.from({ length: n }, (_, i) => ({ invoice_id: 5000 + i, subscription_id: 1235 + i,
  period: '2026-09', status: 'held', amount_cents: 12000 + i, reason: `Reason ${i + 1}` }));
const email = { id: 81, kind: 'invoice', status: 'uncertain', attempts: 1, reason: 'Provider response interrupted' };
const rows = h => [...h.host.querySelectorAll('tbody tr')];
const next = h => h.host.querySelector('[data-hold-page="next"]');
const previous = h => h.host.querySelector('[data-hold-page="previous"]');

for (const count of [9, 300]) test(`${count} invoices paginate six at a time without losing entries`, t => {
  const h = harness(); t.after(h.close); h.c.PIPE.holds = holds(count); h.render();
  assert.equal(rows(h).length, 6); assert.equal(previous(h).disabled, true);
  const seen = [];
  for (let page = 0; page < Math.ceil(count / 6); page++) {
    seen.push(...rows(h).map(r => r.querySelector('.rb-attention-reason').textContent));
    assert.ok(rows(h).length <= 6);
    if (page < Math.ceil(count / 6) - 1) { assert.equal(next(h).disabled, false); next(h).click(); }
  }
  assert.equal(seen.length, count); assert.equal(new Set(seen).size, count);
  assert.equal(next(h).disabled, true); assert.equal(rows(h).length, count % 6 || 6);
  previous(h).click(); assert.equal(rows(h).length, 6);
  assert.equal(h.document.activeElement.id, 'rbAttentionTitle');
  h.c.PIPE.holds = holds(1); h.render();
  assert.equal(rows(h).length, 1, 'shrinking queues clamp the selected page'); assert.equal(next(h), null);
  h.c.PIPE.holds = []; h.render();
  assert.equal(h.host.hidden, true); assert.equal(h.host.innerHTML, '');
});

test('held placeholder, confirmed zero, missing and nonfinite amounts differ', t => {
  const h = harness(); t.after(h.close);
  h.c.PIPE.holds = [
    { ...holds(1)[0], amount_cents: 0 }, { ...holds(1)[0], status: 'prepared', amount_cents: 0 },
    { ...holds(1)[0], amount_cents: null }, { ...holds(1)[0], amount_cents: undefined },
    { ...holds(1)[0], amount_cents: 'not-a-number' }, { ...holds(1)[0], amount_cents: 12345 },
  ]; h.render();
  assert.deepEqual(rows(h).map(r => r.querySelector('[data-label="Amount"]').textContent),
    ['Not confirmed', '$0.00', 'Not confirmed', 'Not confirmed', 'Not confirmed', '$123.45']);
});

test('pipeline-first load gains late names including disabled subscriptions', t => {
  const h = harness(); t.after(h.close); h.c.PIPE.holds = holds(2); h.render();
  assert.match(rows(h)[0].textContent, /Offtaker #1235/);
  h.index([{ id: 1235, customer_name: 'Alice Solar', enabled: true }, { id: 1236, customer_name: 'Archived Customer', enabled: false }]);
  assert.match(rows(h)[0].textContent, /Alice Solar/); assert.match(rows(h)[1].textContent, /Archived Customer/);
  assert.equal(rows(h)[1].querySelector('[data-hold-sub]'), null);
  assert.equal(h.c.OFFTAKERS.length, 1);
  h.index([{ id: 1235, customer_name: 'Alice Renamed', enabled: false }]);
  assert.match(h.host.textContent, /Alice Renamed/, 'empty active list still refreshes labels');
});

test('list-first load resolves names on the first pipeline paint', t => {
  const h = harness(); t.after(h.close); h.index([{ id: 1235, customer_name: 'First Customer', enabled: true }]);
  h.c.PIPE.holds = holds(1); h.render();
  assert.match(h.host.textContent, /First Customer/); assert.doesNotMatch(h.host.textContent, /Offtaker #1235/);
});

test('untrusted names, periods, statuses and reasons remain text', t => {
  const h = harness(); t.after(h.close); const markup = '<img src="invalid"><script>invalid</script>';
  h.index([{ id: 1235, customer_name: markup, enabled: true }]);
  h.c.PIPE = { holds: [{ ...holds(1)[0], period: markup, status: markup, reason: markup }], dispatch_holds: [{ ...email, reason: markup }] };
  h.render(); assert.equal(h.host.querySelectorAll('img,script').length, 0);
  assert.equal(h.host.querySelector('.rb-attention-person-link').getAttribute('aria-label'), 'Review ' + markup);
  assert.equal(h.host.querySelector('.rb-attention-reason').textContent, markup);
  assert.match(h.host.textContent, /Needs review/);
});

test('invoice and email counts are separate and acceptance is not payment', t => {
  const h = harness(); t.after(h.close);
  h.c.PIPE = { holds: holds(9), dispatch_holds: [email, { ...email, id: 82, kind: 'monthly_report' }] }; h.render();
  assert.equal(h.host.querySelector('.rb-attention-count').textContent, '9 invoices');
  assert.match(h.host.querySelector('.rb-attention-emails h4').textContent, /\(2\)/);
  assert.match(h.host.textContent, /not inbox delivery or payment/); assert.doesNotMatch(h.host.textContent, /11 invoices/);
  h.c.PIPE.holds = []; h.render(); assert.equal(h.host.querySelector('.rb-attention-count').textContent, '2 email checks');
  h.host.querySelector('[data-hold-mailroom]').click(); assert.deepEqual(h.calls.mailroom, ['mailroom']);
  assert.equal(h.calls.fetch.length, 0);
});

test('known link clears filters and uses existing offtaker navigation', t => {
  const h = harness(); t.after(h.close); h.index([{ id: 1235, customer_name: 'Hidden Customer', enabled: true }]);
  h.c.PIPE.holds = holds(1); h.render(); h.host.querySelector('[data-hold-sub]').click();
  assert.equal(h.c.OFFTAKER_QUERY, ''); assert.equal(h.c.OFFTAKER_FILTER, 'all');
  assert.equal(h.c.ACTIVE_SUB_ID, '1235'); assert.equal(h.calls.accordion.length, 1);
  assert.deepEqual(h.calls.open, ['1235']); assert.equal(h.calls.fetch.length, 0);
});

test('typed receipt survives paging and late customer-name refresh', t => {
  const h = harness(); t.after(h.close); h.c.PIPE = { holds: holds(9), dispatch_holds: [email] }; h.render();
  h.host.querySelector('[name="receipt"]').value = 'receipt-not-submitted';
  next(h).click(); h.index([{ id: 1235, customer_name: 'Arrived Later', enabled: true }]);
  assert.equal(h.host.querySelector('[name="receipt"]').value, 'receipt-not-submitted'); assert.equal(h.calls.fetch.length, 0);
});

test('receipt failure renders server text safely without claiming acceptance', async t => {
  const h = harness(); t.after(h.close); h.c.PIPE.dispatch_holds = [email]; h.render();
  h.c.fetch = async (...args) => { h.calls.fetch.push(args); return { ok: false, json: async () => ({ detail: '<b>Receipt does not match</b>' }) }; };
  const form = h.host.querySelector('form'); form.querySelector('input').value = ' receipt-81 ';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(form.querySelector('[role="status"]').textContent, '<b>Receipt does not match</b>');
  assert.equal(form.querySelector('[role="status"] b'), null); assert.equal(form.querySelector('button').disabled, false);
  assert.equal(h.calls.reload, 0); assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0][0], 'https://api.invalid/billing/dispatches/81/reconcile');
  assert.equal(h.calls.fetch[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(h.calls.fetch[0][1].body), { receipt_id: 'receipt-81' });
  assert.doesNotMatch(h.host.textContent, /acceptance verified|Paid|Delivered/);
});

test('successful receipt refreshes provider state without claiming paid or delivered', async t => {
  const h = harness(); t.after(h.close); h.c.PIPE.dispatch_holds = [email]; h.render();
  h.c.fetch = async (...args) => { h.calls.fetch.push(args); return { ok: true, json: async () => ({ ok: true }) }; };
  const form = h.host.querySelector('form'); form.querySelector('input').value = 'provider-receipt';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(form.querySelector('[role="status"]').textContent, 'Provider acceptance verified.');
  assert.equal(h.calls.reload, 1); assert.equal(h.calls.fetch.length, 1);
  assert.doesNotMatch(h.host.textContent, /Paid|Delivered|payment received/i);
});

for (const [detail, expected] of [
  [{ message: 'Receipt belongs to another request' }, 'Receipt belongs to another request'],
  [[{ msg: 'Invalid receipt format' }, { msg: 'Receipt required' }], 'Invalid receipt format; Receipt required'],
]) test(`structured receipt error is readable: ${expected}`, async t => {
  const h = harness(); t.after(h.close); h.c.PIPE.dispatch_holds = [email]; h.render();
  h.c.fetch = async () => ({ ok: false, json: async () => ({ detail }) });
  const form = h.host.querySelector('form'); form.querySelector('input').value = 'receipt';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(form.querySelector('[role="status"]').textContent, expected);
  assert.equal(h.calls.reload, 0);
});

for (const ok of [false, true]) test(`pending receipt survives redraw and prevents duplicates (${ok ? 'success' : 'failure'})`, async t => {
  const h = harness(); t.after(h.close);
  h.c.PIPE = { holds: holds(9), dispatch_holds: [email] }; h.render();
  let complete;
  h.c.fetch = (...args) => { h.calls.fetch.push(args); return new Promise(resolve => { complete = resolve; }); };
  const oldForm = h.host.querySelector('form'); oldForm.querySelector('input').value = 'pending-receipt';
  const pending = oldForm.onsubmit({ preventDefault() {} });
  next(h).click(); h.index([{ id: 1235, customer_name: 'Late Name', enabled: true }]);
  const liveForm = h.host.querySelector('form'); assert.notEqual(liveForm, oldForm);
  assert.equal(liveForm.querySelector('input').value, 'pending-receipt');
  assert.equal(liveForm.querySelector('button').disabled, true);
  assert.equal(liveForm.querySelector('[role="status"]').textContent, 'Verifying…');
  await liveForm.onsubmit({ preventDefault() {} });
  assert.equal(h.calls.fetch.length, 1, 'redraw must not allow a duplicate verification');
  complete({ ok, json: async () => ok ? ({ ok: true }) : ({ detail: { message: 'Receipt mismatch' } }) });
  await pending;
  assert.equal(liveForm.querySelector('button').disabled, false);
  const expected = ok ? 'Provider acceptance verified.' : 'Receipt mismatch';
  assert.equal(liveForm.querySelector('[role="status"]').textContent, expected);
  h.render(); assert.equal(h.host.querySelector('[role="status"]').textContent, expected);
  assert.equal(h.calls.reload, ok ? 1 : 0);
});
