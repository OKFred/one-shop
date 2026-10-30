'use strict';

const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_WAIT_MS = 30000;
const POLL_MS = 250;
const CONTENTION_MESSAGE = 'Another catalog publication or source price sync is running; no records changed';

function hasPublicationLocks(names, held) {
  return held.length === names.length && names.every((name, index) => held[index] === name);
}

// Keep one deadline for the complete ordered lock set, including a partial prefix.
// Only successful acquisitions enter held; the caller owns their final cleanup.
async function acquirePublicationLocks(client, names, held, { now = () => performance.now(), sleep = delay } = {}) {
  if (held.length !== 0) throw new Error('Publication lock tracking must start empty');
  const deadline = now() + MAX_WAIT_MS;
  for (const name of names) {
    for (;;) {
      if (now() >= deadline) throw new Error(CONTENTION_MESSAGE);
      const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [name]);
      const locked = result.rows?.[0]?.locked;
      if (typeof locked !== 'boolean') throw new Error('Invalid publication advisory lock result; no records changed');
      if (locked) {
        held.push(name);
        if (now() > deadline) throw new Error(CONTENTION_MESSAGE);
        break;
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error(CONTENTION_MESSAGE);
      await sleep(Math.min(POLL_MS, remaining));
    }
  }
}

async function releasePublicationLocks(client, held) {
  let firstError;
  for (const name of held.splice(0).reverse()) {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); }
    catch (error) { firstError ||= error; }
  }
  if (firstError) throw firstError;
}

async function cleanupPublicationLocks(client, held, pool, publicationError) {
  let cleanupError;
  if (client) {
    try { await releasePublicationLocks(client, held); } catch (error) { cleanupError = error; }
    // Discard only our session if an unlock failed, instead of pooling its locks.
    try { client.release(cleanupError); } catch (error) { cleanupError ||= error; }
  }
  try { await pool.end(); } catch (error) { cleanupError ||= error; }
  if (cleanupError && !publicationError) throw cleanupError;
}

module.exports = { acquirePublicationLocks, releasePublicationLocks, cleanupPublicationLocks, hasPublicationLocks, MAX_WAIT_MS, CONTENTION_MESSAGE };
