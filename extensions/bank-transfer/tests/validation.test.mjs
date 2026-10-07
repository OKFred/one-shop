import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { money, usdMoney, currency, receiptReference, paymentLink, openLink, validateOrderUuid } from '../src/services/paymentValidation.js';
import { orderAccess, canonicalOrderUuid, authenticatedCustomerId } from '../src/services/paymentAccess.js';
import { configurationReadiness, loadReceivingConfig } from '../src/services/receivingConfig.js';

const uuid = '45e9fccd-00dc-4f04-a72e-d08622dbe520';
test('Accept canonical and compact UUIDs, reject arbitrary order references', () => {
  assert.equal(validateOrderUuid(uuid), uuid);
  assert.equal(canonicalOrderUuid(uuid.replaceAll('-', '')), uuid);
  for (const invalid of ['10004', '', `${uuid}/../admin`, '0'.repeat(32), `${uuid}?x=1`]) assert.throws(() => validateOrderUuid(invalid), /Invalid order/);
});
test('Exact decimals reject rounding, exponents, negative and zero payment amounts', () => {
  assert.equal(money('15'), '15.00');
  assert.equal(money('15.1'), '15.10');
  assert.equal(usdMoney('9.9800'), '9.98');
  for (const invalid of ['0', '-1', '+1', '1e2', '01.00', ' 1.00', '1.001', 10]) assert.throws(() => money(invalid));
  assert.throws(() => usdMoney('9.9801'), /precision/);
});
test('Wise link only uses official HTTPS Business open link and escaped amount/reference', () => {
  const link = new URL(paymentLink('https://wise.com/pay/business/example-store', '19.98', 'GBP', 'SHUSHA-10004'));
  assert.equal(link.searchParams.get('amount'), '19.98');
  assert.equal(link.searchParams.get('currency'), 'GBP');
  assert.equal(link.searchParams.get('description'), 'SHUSHA-10004');
  assert.equal(paymentLink(null, '19.98', 'GBP', 'SHUSHA-10004'), null);
  for (const invalid of ['http://wise.com/pay/business/example', 'https://wise.com.evil.invalid/pay/business/example', 'https://wise.com/pay/business/example?amount=1', 'https://u:p@wise.com/pay/business/example', 'https://wise.com:444/pay/business/example']) assert.throws(() => openLink(invalid));
  assert.throws(() => currency('gbp'));
  assert.equal(receiptReference(' txn-12   verified '), 'TXN-12 VERIFIED');
});
test('Order access uses authenticated context or native checkout capability only', () => {
  assert.equal(orderAccess({}, uuid), null);
  assert.equal(orderAccess({ bankTransferGuestUuid: uuid }, uuid), null, 'Guest payment must not unlock generic Order/PII');
  assert.deepEqual(orderAccess({ orderId: uuid.replaceAll('-', '') }, uuid), { kind: 'checkout' });
  assert.deepEqual(orderAccess({ orderId: uuid, customer: { customer_id: 12 } }, uuid), { kind: 'checkout' });
  assert.equal(orderAccess({ orderId: '4bb1f66f-688a-4b9e-b080-39e88437c39f' }, uuid), null);
  assert.deepEqual(orderAccess({ customer: { customer_id: 12 } }, uuid), { kind: 'customer', customerId: 12 });
  assert.equal(authenticatedCustomerId({ customer: { customer_id: 'not-an-id' } }), null);
  assert.deepEqual(orderAccess({ user: { user_id: 1 } }, uuid), { kind: 'admin' });
});
test('Receiving readiness fails closed without exposing private content; USD requires issuance flag', () => {
  const original = process.env.SHUSHA_WISE_RECEIVING_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shusha-payment-test-'));
  const file = path.join(dir, 'receiving.json');
  try {
    delete process.env.SHUSHA_WISE_RECEIVING_CONFIG;
    assert.deepEqual(configurationReadiness(), { ready: false, currencies: [], openLinkReady: false });
    process.env.SHUSHA_WISE_RECEIVING_CONFIG = file;
    fs.writeFileSync(file, JSON.stringify({ openLink: 'https://wise.com/pay/business/example-store', accounts: { GBP: { fields: [{ label: 'Beneficiary', value: 'Synthetic Test' }] }, USD: { fields: [{ label: 'Account', value: '00000000' }] } } }));
    assert.deepEqual(configurationReadiness(), { ready: true, currencies: ['GBP'], openLinkReady: true });
    assert.equal(loadReceivingConfig().accounts.USD, undefined);
    fs.writeFileSync(file, JSON.stringify({ accounts: { GBP: { fields: [{ label: 'Account', value: 'placeholder private content' }] } } }));
    assert.deepEqual(configurationReadiness(), { ready: false, currencies: [], openLinkReady: false });
  } finally {
    if (original === undefined) delete process.env.SHUSHA_WISE_RECEIVING_CONFIG; else process.env.SHUSHA_WISE_RECEIVING_CONFIG = original;
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
