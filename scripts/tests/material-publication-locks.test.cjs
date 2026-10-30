const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { acquirePublicationLocks, releasePublicationLocks, cleanupPublicationLocks, hasPublicationLocks, MAX_WAIT_MS, CONTENTION_MESSAGE } = require('../lib/material-publication-locks.cjs');
const { failIncompletePublicationSlot } = require('../publish-material-drop.cjs');

const NAMES = ['shusha-material-publication-v1', 'shusha-source-price-sync-v1'];
const OPTIONS = { operation: 'publish-next', action: 'apply', slot: '2030-01-04' };
function clock() {
  let time = 0;
  const waits = [];
  return { now: () => time, set: value => { time = value; }, waits, async sleep(ms) { waits.push(ms); time += ms; } };
}
function client(tryLock = () => true, unlock = () => {}) {
  const calls = [], releases = [];
  return { calls, releases, release(error) { releases.push(error); }, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: await tryLock(values[0]) }] };
    if (sql.includes('pg_advisory_unlock')) { await unlock(values[0]); return { rows: [{ pg_advisory_unlock: true }] }; }
    if (sql.includes('to_regclass')) return { rows: [{ name: 'synthetic_slot_table' }] };
    if (sql.startsWith('UPDATE shusha_material_slot')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  } };
}
const tries = db => db.calls.filter(x => x.sql.includes('pg_try_advisory_lock')).map(x => x.values[0]);
const unlocks = db => db.calls.filter(x => x.sql.includes('pg_advisory_unlock')).map(x => x.values[0]);
const businessQueries = db => db.calls.filter(x => !x.sql.includes('pg_try_advisory_lock') && !x.sql.includes('pg_advisory_unlock'));

test('uncontended locks retain their original names and order before the publisher can proceed', async () => {
  const db = client(), held = [], timer = clock(); let publisherCalls = 0;
  await acquirePublicationLocks(db, NAMES, held, timer);
  assert(hasPublicationLocks(NAMES, held)); publisherCalls++;
  assert.deepEqual(tries(db), NAMES); assert.equal(publisherCalls, 1); assert.deepEqual(timer.waits, []);
});

test('transient first-lock contention waits, then acquires the original ordered pair once', async () => {
  const timer = clock(), held = []; let attempts = 0;
  const db = client(name => name !== NAMES[0] || ++attempts > 2);
  await acquirePublicationLocks(db, NAMES, held, timer);
  assert.deepEqual(tries(db), [NAMES[0], NAMES[0], NAMES[0], NAMES[1]]);
  assert.deepEqual(timer.waits, [250, 250]); assert.deepEqual(held, NAMES);
  assert.deepEqual(businessQueries(db), []);
});

test('transient second-lock contention retains the acquired prefix without reacquiring it', async () => {
  const timer = clock(), held = []; let second = 0;
  const db = client(name => name === NAMES[0] || ++second > 2);
  await acquirePublicationLocks(db, NAMES, held, timer);
  assert.deepEqual(tries(db), [NAMES[0], NAMES[1], NAMES[1], NAMES[1]]);
  await releasePublicationLocks(db, held); await releasePublicationLocks(db, held);
  assert.deepEqual(unlocks(db), [...NAMES].reverse()); assert.deepEqual(held, []);
});

