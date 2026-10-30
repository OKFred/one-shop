const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForCanonicalProductUrl, MAX_WAIT_MS, POLL_MS } = require('../lib/material-publication-urls.cjs');
const { verifyStyle } = require('../publish-material-drop.cjs');

const UUID = '00000000-0000-4000-8000-000000000001';
const EXPECTED = { uuid: UUID, requestPath: '/dresses/l9001', sku: 'SHUSHA-L9001' };
const MESSAGE = `Public variant URL differs for ${EXPECTED.sku}`;
const exact = () => ({ entity_uuid: UUID, entity_type: 'product', request_path: EXPECTED.requestPath, target_path: `/product/${UUID}` });
function clock() {
  let time = 0;
  const waits = [];
  return { now: () => time, set: value => { time = value; }, waits, async sleep(ms) { waits.push(ms); time += ms; } };
}
function client(answer) {
  const calls = [];
  return { calls, async query(sql, values) { calls.push({ sql, values }); return answer(calls.length); } };
}

test('exact canonical product ownership and target succeed without waiting or writing', async () => {
  const db = client(() => ({ rows: [exact()] })), timer = clock();
  await waitForCanonicalProductUrl(db, EXPECTED, timer);
  assert.equal(db.calls.length, 1); assert.deepEqual(timer.waits, []);
  assert.match(db.calls[0].sql, /^SELECT /); assert.deepEqual(db.calls[0].values, [UUID, EXPECTED.requestPath]);
});

test('a missing row and an intermediate owned root path must become exactly canonical', async () => {
  const replies = [[], [{ ...exact(), request_path: '/l9001' }], [exact()]];
  const db = client(n => ({ rows: replies[n - 1] })), timer = clock();
  await waitForCanonicalProductUrl(db, EXPECTED, timer);
  assert.equal(db.calls.length, 3); assert.deepEqual(timer.waits, [POLL_MS, POLL_MS]);
  assert(db.calls.every(call => call.sql.startsWith('SELECT ')));
});

test('an owned wrong target waits for the exact target instead of accepting a fallback', async () => {
  const db = client(n => ({ rows: [n === 1 ? { ...exact(), target_path: '/product/another-target' } : exact()] })), timer = clock();
  await waitForCanonicalProductUrl(db, EXPECTED, timer);
  assert.equal(db.calls.length, 2); assert.deepEqual(timer.waits, [POLL_MS]);
});

for (const [name, rows] of [['missing', []], ['root path', [{ ...exact(), request_path: '/l9001' }]], ['wrong target', [{ ...exact(), target_path: '/another-target' }]]]) {
  test(`persistent ${name} times out after the fixed budget with the original verification error`, async () => {
    const db = client(() => ({ rows })), timer = clock();
    await assert.rejects(waitForCanonicalProductUrl(db, EXPECTED, timer), { message: MESSAGE });
    assert.equal(timer.now(), MAX_WAIT_MS); assert.equal(timer.waits.reduce((a, b) => a + b, 0), MAX_WAIT_MS);
    assert.equal(db.calls.length, MAX_WAIT_MS / POLL_MS); assert(db.calls.every(call => call.sql.startsWith('SELECT ')));
  });
}

for (const [name, rows] of [
  ['another owner at the canonical path', [{ ...exact(), entity_uuid: '00000000-0000-4000-8000-000000000002' }]],
  ['a category row', [{ ...exact(), entity_type: 'category' }]],
  ['duplicate exact rows', [exact(), exact()]],
  ['one exact row plus a competing owner', [exact(), { ...exact(), entity_uuid: '00000000-0000-4000-8000-000000000002' }]],
  ['multiple paths for the same entity', [exact(), { ...exact(), request_path: '/l9001' }]]
]) {
  test(`${name} is refused immediately without changing or adopting any row`, async () => {
    const db = client(() => ({ rows })), timer = clock();
    await assert.rejects(waitForCanonicalProductUrl(db, EXPECTED, timer), { message: MESSAGE });
    assert.equal(db.calls.length, 1); assert.deepEqual(timer.waits, []);
  });
}

test('database query errors propagate unchanged and are never treated as route readiness', async () => {
  const failure = new Error('Synthetic query failure'), db = client(() => { throw failure; }), timer = clock();
  await assert.rejects(waitForCanonicalProductUrl(db, EXPECTED, timer), error => error === failure);
  assert.equal(db.calls.length, 1); assert.deepEqual(timer.waits, []);
});

test('a successful response arriving after the wait deadline still fails verification', async () => {
  const timer = clock(), db = client(() => { timer.set(MAX_WAIT_MS + 1); return { rows: [exact()] }; });
  await assert.rejects(waitForCanonicalProductUrl(db, EXPECTED, timer), { message: MESSAGE });
  assert.equal(db.calls.length, 1); assert.deepEqual(timer.waits, []);
});

test('malformed route results do not retry or weaken exact ownership', async () => {
  const db = client(() => ({ rows: null })), timer = clock();
  await assert.rejects(waitForCanonicalProductUrl(db, EXPECTED, timer), { message: MESSAGE });
  assert.equal(db.calls.length, 1); assert.deepEqual(timer.waits, []);
});

test('style verification cannot continue until the native canonical URL is ready', async () => {
  let answerRoute, routeStarted;
  const pending = new Promise(resolve => { answerRoute = resolve; });
  const started = new Promise(resolve => { routeStarted = resolve; });
  const image = '/assets/source-library/synthetic.jpg', calls = [];
  const db = { async query(sql) {
    calls.push(sql); assert.match(sql, /^SELECT /);
    if (sql.startsWith('SELECT p.*,d.url_key')) return { rows: [{ product_id: 1, uuid: UUID, sku: EXPECTED.sku, category_id: 11, variant_group_id: 21, url_key: 'l9001' }] };
    if (sql.startsWith('SELECT sku,visibility')) return { rows: [{ sku: EXPECTED.sku, visibility: true }] };
    if (sql.startsWith('SELECT a.attribute_code')) return { rows: [{ attribute_code: 'shusha_color', option_text: 'Blue' }, { attribute_code: 'shusha_size', option_text: 'M' }] };
    if (sql.startsWith('SELECT * FROM product_image')) return { rows: [{ is_main: true, origin_image: image }] };
    if (sql.startsWith('SELECT request_path,target_path')) { routeStarted(); return pending; }
    if (sql.startsWith('SELECT 1 FROM product_collection')) return { rows: [{}] };
    throw new Error('Unexpected synthetic verification query');
  } };
  const plan = { sourceId: 'L9001', category: 'dresses', variants: [{ storeSku: EXPECTED.sku, storeUrlKey: 'l9001', color: 'Blue', size: 'M', images: [{ assetUrl: image }] }] };
  let completed = false;
  const result = verifyStyle(db, plan, { categories: { dresses: 11 }, collectionId: 13 }, 21).then(value => { completed = true; return value; });
  await started;
  assert.equal(completed, false); assert(!calls.some(sql => sql.startsWith('SELECT 1 FROM product_collection')));
  answerRoute({ rows: [exact()] });
  assert.deepEqual(await result, { sourceId: 'L9001', variants: 1, groupId: 21 });
  assert.equal(completed, true); assert(calls.some(sql => sql.startsWith('SELECT 1 FROM product_collection')));
});
