import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuoteAddress, validateDestination } from '../src/services/manualQuote.js';

test('Worldwide quote addresses reject invalid destinations without inventing optional strings', () => {
  const address = { full_name: 'Synthetic customer', telephone: '+00000000000', address_1: 'Fixture address', city: 'Fixture city', country: 'LK', postcode: '00100' };
  assert.equal(validateQuoteAddress(address), undefined);
  assert.equal(validateQuoteAddress({ ...address, province: null, address_2: null }), undefined);
  assert.throws(() => validateQuoteAddress({ ...address, address_2: 123 }), /Invalid shipping/);
  assert.throws(() => validateQuoteAddress({ ...address, postcode: '' }), /required/);
  assert.throws(() => validateDestination('ZZ', ''), /Invalid shipping country/);
  assert.throws(() => validateDestination('US', 'CN-BJ'), /Invalid shipping province/);
});
