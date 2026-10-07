import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRules, retailCents, retailPrice, retailSql, publicSku } from '../src/services/pricing.js';
import { registerPricing } from '../src/services/registerPricing.js';

const rules = normalizeRules({ enabled: true, multiplier: '1.1' });
function installed() {
  const hooks = new Map();
  registerPricing({
    addProcessor: (name, callback) => hooks.set(name, callback),
    hookBefore: (name, callback) => hooks.set(`hook:${name}`, callback),
    getRules: () => rules, sql: value => value,
    update: () => ({ given: value => ({ where: () => ({ execute: async connection => { connection.saved = value; } }) }) })
  });
  return hooks;
}

test('source USD is rounded upwards only once and exact .99 boundaries do not drift', () => {
  for (const [source, expected] of [['4.00',499n],['4.62',599n],['3.85',499n],['0',0n],['4.5363',499n],['4.5364',599n]]) {
    assert.equal(retailCents(source, rules), expected);
  }
  const unity = normalizeRules({ enabled: true, multiplier: '1' });
  assert.equal(retailCents('0.9900', unity), 99n);
  assert.equal(retailCents('0.9901', unity), 199n);
  assert.equal(retailCents('4.9900', unity), 499n);
  assert.equal(retailCents('4.9901', unity), 599n);
});

test('unsafe decimals, multiplier and storage overflow are rejected', () => {
  for (const source of [-1,NaN,Infinity,'1e3','4.00001','4; DROP TABLE product',null]) assert.throws(() => retailCents(source,rules));
  for (const multiplier of ['0','-1','100.000001','1.0000001','1e2']) assert.throws(() => normalizeRules({multiplier}));
  assert.throws(() => normalizeRules({enabled:'true'}));
  assert.throws(() => retailCents('99999999.9900',rules), /storage limit/);
});

test('only managed SKUs change; old order aliases are presentation-only', () => {
  assert.equal(retailPrice({sku:'SHUSHA-L1001',price:'4.00'},rules),4.99);
  for (const sku of ['SHOE-1','shusha-L1001','X-SHUSHA-L1001','FRED-SUUSHA-L1001']) assert.equal(retailPrice({sku,price:'4.00'},rules),'4.00');
  assert.equal(retailPrice({sku:'SHUSHA-L1001',price:'4.00'},normalizeRules()),'4.00');
  assert.equal(publicSku('FRED-SUUSHA-L1001-V-L1001blam'),'SHUSHA-L1001-V-L1001blam');
  assert.equal(publicSku('FRED-SUUSHA-L12'),'FRED-SUUSHA-L12');
});

test('cart loader returns retail price without mutating supplier row or inventory', async () => {
  const row=Object.freeze({sku:'SHUSHA-L1001',price:'4.00',qty:998});
  const loaded=await installed().get('cartItemProductLoaderFunction')(async()=>row)(1);
  assert.notEqual(loaded,row); assert.equal(loaded.price,4.99);assert.equal(loaded.qty,998);assert.equal(row.price,'4.00');
});

test('storefront SQL uses retail expression and bound filters; admin stays at source price', () => {
  const filters=['min_price','max_price'].map(key=>({key,callback(){throw new Error('native source-price filter used');}}));
  const map=installed().get('productCollectionFilters');
  assert.equal(map.call({isAdmin:true},filters),filters);
  const applied=map.call({isAdmin:false},filters); const calls=[];
  const query={getWhere:()=>({addRaw:(...args)=>calls.push(args)})};
  const current=[]; applied[0].callback(query,'eq','4.99',current);applied[1].callback(query,'eq','5.99',current);
  assert.equal(calls.length,2);assert.match(calls[0][1],/CEIL/);assert.deepEqual(calls[0][2],{shusha_retail_min_price:'4.99'});
  applied[0].callback(query,'eq','4.99 OR 1=1',current);assert.equal(calls.length,2);
  assert.match(retailSql(rules),/110?::numeric/);
});

function checkout({ priorTotal='9.98', currentTotal='9.98', currency='USD', priorCurrency='USD', priorQty=2, priorPrice='4.99' }={}) {
  const current={grand_total:currentTotal,currency,items:[{uuid:'item-1',qty:2,product_price:'4.99',product_price_incl_tax:'4.99',final_price:'4.99',final_price_incl_tax:'4.99'}]};
  const connection={queries:[],async query(statement){
    this.queries.push(statement);
    return statement.text.includes('FROM cart_item') ? {rows:[{...current.items[0],qty:priorQty,product_price:priorPrice}]} : {rows:[{grand_total:priorTotal,currency:priorCurrency}]};
  }};
  const cart={getItems:()=>[{getData:()=> 'SHUSHA-L1001'}],getData:()=>12,exportData:()=>current};
  return {connection,cart,current};
}

test('native saveOrder guard accepts only the reviewed cart snapshot under row locks', async () => {
  const fixture=checkout();await installed().get('hook:saveOrder')(fixture.cart,fixture.connection);
  assert.equal(fixture.connection.saved,fixture.current);
  assert.ok(fixture.connection.queries.every(query=>query.text.includes('FOR UPDATE')));
});

test('changed totals, currency, quantities or item prices require customer review', async () => {
  for (const change of [{priorTotal:'8.98'},{priorCurrency:'GBP'},{priorQty:1},{priorPrice:'3.99'}]) {
    const fixture=checkout(change);
    await assert.rejects(installed().get('hook:saveOrder')(fixture.cart,fixture.connection),/Prices or cart contents have changed/);
    assert.equal(fixture.connection.saved,undefined);
  }
});
