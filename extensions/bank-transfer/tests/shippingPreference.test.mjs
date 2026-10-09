import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShippingPreference } from '../src/services/shippingPreferenceValidation.js';

test('Empty preferences use merchant recommendation; names are trimmed without changing their text', () => {
  for (const value of [undefined, null, '', '   ']) assert.equal(normalizeShippingPreference(value), null);
  assert.equal(normalizeShippingPreference('  DHL Express  '), 'DHL Express');
  assert.equal(normalizeShippingPreference('客户自选快递'), '客户自选快递');
  assert.equal(normalizeShippingPreference('A'.repeat(80)), 'A'.repeat(80));
});

test('Invalid preference input fails before any cart write', () => {
  for (const value of [{ company: 'DHL' }, ['DHL'], 123, false]) {
    assert.throws(() => normalizeShippingPreference(value), /must be text/);
  }
  assert.throws(() => normalizeShippingPreference('A'.repeat(81)), /80 characters/);
  for (const value of ['DHL\nExpress', 'DHL\0', 'DHL\t', 'DHL\u202e', 'DHL\u200b']) {
    assert.throws(() => normalizeShippingPreference(value), /unsupported characters/);
  }
});
