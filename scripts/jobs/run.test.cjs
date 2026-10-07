'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Run the real wrapper with in-memory journal files and fake child processes.
// No app/database/network is started, and no production /app files are touched.
function fixture(children, options = {}) {
  const files = new Map();
  const records = [];
  const closed = [];
  const unlinked = [];
  let writes = 0;
  const fakeFs = {
    async mkdir() {},
    async open(filename) {
      assert.equal(files.has(filename), false, 'exclusive lock already exists');
      files.set(filename, '');
      return {
        async writeFile(value) { files.set(filename, value); },
        async close() { closed.push(filename); if (options.closeError) throw new Error('fixture close failed'); }
      };
    },
    async writeFile(filename, value) {
      writes++;
      if (writes === options.failWrite) throw new Error('fixture journal unavailable');
      files.set(filename, value);
    },
    async rename(from, to) {
      assert(files.has(from));
      files.set(to, files.get(from)); files.delete(from);
      records.push(JSON.parse(files.get(to)));
    },
    async unlink(filename) { unlinked.push(filename); files.delete(filename); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8'), {
    module,
    process: { execPath: 'fixture-node', env: {}, cwd: () => '/fixture-app' },
    setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:fs/promises') return fakeFs;
      if (name === 'node:child_process') return {
        spawn() {
          const scenario = children.shift(); assert(scenario, 'unexpected child');
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.kill = () => true;
          setImmediate(() => {
            // Deliberately emit exit before the last pipe bytes, as permitted
            // by Node's child-process API. Only close guarantees full output.
            child.emit('exit', scenario.code, null);
            const output = JSON.stringify(scenario.result);
            const middle = Math.floor(output.length / 2);
            child.stdout.emit('data', output.slice(0, middle));
            child.stdout.emit('data', output.slice(middle));
            if (scenario.stderr) child.stderr.emit('data', scenario.stderr);
            child.emit('close', scenario.code, null);
          });
          return child;
        }
      };
      return require(name);
    }
  }, { filename: 'run.cjs' });
  return { run: module.exports, records, files, closed, unlinked };
}

test('stdout arriving after exit remains available to partial-result classification', async () => {
  const f = fixture([{ code: 0, result: { status: 'partial', skipped: [{ storeSku: 'SHUSHA-L1383' }] } }]);
  await f.run('fixture-source', [['scripts/fixture.cjs', []]]);
  const last = f.records.at(-1);
  assert.equal(last.status, 'attention');
  assert.equal(last.steps[0].result.status, 'partial');
  assert.equal(last.steps[0].result.skipped[0].storeSku, 'SHUSHA-L1383');
  assert.equal(f.closed.length, 1); assert.equal(f.unlinked.length, 1);
});

test('accepted download exit 2 with budget skips requires attention', async () => {
  const f = fixture([{ code: 2, result: { complete: false, skipped: ['https://cdn.suusha.com/pending.webp'], failures: [] } }]);
  await f.run('fixture-budget', [['scripts/fixture.cjs', [], [0, 2]]]);
  assert.equal(f.records.at(-1).status, 'attention');
  assert.equal(f.records.at(-1).steps[0].code, 2);
});

test('known quarantined external hosts do not turn an otherwise complete job into a failure', async () => {
  const f = fixture([{ code: 2, result: { complete: false, skipped: [], failures: [{ reason: 'URL is outside the allowed source hosts' }] } }]);
  await f.run('fixture-quarantine', [['scripts/fixture.cjs', [], [0, 2]]]);
  assert.equal(f.records.at(-1).status, 'completed');
});

test('unaccepted child exit records failure and releases its job lock', async () => {
  const f = fixture([{ code: 1, result: { error: 'fixture failure' } }]);
  await assert.rejects(f.run('fixture-failure', [['scripts/fixture.cjs', []]]), /exited 1/);
  assert.equal(f.records.at(-1).status, 'failed');
  assert.equal(f.closed.length, 1); assert.equal(f.unlinked.length, 1);
  assert.equal([...f.files.keys()].some(filename => filename.endsWith('.lock')), false);
});

test('final journal write failure still closes and unlinks the job lock', async () => {
  const f = fixture([{ code: 0, result: { status: 'applied' } }], { failWrite: 3 });
  await assert.rejects(f.run('fixture-storage', [['scripts/fixture.cjs', []]]), /journal unavailable/);
  assert.equal(f.closed.length, 1); assert.equal(f.unlinked.length, 1);
  assert.equal([...f.files.keys()].some(filename => filename.endsWith('.lock')), false);
});

test('lock close failure still attempts unlink', async () => {
  const f = fixture([{ code: 0, result: { status: 'applied' } }], { closeError: true });
  await assert.rejects(f.run('fixture-close', [['scripts/fixture.cjs', []]]), /close failed/);
  assert.equal(f.closed.length, 1); assert.equal(f.unlinked.length, 1);
});

test('stderr warnings do not hide structured partial results', async () => {
  const f = fixture([{ code: 2, result: { status: 'partial', skipped: ['supplier price unavailable'] }, stderr: 'Configuration warning\n' }]);
  await f.run('fixture-warning', [['scripts/fixture.cjs', [], [0, 2]]]);
  assert.equal(f.records.at(-1).status, 'attention');
  assert.equal(f.records.at(-1).steps[0].result.status, 'partial');
});
