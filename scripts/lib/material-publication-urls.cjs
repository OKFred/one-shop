'use strict';

const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_WAIT_MS = 5000;
const POLL_MS = 100;

// Native URL subscribers can expose an intermediate owned path. Only the exact
// canonical row is ready; never repair a route or accept another entity's row.
async function waitForCanonicalProductUrl(client, { uuid, requestPath, sku }, { now = () => performance.now(), sleep = delay } = {}) {
  const error = new Error(`Public variant URL differs for ${sku}`);
  const deadline = now() + MAX_WAIT_MS;
  for (;;) {
    if (now() >= deadline) throw error;
    const result = await client.query(
      'SELECT request_path,target_path,entity_uuid::text AS entity_uuid,entity_type FROM url_rewrite WHERE entity_uuid=$1 OR request_path=$2',
      [uuid, requestPath]
    );
    const rows = result.rows;
    // entity_uuid is unique in native v2.2.1. Duplicates or another entity at
    // the canonical path need review, not a readiness retry or a fallback URL.
    if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => row.entity_uuid !== uuid || row.entity_type !== 'product')) throw error;
    if (rows.length === 1 && rows[0].request_path === requestPath && rows[0].target_path === `/product/${uuid}`) {
      if (now() > deadline) throw error;
      return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw error;
    await sleep(Math.min(POLL_MS, remaining));
  }
}

module.exports = { waitForCanonicalProductUrl, MAX_WAIT_MS, POLL_MS };
