'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

async function execute(script, args, accepted = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: process.env.SHUSHA_APP_DIR || process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-512 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 30 * 60 * 1000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    // close follows exit after stdout/stderr have drained. The final JSON is
    // evidence for partial results; parsing at exit can miss its last bytes.
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      for (const key of ['DB_PASSWORD', 'DATABASE_URL', 'APIKEY', 'SUUSHA_PRICE_API_KEY']) if (process.env[key]) {
        stdout = stdout.split(process.env[key]).join('[REDACTED]');
        stderr = stderr.split(process.env[key]).join('[REDACTED]');
      }
      const output = stdout + (stderr ? `\n${stderr}` : '');
      if (accepted.includes(code)) {
        let result;
        try { result = JSON.parse(stdout); } catch { result = null; }
        resolve({ script, args, code, output, result });
      }
      else reject(new Error(`${script} exited ${code ?? signal}: ${output.slice(-6000)}`));
    });
  });
}

module.exports = async function run(name, steps) {
  const privateData = process.env.PRIVATE_DATA_DIR || path.join(process.env.SHUSHA_APP_DIR || process.cwd(), 'data');
  const dir = path.join(process.env.MATERIAL_LIBRARY_DIR || path.join(privateData, 'material-library'), 'jobs');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid job journal name');
  const lockPath = path.join(dir, `${name}.lock`);
  const lock = await fs.open(lockPath, 'wx', 0o600);
  const state = { name, runId: crypto.randomUUID(), startedAt: new Date().toISOString(), status: 'running', steps: [] };
  const statePath = path.join(dir, `${name}.latest.json`);
  async function record() {
    const temp = `${statePath}.${state.runId}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(temp, statePath);
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, ...state }));
    await record();
    for (const step of steps) { state.steps.push(await execute(...step)); await record(); }
    state.status = state.steps.some(step => !step.result || step.result?.status === 'partial' || step.result?.status === 'no-ready-styles' || (step.result?.skipped || []).length > 0 || (step.result?.failures || []).some(failure => !/outside the allowed source hosts/.test(failure.reason))) ? 'attention' : 'completed';
  } catch (error) { state.status = 'failed'; state.error = error.message; throw error; }
  finally {
    state.finishedAt = new Date().toISOString();
    // An unavailable journal filesystem must not leave an ordinary failed
    // run's lock behind and block all subsequent scheduled attempts.
    try { await record(); }
    finally {
      try { await lock.close(); }
      finally { await fs.unlink(lockPath); }
    }
  }
};
