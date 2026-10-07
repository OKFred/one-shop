import path from 'node:path';

const DEFINITIONS = Object.freeze({
  'source-sync': Object.freeze({ resolve: 'scripts/jobs/source-sync.js', schedule: '0 9 * * *' }),
  'material-drop': Object.freeze({ resolve: 'scripts/jobs/material-drop.js', schedule: '0 10 * * 2,5' })
});

// EverShop v2 registers jobs through this API; a config array alone is inert.
// Keep this merchant seam limited to the two reviewed worker entry points.
export function registerShushaJobs({ getConfig, registerJob, appDir = process.env.SHUSHA_APP_DIR || process.cwd(), timezone = process.env.TZ }) {
  const configured = getConfig('system.jobs', []);
  if (!Array.isArray(configured) || configured.length > 2) throw new Error('SHUSHA system.jobs must contain at most the two approved jobs');
  const names = new Set();
  const jobs = configured.map((job) => {
    const definition = job && Object.hasOwn(DEFINITIONS, job.name) ? DEFINITIONS[job.name] : null;
    if (!definition || names.has(job.name) || Object.keys(job).some(key => !['name', 'resolve', 'schedule', 'enabled'].includes(key)) ||
        job.resolve !== definition.resolve || job.schedule !== definition.schedule || typeof job.enabled !== 'boolean') {
      throw new Error('SHUSHA job name, path, schedule or enabled flag differs from its approved definition');
    }
    names.add(job.name);
    return { name: job.name, resolve: path.resolve(appDir, definition.resolve), schedule: definition.schedule, enabled: job.enabled };
  });
  if (jobs.some(job => job.enabled) && timezone !== 'Asia/Shanghai') throw new Error('Enabled SHUSHA jobs require TZ=Asia/Shanghai');
  // Validate the complete array first: a rejected config registers no workers.
  for (const job of jobs) if (job.enabled) registerJob(job);
  return jobs.filter(job => job.enabled).map(job => job.name);
}
