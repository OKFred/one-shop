import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const run = notificationEmails => spawnSync(process.execPath, ['--input-type=module', '-e', `
  const { installAutomaticEmailPolicy, AUTOMATIC_CUSTOMER_EMAIL_TYPES } = await import(${JSON.stringify(new URL('../dist/services/automaticEmails.js', import.meta.url).href)});
  const { getConfig } = await import('@evershop/evershop/lib/util/getConfig');
  try {
    installAutomaticEmailPolicy();
    console.log(JSON.stringify({disabled:AUTOMATIC_CUSTOMER_EMAIL_TYPES.every(type=>getConfig('system.notification_emails.'+type+'.enabled')===false)}));
  } catch { console.log(JSON.stringify({blocked:true})); process.exitCode=2; }
`], { encoding: 'utf8', cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, NODE_ENV: 'test', ALLOW_CONFIG_MUTATIONS: 'true', NODE_CONFIG: JSON.stringify({ system: { notification_emails: notificationEmails } }) } });

test('native automatic customer notification types default to disabled', () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"disabled":true/);
});

test('enabling any automatic customer notification fails closed at bootstrap', () => {
  for (const type of ['order_confirmation', 'customer_welcome', 'shipment_created', 'shipment_delivered']) {
    const result = run({ [type]: { enabled: true } });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /"blocked":true/);
  }
});
