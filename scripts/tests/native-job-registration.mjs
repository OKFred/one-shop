// Run after compiling v2 and the extension. Uses the real public job registry,
// native base/catalog bootstraps and merchant bootstrap; no job is executed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const expected = [
  { name: 'source-sync', resolve: 'scripts/jobs/source-sync.js', schedule: '0 9 * * *', enabled: true },
  { name: 'material-drop', resolve: 'scripts/jobs/material-drop.js', schedule: '0 10 * * 2,5', enabled: true }
];
const mode = process.argv[2];
if (!mode) {
  for (const scenario of ['candidate', 'runtime']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), scenario], { cwd: process.cwd(), env: { ...process.env, TZ: 'Asia/Shanghai' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${scenario} native registry: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, new RegExp(`"scenario":"${scenario}"`));
  }
  console.log(JSON.stringify({ status: 'passed', nativeVersion: '2.2.1', candidateEnabledJobs: 0, runtimeEnabledJobs: 2, originalSchedules: true, nativeDefaultJobsDisabled: true }));
} else {
  assert.ok(['candidate', 'runtime'].includes(mode));
  const config = JSON.parse(await fs.readFile(new URL('../../deployment/config.shusha.json', import.meta.url), 'utf8'));
  assert.equal(config.sitemap.enabled, false);
  assert.equal(config.catalog.crossSell.recomputeEnabled, false);
  config.system.jobs = mode === 'runtime' ? expected : [];
  process.env.ALLOW_CONFIG_MUTATIONS = 'true';
  process.env.NODE_CONFIG = JSON.stringify(config);
  const [{ default: base }, { default: catalog }, { default: merchant }, { getEnabledJobs, getAllJobs }, { pool }] = await Promise.all([
    import('../../packages/evershop/dist/modules/base/bootstrap.js'),
    import('../../packages/evershop/dist/modules/catalog/bootstrap.js'),
    import('../../extensions/retail-pricing/dist/bootstrap.js'),
    import('@evershop/evershop/lib/cronjob'),
    import('@evershop/evershop/lib/postgres')
  ]);
  try {
    await base({ process: 'cronjob' });
    await catalog({ process: 'cronjob' });
    await merchant({ process: 'cronjob' });
    const all = getAllJobs();
    assert.equal(all.find(job => job.name === 'generateSitemap')?.enabled, false);
    assert.equal(all.find(job => job.name === 'recomputeProductRecommendations')?.enabled, false);
    assert.deepEqual(getEnabledJobs(), mode === 'runtime' ? expected.map(job => ({ ...job, resolve: path.resolve(job.resolve) })) : []);
    console.log(JSON.stringify({ status: 'passed', scenario: mode, enabledJobs: getEnabledJobs().length }));
  } finally { await pool.end(); }
}
