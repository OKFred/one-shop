import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerShushaJobs } from '../src/services/registerJobs.js';

const definitions = [
  { name: 'source-sync', resolve: 'scripts/jobs/source-sync.js', schedule: '0 9 * * *', enabled: true },
  { name: 'material-drop', resolve: 'scripts/jobs/material-drop.js', schedule: '0 10 * * 2,5', enabled: true }
];
const harness = jobs => {
  const registered = [];
  return { registered, args: { getConfig: (key, fallback) => key === 'system.jobs' ? jobs ?? fallback : fallback, registerJob: job => registered.push(job), appDir: process.cwd(), timezone: 'Asia/Shanghai' } };
};

test('approved jobs resolve to shipped ESM entry points on their agreed schedules', () => {
  const { registered, args } = harness(definitions);
  assert.deepEqual(registerShushaJobs(args), ['source-sync', 'material-drop']);
  assert.deepEqual(registered, definitions.map(job => ({ ...job, resolve: path.resolve(job.resolve) })));
});
test('candidate or disabled workers do not register', () => {
  for (const jobs of [[], undefined, definitions.map(job => ({ ...job, enabled: false }))]) {
    const { registered, args } = harness(jobs);
    assert.deepEqual(registerShushaJobs({ ...args, timezone: 'UTC' }), []);
    assert.deepEqual(registered, []);
  }
});
test('path, schedule, unknown name, duplicates and malformed flags fail before registration', () => {
  const invalid = [
    [{ ...definitions[0], resolve: '../private/worker.js' }],
    [{ ...definitions[0], schedule: '* * * * *' }],
    [{ ...definitions[0], name: 'arbitrary-worker' }],
    [definitions[0], definitions[0]],
    [{ ...definitions[0], enabled: 'true' }],
    [definitions[0], { ...definitions[1], timezone: 'UTC' }],
    { name: 'source-sync' }
  ];
  for (const jobs of invalid) {
    const { registered, args } = harness(jobs);
    assert.throws(() => registerShushaJobs(args), /SHUSHA/);
    assert.deepEqual(registered, []);
  }
});
test('enabled schedules require the scheduler process Shanghai timezone', () => {
  const { registered, args } = harness(definitions);
  assert.throws(() => registerShushaJobs({ ...args, timezone: 'UTC' }), /TZ=Asia\/Shanghai/);
  assert.deepEqual(registered, []);
});
