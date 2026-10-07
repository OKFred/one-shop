const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArguments, validateSlot, assertPublicationBatch, normalizedStyle, selectPlans, localAsset } = require('../publish-material-drop.cjs');
const { productReviewFingerprint, preserveReview, money } = require('../suusha-source.cjs');

function fixture() {
  const hash = 'a'.repeat(64); const sourceUrl = 'https://cdn.suusha.com/example.png';
  const source = {
    sourceId:'L1001',title:'Example Dress',sourceCurrency:'LKR',displayCurrency:'USD',sourceUrl:'https://wh.suusha.com/',
    sourceCategoryName:'L1001',sourceCategoryNames:['L1001'],capturedAt:new Date().toISOString(),sourcePriceUsd:4,
    sourceBaseSkus:['L1001'],descriptionRaw:'Example',sourceImages:[sourceUrl],
    colors:[{id:1,name:'Black'}],sizes:[{id:2,name:'M'}],
    variants:[{sourceSku:'L1001blam',colorId:1,color:'Black',sizeId:2,size:'M',resolved:true,available:true,availableQty:3,
      prices:{resale:{usd:4}},gallery:[sourceUrl]}],
    publication:{ready:true,reviewedAt:new Date().toISOString(),reviewNote:'Original garment and actual variants visually reviewed',category:'dresses'}
  };
  source.publication.reviewedSourceSha256=productReviewFingerprint(source);
  const media=new Map([[sourceUrl,{sourceUrl,localPath:`media/source-library/${hash}.png`,sha256:hash,bytes:20,width:10,height:10}]]);
  return {source,media};
}

test('publication dates are valid Shanghai Tuesday/Friday slots and retry limits are frozen', () => {
  assert.equal(validateSlot('2026-10-06'),'2026-10-06');assert.equal(validateSlot('2026-10-09'),'2026-10-09');
  assert.throws(()=>validateSlot('2026-10-07'));assert.throws(()=>validateSlot('2026-02-31'));
  const options=parseArguments(['--publish-next','--apply','--slot','2026-10-09']);assert.equal(options.limit,2);
  assert.throws(()=>assertPublicationBatch({slot:null,plans:[{}],excluded:[]},options),/Not enough reviewed READY/);
  assert.doesNotThrow(()=>assertPublicationBatch({slot:{},plans:[{}],excluded:[]},options));
});

test('only reviewed original material with actual available size/colour becomes a managed style', () => {
  const {source,media}=fixture();const plan=normalizedStyle(source,'dresses',media,{maxAgeHours:48},false);
  assert.equal(plan.variants[0].storeSku,'SHUSHA-L1001');assert.equal(plan.variants[0].storeUrlKey,'l1001');
  assert.equal(plan.variants[0].color,'Black');assert.equal(plan.variants[0].size,'M');assert.equal(plan.variants[0].sourcePriceUsd,4);
  assert.equal(plan.variants[0].images[0].assetUrl,`/assets/source-library/${'a'.repeat(64)}.png`);
});

test('changed visual facts, missing original file evidence and stale source data fail closed', () => {
  const changed=fixture();changed.source.variants[0].color='Blue';
  assert.throws(()=>normalizedStyle(changed.source,'dresses',changed.media,{maxAgeHours:48},false),/visual review/);
  const missing=fixture();missing.media.clear();assert.throws(()=>normalizedStyle(missing.source,'dresses',missing.media,{maxAgeHours:48},false),/not downloaded/);
  const stale=fixture();stale.source.capturedAt='2020-01-01T00:00:00Z';assert.throws(()=>normalizedStyle(stale.source,'dresses',stale.media,{maxAgeHours:48},false),/stale/);
  assert.throws(()=>localAsset({localPath:'media/source-library/../../secret.png'}));
});

test('price/stock changes retain visual review, gallery or size changes invalidate it', () => {
  const {source}=fixture();const fresh=structuredClone(source);fresh.variants[0].prices.resale.usd=4.62;fresh.variants[0].availableQty=1;fresh.readiness={};
  assert.equal(preserveReview(source,fresh).publication.ready,true);
  const changed=structuredClone(source);changed.variants[0].size='L';changed.readiness={};
  assert.equal(preserveReview(source,changed).publication.ready,false);
  assert.equal(money(1300,325).displayUsd,'4.00');
});

test('retrying completed or failed slots uses original plans and never selects additional styles', async () => {
  for (const status of ['complete','failed','running']) {
    const slot={slot:'2026-10-06',style_limit:2,status,plan:[{sourceId:'L1001'},{sourceId:'L1002'}]};
    const calls=[];const client={async query(sql){calls.push(sql);
      if(sql.includes('to_regclass')) return {rows:[{name:'exists'}]};
      if(sql.includes('WHERE slot=')) return {rows:[slot]};
      if(sql.includes('shusha_material_publication')) return {rows:[]};
      throw new Error(`Unexpected fresh style selection: ${sql}`);
    }};
    const selected=await selectPlans(client,{catalog:{products:[]}},parseArguments(['--publish-next','--apply','--slot','2026-10-06']));
    assert.equal(selected.plans,slot.plan);assert.equal(selected.resumed,true);assert.equal(calls.some(sql=>sql.includes('SELECT sku FROM product')),false);
    await assert.rejects(selectPlans(client,{catalog:{products:[]}},parseArguments(['--publish-next','--apply','--slot','2026-10-06','--limit','3'])),/frozen --limit/);
  }
});

test('an earlier failed slot blocks selecting new styles for a later slot', async () => {
  const client={async query(sql){
    if(sql.includes('to_regclass'))return {rows:[{name:'exists'}]};
    if(sql.includes('WHERE slot='))return {rows:[]};
    if(sql.includes("status<>'complete'"))return {rows:[{slot:'2026-10-06',status:'failed'}]};
    if(sql.includes('shusha_material_publication'))return {rows:[]};
    throw new Error('New style selection must remain blocked');
  }};
  await assert.rejects(selectPlans(client,{catalog:{products:[]}},parseArguments(['--publish-next','--apply','--slot','2026-10-09'])),/resume that original slot/);
});