test('the publisher remains blocked while the second lock query is still pending', async () => {
  let answerSecond, publisherCalls = 0;
  const pending = new Promise(resolve => { answerSecond = resolve; }), held = [];
  const db = client(name => name === NAMES[0] ? true : pending);
  const complete = acquirePublicationLocks(db, NAMES, held, clock()).then(() => { publisherCalls++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(held, [NAMES[0]]); assert.equal(publisherCalls, 0); assert.deepEqual(businessQueries(db), []);
  answerSecond(true); await complete; assert.deepEqual(held, NAMES); assert.equal(publisherCalls, 1);
});

test('the complete lock set shares one 30-second deadline and never spends another budget on the second lock', async () => {
  const timer = clock(), held = [];
  const db = client(name => { timer.set(name === NAMES[0] ? 20000 : 29995); return name === NAMES[0]; });
  await assert.rejects(acquirePublicationLocks(db, NAMES, held, timer), { message: CONTENTION_MESSAGE });
  assert.equal(timer.now(), MAX_WAIT_MS); assert.deepEqual(timer.waits, [5]);
  assert.deepEqual(held, [NAMES[0]]); assert.deepEqual(tries(db), NAMES);
  await failIncompletePublicationSlot(db, OPTIONS, held);
  assert.deepEqual(businessQueries(db), []);
  await releasePublicationLocks(db, held); assert.deepEqual(unlocks(db), [NAMES[0]]);
});

test('persistent first-lock contention stops at the deadline with no slot queries or business writes', async () => {
  const timer = clock(), held = [], db = client(() => false); let publisherCalls = 0;
  try { await acquirePublicationLocks(db, NAMES, held, timer); publisherCalls++; }
  catch (error) { assert.equal(error.message, CONTENTION_MESSAGE); await failIncompletePublicationSlot(db, OPTIONS, held); }
  assert.equal(timer.now(), 30000); assert.equal(timer.waits.reduce((a, b) => a + b, 0), 30000);
  assert.equal(publisherCalls, 0); assert.equal(tries(db).length, 120);
  assert.deepEqual(held, []); assert.deepEqual(businessQueries(db), []);
});

test('a lock response arriving after the deadline is tracked for cleanup but never permits publication', async () => {
  const timer = clock(), held = []; let publisherCalls = 0;
  const db = client(() => { timer.set(30001); return true; });
  await assert.rejects(async () => { await acquirePublicationLocks(db, NAMES, held, timer); publisherCalls++; }, { message: CONTENTION_MESSAGE });
  assert.equal(publisherCalls, 0); assert.deepEqual(held, [NAMES[0]]);
  await failIncompletePublicationSlot(db, OPTIONS, held); assert.deepEqual(businessQueries(db), []);
  await releasePublicationLocks(db, held); assert.deepEqual(unlocks(db), [NAMES[0]]);
});

test('a late successful second lock still cannot mark an existing incomplete slot failed', async () => {
  const timer = clock(), held = [];
  const db = client(name => { if (name === NAMES[1]) timer.set(30001); return true; });
  await assert.rejects(acquirePublicationLocks(db, NAMES, held, timer), { message: CONTENTION_MESSAGE });
  assert.deepEqual(held, NAMES);
  await failIncompletePublicationSlot(db, OPTIONS, held, false); assert.deepEqual(businessQueries(db), []);
  await releasePublicationLocks(db, held); assert.deepEqual(unlocks(db), [...NAMES].reverse());
});

test('lock query errors preserve their identity and only release an actually acquired prefix', async () => {
  for (const failingName of NAMES) {
    const problem = new Error('Synthetic lock connection error'), held = [], timer = clock();
    const db = client(name => { if (name === failingName) throw problem; return true; });
    await assert.rejects(acquirePublicationLocks(db, NAMES, held, timer), error => error === problem);
    await failIncompletePublicationSlot(db, OPTIONS, held); assert.deepEqual(businessQueries(db), []);
    await releasePublicationLocks(db, held);
    assert.deepEqual(unlocks(db), failingName === NAMES[0] ? [] : [NAMES[0]]); assert.deepEqual(timer.waits, []);
  }
});

test('malformed lock results stop instead of being treated as successful ownership', async () => {
  for (const result of [null, 'true', 'false', 1, undefined]) {
    const db = client(() => result), held = [];
    await assert.rejects(acquirePublicationLocks(db, NAMES, held, clock()), /Invalid publication advisory lock result/);
    assert.deepEqual(held, []);
  }
});

test('a pre-existing tracking prefix is rejected without issuing any lock query', async () => {
  const db = client(); await assert.rejects(acquirePublicationLocks(db, NAMES, [NAMES[0]], clock()), /tracking must start empty/);
  assert.deepEqual(db.calls, []);
});

test('failed-slot handling is unavailable until the exact complete lock set belongs to this invocation', async () => {
  for (const held of [[], [NAMES[0]], [NAMES[1]], [...NAMES].reverse(), [NAMES[0], NAMES[0]]]) {
    const db = client(); await failIncompletePublicationSlot(db, OPTIONS, held, true); assert.deepEqual(db.calls, []);
  }
  for (const changed of [{ action: 'verify' }, { action: 'dry-run' }, { operation: 'prepare-existing' }]) {
    const db = client(); await failIncompletePublicationSlot(db, { ...OPTIONS, ...changed }, [...NAMES], true); assert.deepEqual(db.calls, []);
  }
  const db = client(); await failIncompletePublicationSlot(db, OPTIONS, [...NAMES]); assert.deepEqual(db.calls, []);
});

test('all-locks-held apply failures retain the existing incomplete-only slot predicate', async () => {
  const db = client(); await failIncompletePublicationSlot(db, OPTIONS, [...NAMES], true);
  assert.equal(db.calls.length, 2); assert(db.calls[0].sql.includes('to_regclass'));
  assert.match(db.calls[1].sql, /WHERE slot=\$1 AND status<>'complete'/); assert.deepEqual(db.calls[1].values, [OPTIONS.slot]);
});

test('cleanup releases each owned lock once in reverse order and preserves a timeout over cleanup errors', async () => {
  const cleanupError = new Error('Synthetic unlock error'), primary = new Error(CONTENTION_MESSAGE), held = [...NAMES], db = client(() => true, name => { if (name === NAMES[1]) throw cleanupError; }); let poolEnds = 0;
  await cleanupPublicationLocks(db, held, { async end() { poolEnds++; throw new Error('Synthetic pool close error'); } }, primary);
  assert.deepEqual(unlocks(db), [...NAMES].reverse()); assert.deepEqual(held, []);
  assert.deepEqual(db.releases, [cleanupError]); assert.equal(poolEnds, 1); assert.equal(primary.message, CONTENTION_MESSAGE);
  await releasePublicationLocks(db, held); assert.deepEqual(unlocks(db), [...NAMES].reverse());
});

test('cleanup without a publication error reports the original cleanup failure after closing resources', async () => {
  const problem = new Error('Synthetic unlock failure'), db = client(() => true, () => { throw problem; }); let closed = false;
  await assert.rejects(cleanupPublicationLocks(db, [...NAMES], { async end() { closed = true; } }), error => error === problem);
  assert(closed); assert.deepEqual(db.releases, [problem]);
});

test('the production seam awaits the complete lock set before selection, journals or publisher writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../publish-material-drop.cjs'), 'utf8');
  const execute = source.slice(source.indexOf('async function executePublication(options)'), source.indexOf('async function main()'));
  const acquired = execute.indexOf('await acquirePublicationLocks(client, LOCKS, locks);');
  assert(acquired >= 0);
  for (const statement of ['await selectPlans(', 'await atomicJson(', 'await createLedger(']) assert(execute.indexOf(statement) > acquired);
  assert.match(execute, /await acquirePublicationLocks\(client, LOCKS, locks\);\s+locksReady = true;/);
  assert.match(execute, /publicationError = error;[\s\S]+await failIncompletePublicationSlot\(client, options, locks, locksReady\);/);
  assert.match(execute, /finally \{\s+await cleanupPublicationLocks\(client, locks, pool, publicationError\);/);
});

test('publisher lock names and order remain compatible with the existing catalog reader and price writer', () => {
  const publisher = fs.readFileSync(path.join(__dirname, '../publish-material-drop.cjs'), 'utf8');
  const names = JSON.parse(publisher.match(/const LOCKS = (\[[^\n]+\]);/)[1].replace(/'/g, '"'));
  assert.deepEqual(names, NAMES);
  for (const filename of ['../../extensions/shopify-bridge/src/services/catalog.js', '../shusha-sync-prices.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.match(source, /for \(const (?:name|key) of \['shusha-material-publication-v1', 'shusha-source-price-sync-v1'\]\)/);
  }
});
