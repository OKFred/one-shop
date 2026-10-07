import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const extensions = ['bank-transfer', 'retail-pricing', 'storefront-identity', 'storefront-brand'];
const compiler = path.resolve('node_modules/@swc/cli/bin/swc.js');
for (const name of extensions) {
  const source = path.resolve('extensions', name, 'src');
  if (!existsSync(source)) continue;
  const result = spawnSync(process.execPath, [compiler, 'src', '-d', 'dist', '--config-file', path.resolve('packages/evershop/.swcrc'), '--copy-files', '--strip-leading-paths'], { cwd: path.resolve('extensions', name), stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
