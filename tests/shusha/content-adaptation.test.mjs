import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptStoreContent, normalizedMainMenu, choosePackingPlaceholder, PACKING_PLACEHOLDER, BRANDING } from '../../deployment/adapt-store-content.mjs';

const menu = () => ({ widget_instance_id: 1, status: true, type: 'basic_menu', settings: {
  className: '', isMain: '1', menus: ['/dresses','/pants','/tops'].map(url => ({ name: url.slice(1), type: 'custom', url, uuid: url, children: [] }))
} });

test('legacy menu normalization keeps actual names/links and adapts v2 booleans/list fields', () => {
  const old=menu();old.settings.menus=JSON.stringify(old.settings.menus);
  const converted=normalizedMainMenu(old);
  assert.equal(converted.isMain,true);assert.deepEqual(converted.menus.map(item=>item.url),['/dresses','/pants','/tops']);
  assert.equal(old.settings.isMain,'1');assert.equal(typeof old.settings.menus,'string');
  assert.equal(normalizedMainMenu({type:'text_block',settings:{}}),null);
});

test('merchant-edited physical parcels cannot be silently relabelled as placeholders', () => {
  const seeded={package_id:4,name:'Standard Box',length:'30.00',width:'25.00',height:'10.00',weight:'0.0000',is_default:true};
  assert.equal(choosePackingPlaceholder([seeded]).rename,true);
  assert.throws(()=>choosePackingPlaceholder([{...seeded,length:'31.00'}]),/unedited starter parcel/);
  assert.throws(()=>choosePackingPlaceholder([{...seeded,is_default:false}]),/unedited starter parcel/);
  const existing={...seeded,name:PACKING_PLACEHOLDER};assert.equal(choosePackingPlaceholder([existing]).rename,false);
});

function fixture({database='preview',corruptProtected=false}={}) {
  const state={
    widgets:[menu(),{widget_instance_id:2,status:true,type:'text_block',settings:{text:'Original private hero copy'}},{widget_instance_id:3,status:true,type:'text_block',settings:{text:'Original private footer copy'}}],
    placements:[{widget_placement_id:1,widget_instance_id:1,route:'all',area:'header',entity_urn:null},{widget_placement_id:2,widget_instance_id:2,route:'homepage',area:'content',entity_urn:null},{widget_placement_id:3,widget_instance_id:3,route:'all',area:'footer',entity_urn:null}],
    settings:[],packages:[{package_id:4,name:'Standard Box',length:'30.00',width:'25.00',height:'10.00',weight:'0.0000',is_default:true}],unassigned:2
  };
  const calls=[];let saved;let applied=false;
  const client={async query(sql,args=[]){calls.push({sql,args});
    if(sql.startsWith('BEGIN')){saved=structuredClone(state);return {rows:[]};}
    if(sql==='ROLLBACK'){Object.assign(state,saved);return {rows:[]};}
    if(sql==='COMMIT')return {rows:[]};
    if(sql.includes('current_database()'))return {rows:[{name:database}]};
    if(sql.startsWith('LOCK TABLE')||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.startsWith('SELECT * FROM widget_instance'))return {rows:structuredClone(state.widgets)};
    if(sql.startsWith('SELECT * FROM widget_placement'))return {rows:structuredClone(state.placements)};
    if(sql.includes('jsonb_agg'))return {rows:[{value:corruptProtected&&applied?['Unexpected protected price change']:['Same original bytes']}]};
    if(sql.startsWith('SELECT name,value,is_json FROM setting'))return {rows:structuredClone(state.settings)};
    if(sql.startsWith('SELECT * FROM package'))return {rows:structuredClone(state.packages)};
    if(sql.startsWith('SELECT count(*)'))return {rows:[{count:String(state.unassigned)}]};
    if(sql.startsWith('INSERT INTO setting')){state.settings=state.settings.filter(row=>row.name!==args[0]);state.settings.push({name:args[0],value:args[1],is_json:false});return {rowCount:1};}
    if(sql.startsWith('UPDATE widget_instance')){state.widgets.find(row=>row.widget_instance_id===args[1]).settings=JSON.parse(args[0]);return {rowCount:1};}
    if(sql.startsWith('UPDATE widget_placement')){state.placements.find(row=>row.widget_placement_id===args[1]).area=args[0];return {rowCount:1};}
    if(sql.startsWith('UPDATE package')){state.packages.find(row=>row.package_id===args[1]).name=args[0];return {rowCount:1};}
    if(sql.startsWith('UPDATE product SET package_id')){state.unassigned=0;applied=true;return {rowCount:2};}
    throw new Error(`Unexpected statement: ${sql}`);
  }};
  return {client,state,calls};
}

test('wrong expected database aborts before any content mutation', async () => {
  const {client,calls}=fixture({database:'other'});
  await assert.rejects(adaptStoreContent(client,{action:'apply',expectedDatabase:'preview'},{verifyLogo:false}),/exact target/);
  assert.equal(calls.at(-1).sql,'ROLLBACK');assert.equal(calls.some(({sql})=>/^(?:UPDATE|INSERT)/.test(sql)),false);
});

test('apply preserves hero/CMS copy, remaps only global areas and is idempotent', async () => {
  const f=fixture();const hero=JSON.stringify(f.state.widgets[1]);const footer=JSON.stringify(f.state.widgets[2]);
  const first=await adaptStoreContent(f.client,{action:'apply',expectedDatabase:'preview'},{verifyLogo:false});
  assert.equal(first.packageId,4);assert.equal(first.packingDimensionsVerified,false);assert.equal(first.counts.placements,2);assert.equal(first.counts.parcelBindings,2);
  assert.equal(f.state.placements[0].area,'headerMiddleLeft');assert.equal(f.state.placements[1].area,'content');assert.equal(f.state.placements[2].area,'footerTop');
  assert.equal(JSON.stringify(f.state.widgets[1]),hero);assert.equal(JSON.stringify(f.state.widgets[2]),footer);
  for(const [name,value] of Object.entries(BRANDING))assert.ok(f.state.settings.some(row=>row.name===name&&row.value===value));
  const second=await adaptStoreContent(f.client,{action:'apply',expectedDatabase:'preview'},{verifyLogo:false});
  assert.ok(Object.values(second.counts).every(count=>count===0));
  assert.equal(f.calls.some(({sql})=>/UPDATE (?:product_inventory|"order"|order_item)/.test(sql)),false);
});

test('protected-data drift rolls back branding, placement and parcel changes together', async () => {
  const f=fixture({corruptProtected:true});const initial=structuredClone(f.state);
  await assert.rejects(adaptStoreContent(f.client,{action:'apply',expectedDatabase:'preview'},{verifyLogo:false}),/Protected CMS/);
  assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert.deepEqual(f.state,initial);
});
