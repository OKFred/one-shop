#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function classifyProcessArgs(args) {
  if (path.posix.basename(args[0] || '') !== 'node') return null;
  // Inspect actual argv tokens. An inline JavaScript string mentioning a child
  // path is never mistaken for a separately running child executable.
  const files = args.slice(1).filter(argument => argument.startsWith('/') && !argument.includes('\n'));
  if (files.some(filename => filename.endsWith('/lib/cronjob/cronjob.js'))) return 'cronjob';
  if (files.some(filename => filename.endsWith('/lib/event/event-manager.js'))) return 'eventManager';
  return null;
}

export async function inspectRuntimeProcesses(proc = '/proc') {
  const counts = { cronjob: 0, eventManager: 0, unreadable: 0 };
  for (const name of await fs.readdir(proc)) {
    if (!/^\d+$/.test(name)) continue;
    let bytes;
    try { bytes = await fs.readFile(path.join(proc, name, 'cmdline')); }
    catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) counts.unreadable++;
      continue;
    }
    const type = classifyProcessArgs(bytes.toString('utf8').split('\0').filter(Boolean));
    if (type) counts[type]++;
  }
  return { status: counts.cronjob === 1 && counts.eventManager === 1 && counts.unreadable === 0 ? 'verified' : 'mismatch', counts };
}

async function main() {
  const result = await inspectRuntimeProcesses();
  console.log(JSON.stringify(result));
  if (result.status !== 'verified') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => {
  console.error(JSON.stringify({ status: 'runtime-process-verification-failed', detailsWithheld: true }));
  process.exitCode = 1;
});
