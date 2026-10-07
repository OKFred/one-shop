import test from 'node:test';
import assert from 'node:assert/strict';
import { createVariantGroup, linkVariant, descriptionRows, rewriteProduct } from '../lib/material-catalog.mjs';

test('group reservation and frozen journal link commit together', async () => {
  const calls=[];const client={async query(sql,args){calls.push({sql,args});
    if(sql.includes('FROM attribute'))return {rows:[{attribute_id:1,attribute_code:'shusha_color'},{attribute_id:2,attribute_code:'shusha_size'}]};
    if(sql.includes('INSERT INTO variant_group'))return {rows:[{variant_group_id:8}]};
    if(sql.includes('UPDATE shusha_material_publication'))return {rowCount:1};
    return {rows:[]};
  }};
  assert.deepEqual(await createVariantGroup(client,['shusha_color','shusha_size'],1,'L1001'),{variant_group_id:8});
  assert.equal(calls[0].sql,'BEGIN');assert.equal(calls.at(-1).sql,'COMMIT');
  assert.ok(calls.findIndex(call=>call.sql.includes('UPDATE shusha_material_publication'))<calls.length-1);
});

test('lost group journal reservation rolls back the new group', async () => {
  const calls=[];const client={async query(sql){calls.push(sql);
    if(sql.includes('FROM attribute'))return {rows:[{attribute_id:1,attribute_code:'shusha_color'},{attribute_id:2,attribute_code:'shusha_size'}]};
    if(sql.includes('INSERT INTO variant_group'))return {rows:[{variant_group_id:8}]};
    return {rowCount:0,rows:[]};
  }};
  await assert.rejects(createVariantGroup(client,['shusha_color','shusha_size'],1,'L1001'),/reservation changed/);
  assert.equal(calls.at(-1),'ROLLBACK');assert.equal(calls.includes('COMMIT'),false);
});

test('variant linking adopts one parcel without rewriting product prices or inventory', async () => {
  const calls=[];const client={async query(sql,args){calls.push({sql,args});
    if(sql.includes('FROM variant_group'))return {rows:[{variant_group_id:8,attribute_group_id:1}]};
    if(sql.includes('FROM product WHERE uuid='))return {rows:[{product_id:3,group_id:1,package_id:4}]};
    if(sql.includes('SELECT product_id,package_id'))return {rows:[{product_id:2,package_id:4}]};
    return {rows:[]};
  }};
  await linkVariant(client,'group-uuid','product-uuid');assert.equal(calls.at(-1).sql,'COMMIT');
  for(const {sql} of calls.filter(call=>call.sql.startsWith('UPDATE')))assert.doesNotMatch(sql,/price|qty|product_inventory/);
});

test('managed URL ownership prevents overwriting another entity', async () => {
  const calls=[];const client={async query(sql){calls.push(sql);
    if(sql.includes('FROM product_description'))return {rows:[{url_key:'l1001',category_path:'dresses'}]};
    if(sql.includes('FROM url_rewrite'))return {rows:[{entity_uuid:'other',entity_type:'product'}]};
    throw new Error('Unexpected write');
  }};
  await assert.rejects(rewriteProduct(client,{product_id:3,uuid:'managed'}),/another entity/);
  assert.equal(calls.some(sql=>sql.startsWith('INSERT')),false);
});

test('v2 description uses native editor rows', () => {
  const rows=descriptionRows('<p>Source-listed garment</p>');
  assert.equal(rows[0].columns[0].data.blocks[0].type,'raw');
  assert.equal(rows[0].columns[0].data.blocks[0].data.html,'<p>Source-listed garment</p>');
});
