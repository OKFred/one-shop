import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyProcessArgs, inspectRuntimeProcesses } from '../../deployment/runtime-processes.mjs';

test('runtime classification uses separate executable argv tokens, ignoring inline script mentions', () => {
  assert.equal(classifyProcessArgs(['/usr/local/bin/node', '/app/packages/evershop/dist/lib/cronjob/cronjob.js']), 'cronjob');
  assert.equal(classifyProcessArgs(['/usr/local/bin/node', '/app/packages/evershop/dist/lib/event/event-manager.js']), 'eventManager');
  assert.equal(classifyProcessArgs(['/usr/local/bin/node', '-e', 'console.log("/app/lib/cronjob/cronjob.js")']), null);
  assert.equal(classifyProcessArgs(['/bin/sh', '/app/lib/cronjob/cronjob.js']), null);
  assert.equal(classifyProcessArgs(['/usr/local/bin/node', '/app/lib/cronjob/cronjob.js.backup']), null);
});

test('runtime verification requires exactly one cron and one event manager in the container PID namespace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-process-synthetic-'));
  try {
    async function processFile(pid, file) {
      await fs.mkdir(path.join(root, String(pid)), { recursive: true });
      await fs.writeFile(path.join(root, String(pid), 'cmdline'), `/usr/local/bin/node\0${file}\0`);
    }
    await processFile(10, '/app/dist/lib/cronjob/cronjob.js');
    await processFile(11, '/app/dist/lib/event/event-manager.js');
    await processFile(12, 'console.log("/app/lib/cronjob/cronjob.js")');
    assert.deepEqual(await inspectRuntimeProcesses(root), { status: 'verified', counts: { cronjob: 1, eventManager: 1, unreadable: 0 } });
    await processFile(13, '/app/dist/lib/cronjob/cronjob.js');
    assert.equal((await inspectRuntimeProcesses(root)).status, 'mismatch');
    await fs.unlink(path.join(root, '11/cmdline'));
    assert.equal((await inspectRuntimeProcesses(root)).counts.eventManager, 0);
  } finally {
    const resolved = await fs.realpath(root);
    assert(resolved.startsWith(await fs.realpath(os.tmpdir())) && path.basename(resolved).startsWith('shusha-process-synthetic-'));
    await fs.rm(resolved, { recursive: true });
  }
});
