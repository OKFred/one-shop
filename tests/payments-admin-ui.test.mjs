import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { transform } from '@swc/core';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const directory = path.resolve('private', `payments-admin-ui-test-${process.pid}`);
await mkdir(directory, { recursive: true });
const source = await readFile('extensions/shopify-bridge/src/pages/admin/shopifyBridge/ShopifyOrderOperations.jsx', 'utf8');
const compiled = await transform(source, { filename: 'ShopifyOrderOperations.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022', transform: { react: { runtime: 'automatic' } } }, module: { type: 'es6' } });
const file = path.join(directory, 'operations.mjs'); await writeFile(file, compiled.code);
const { default: Operations, requestMerchantPayment, requestMerchantOrderOperation } = await import(pathToFileURL(file).href);
test.after(async () => { await rm(directory, { recursive: true, force: true }); });

const orderId = 'gid://shopify/Order/100';
const inspection = status => ({ quote: { status, revision: 1, paymentVersion: 2, currency: 'USD', amount: '23.25', receivedAmount: status === 'received' || status === 'paid' ? '23.25' : '0.00', remainingAmount: status === 'received' || status === 'paid' ? '0.00' : '23.25' }, nativeOrder: { id: orderId, displayFinancialStatus: status === 'paid' ? 'PAID' : 'PENDING', fulfilments: [], fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/500', status: 'OPEN', lineItems: { nodes: [{ id: 'gid://shopify/FulfillmentOrderLineItem/600', lineItem: { id: 'gid://shopify/LineItem/700' }, remainingQuantity: 2 }] } }] } } });

test('merchant receipt, paid and shipment controls start unchecked in each actual quote state', () => {
  for (const status of ['confirmed', 'partial', 'received', 'paid']) {
    const html = renderToStaticMarkup(React.createElement(Operations, { orderId, writesEnabled: true, initialInspection: inspection(status) }));
    assert.equal((html.match(/type="checkbox"/g) || []).length, 6); assert.doesNotMatch(html, /checked=""/);
    for (const label of ['Confirm native shipping quote', 'Register actual receipt only', 'Register Shopify paid status', 'Register actual native shipment', 'Cancel confirmed unpaid order']) assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
    assert.match(html, /Partial receipts stay in the central ledger/);
  }
});

test('merchant writes default paused and pending original journal exposes read-only reconciliation', () => {
  const paused = renderToStaticMarkup(React.createElement(Operations, { orderId, initialInspection: inspection('confirmed') })); assert.match(paused, /Merchant writes are paused/);
  const data = inspection('received'); data.quote.pendingPaymentOperationKey = 'synthetic_paid_operation_1';
  const pending = renderToStaticMarkup(React.createElement(Operations, { orderId, writesEnabled: true, initialInspection: data }));
  assert.match(pending, /Reconcile original paid result/); assert.match(pending, /does not replay the payment mutation/); assert.match(pending, /synthetic_paid_operation_1/);
});

test('private admin action uses same-origin JSON contract and sanitizes unknown provider responses', async () => {
  let request;
  const result = await requestMerchantPayment('inspect', { orderId }, async (url, input) => { request = { url, input }; return { ok: true, json: async () => ({ data: inspection('confirmed') }) }; });
  assert.equal(result.quote.status, 'confirmed'); assert.equal(request.url, '/api/shopify/payment-operation'); assert.equal(request.input.credentials, 'same-origin'); assert.equal(request.input.cache, 'no-store'); assert.equal(request.input.redirect, 'error'); assert.deepEqual(JSON.parse(request.input.body), { action: 'inspect', input: { orderId } });
  await assert.rejects(requestMerchantPayment('mark-paid', { orderId }, async () => ({ ok: false, json: async () => ({ error: { message: 'synthetic private account number must not appear' } }) })), error => !error.message.includes('account number') && /original journal/.test(error.message));
});

test('canonical pending cancellation restores the original key and disables finance while order-write gating stays independent', () => {
  const data = inspection('confirmed'); data.cancellation = { status: 'unknown', operationKey: 'synthetic_original_cancel_intent', reason: 'CUSTOMER' };
  const enabled = renderToStaticMarkup(React.createElement(Operations, { orderId, writesEnabled: false, orderWritesEnabled: true, initialInspection: data }));
  assert.match(enabled, /synthetic_original_cancel_intent/);
  assert.match(enabled, /It does not replay cancellation/);
  assert.match(enabled, /<button(?![^>]*disabled)[^>]*>Reconcile original cancellation result<\/button>/);
  assert.match(enabled, /<button[^>]*disabled=""[^>]*>Cancel confirmed unpaid order<\/button>/);
  assert.match(enabled, /<button[^>]*disabled=""[^>]*>Confirm native shipping quote<\/button>/);
  const paused = renderToStaticMarkup(React.createElement(Operations, { orderId, writesEnabled: true, initialInspection: data }));
  assert.match(paused, /Order cancellation writes are paused/);
  assert.match(paused, /<button[^>]*disabled=""[^>]*>Reconcile original cancellation result<\/button>/);
  data.cancellation.status = 'complete';
  const complete = renderToStaticMarkup(React.createElement(Operations, { orderId, writesEnabled: true, orderWritesEnabled: true, initialInspection: data }));
  assert.doesNotMatch(complete, /Reconcile original cancellation result/); assert.match(complete, /cancelled or closed/);
  data.cancellation.status = 'unknown'; data.nativeOrder.id = 'gid://shopify/Order/999';
  const wrongOrder = renderToStaticMarkup(React.createElement(Operations, { orderId, writesEnabled: true, orderWritesEnabled: true, initialInspection: data }));
  assert.match(wrongOrder, /<button[^>]*disabled=""[^>]*>Reconcile original cancellation result<\/button>/);
});

test('cancellation transport rejects unchecked requests and preserves unknown original intent for read-only reconciliation', async () => {
  const original = { orderId, operationKey: 'synthetic_original_cancel_intent', reason: 'CUSTOMER' }; const requests = [];
  const fake = async (url, input) => { requests.push({ url, input }); return { ok: false, status: 409, json: async () => ({ data: { status: 'unknown', requiresMerchantReview: true, replayed: false } }) }; };
  await assert.rejects(requestMerchantOrderOperation('cancel', { ...original, merchantConfirmed: false }, fake), /explicit merchant cancellation/);
  await assert.rejects(requestMerchantOrderOperation('cancel', { ...original, reason: 'FRAUD', merchantConfirmed: true }, fake), /explicit merchant cancellation/);
  assert.equal(requests.length, 0);
  const pending = await requestMerchantOrderOperation('cancel', { ...original, merchantConfirmed: true, bankDetails: 'must not be sent' }, fake);
  assert.equal(pending.status, 'unknown'); assert.equal(requests[0].url, '/api/shopify/orders/operation');
  assert.equal(requests[0].input.credentials, 'same-origin'); assert.equal(requests[0].input.cache, 'no-store'); assert.equal(requests[0].input.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].input.body), { action: 'cancel', ...original, merchantConfirmed: true });
  await requestMerchantOrderOperation('reconcile-cancel', original, fake);
  assert.deepEqual(JSON.parse(requests[1].input.body), { action: 'reconcile-cancel', orderId, operationKey: original.operationKey });
  await assert.rejects(requestMerchantOrderOperation('reconcile-cancel', original, async () => ({ ok: false, status: 409, json: async () => ({ error: 'synthetic private bank details' }) })), error => !error.message.includes('bank details') && /original cancellation intent/.test(error.message));
});
