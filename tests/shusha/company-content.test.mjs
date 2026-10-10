import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import cmsMigration from '../../packages/evershop/src/modules/cms/migration/Version-1.0.0.js';
import { applyCompanyContent, companyEditorRows, parseCompanyContentOptions } from '../../deployment/apply-company-content.mjs';

const profile = { schemaVersion: 1, shopName: 'Synthetic Store', legalName: '',
  address: { line1: 'Example road', line2: '', city: 'Fixture city', postalCode: '00000', country: 'Example country', countryCode: 'US' },
  support: { email: 'help@example.invalid', whatsappSriLanka: 'https://wa.me/12025550123', whatsappChina: '' } };

test('company content defaults to dry run and requires exact database, explicit private profile and a reviewed apply digest', () => {
  const arguments_ = ['--expected-database', 'synthetic_company_test', '--profile', 'private/profile.json'];
  assert.equal(parseCompanyContentOptions(arguments_, {}).action, 'dry-run');
  assert.throws(() => parseCompanyContentOptions(['--profile', 'private/profile.json'], {}), /exact target/);
  assert.throws(() => parseCompanyContentOptions(['--expected-database', 'synthetic_company_test'], {}), /profile/);
  assert.throws(() => parseCompanyContentOptions([...arguments_, '--apply'], {}), /review digest/);
  assert.throws(() => parseCompanyContentOptions([...arguments_, '--verify', '--apply'], {}), /exactly one/);
  assert.throws(() => parseCompanyContentOptions([...arguments_, '--apply', '--expected-content-sha256', 'invalid'], {}), /digest/);
  assert.equal(parseCompanyContentOptions(['--expected-database', 'synthetic_company_test'], { SHUSHA_PUBLIC_PROFILE_FILE: 'private/profile.json' }).profileFile, 'private/profile.json');
});

test('company copy uses one native sanitized raw block, stripping scripts, event handlers and unsafe URLs', () => {
  const rows = companyEditorRows({ handle: 'contact', bodyHtml: '<h2>Safe title</h2><p onclick="unsafe()">Body<script>unsafe()</script><a href="javascript:unsafe()">link</a></p>' });
  assert.equal(rows.length, 1); assert.equal(rows[0].size, 1); assert.equal(rows[0].columns.length, 1);
  const blocks = rows[0].columns[0].data.blocks;
  assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'raw');
  assert.equal(blocks[0].data.html, '<h2>Safe title</h2><p>Body<a>link</a></p>');
  assert.throws(() => companyEditorRows({ handle: 'shipping-payment', bodyHtml: '<p>untargeted</p>' }), /Invalid/);
});

const fixtureUrl = process.env.SHUSHA_COMPANY_CONTENT_TEST_DATABASE_URL;
const sqlTest = (name, work) => test(name, { skip: !fixtureUrl }, async () => {
  const url = new URL(fixtureUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /_test$/.test(url.pathname), 'Only a dedicated loopback synthetic test database is permitted');
  const admin = new Pool({ connectionString: fixtureUrl });
  const schema = `company_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: fixtureUrl, options: `-c search_path=${schema},public`, max: 2 });
  try {
    const client = await pool.connect();
    try {
      await cmsMigration(client);
      await client.query(`CREATE TABLE url_rewrite(id integer PRIMARY KEY,request_path text,target_path text,entity_uuid uuid);
        CREATE TABLE setting(name text PRIMARY KEY,value text,is_json boolean DEFAULT FALSE);
        CREATE TABLE product(product_id integer PRIMARY KEY,sku text,price numeric);
        CREATE TABLE product_description(product_description_id integer PRIMARY KEY,name text,url_key text);
        CREATE TABLE product_inventory(product_inventory_id integer PRIMARY KEY,qty integer);
        CREATE TABLE "order"(order_id integer PRIMARY KEY,total numeric,payment_status text);
        CREATE TABLE order_item(order_item_id integer PRIMARY KEY,qty integer);
        CREATE TABLE shusha_payment_quote(order_id integer PRIMARY KEY,revision integer,amount numeric,bank_details jsonb);
        CREATE TABLE shusha_payment_receipt(receipt_id integer PRIMARY KEY,reference text,amount numeric);
        CREATE TABLE shusha_payment_receipt_registry(reference text PRIMARY KEY,order_key text);
        CREATE TABLE shusha_bridge_payment_quote(order_id text PRIMARY KEY,revision integer);
        CREATE TABLE shusha_bridge_payment_receipt(reference text PRIMARY KEY,amount numeric);
        CREATE TABLE other_unrelated_content(id integer PRIMARY KEY,content text);
        INSERT INTO setting VALUES('storeName','Original fixture',FALSE);
        INSERT INTO product VALUES(1,'SHUSHA-L9998',10.00);
        INSERT INTO product_description VALUES(1,'Synthetic product','fixture-product');
        INSERT INTO product_inventory VALUES(1,997);
        INSERT INTO "order" VALUES(1,19.99,'pending');
        INSERT INTO order_item VALUES(1,2);
        INSERT INTO shusha_payment_quote VALUES(1,2,19.99,'{"account":"synthetic-only"}');
        INSERT INTO shusha_payment_receipt VALUES(1,'fixture-receipt',19.99);
        INSERT INTO shusha_payment_receipt_registry VALUES('fixture-receipt','fixture-order');
        INSERT INTO shusha_bridge_payment_quote VALUES('fixture-shopify-order',3);
        INSERT INTO shusha_bridge_payment_receipt VALUES('fixture-other-receipt',29.99);
        INSERT INTO other_unrelated_content VALUES(1,'Original unrelated bytes');`);
      for (const [index, handle] of ['about', 'contact', 'shipping-payment'].entries()) {
        const page = (await client.query("INSERT INTO cms_page(layout,status) VALUES('oneColumn',TRUE) RETURNING *")).rows[0];
        await client.query(`INSERT INTO cms_page_description(cms_page_description_cms_page_id,url_key,name,content,meta_title,meta_keywords,meta_description)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [page.cms_page_id, handle, `Original ${handle}`, 'Original content bytes', 'Preserved SEO title', 'Preserved SEO keywords', 'Preserved SEO description']);
        await client.query('INSERT INTO url_rewrite VALUES($1,$2,$3,$4)', [index + 1, `/${handle}`, `/page/${handle}`, page.uuid]);
      }
    } finally { client.release(); }
    const expectedDatabase = url.pathname.slice(1);
    const run = async (action = 'dry-run', extra = {}, fixtureProfile = profile) => {
      const client = await pool.connect(); let cleanupError;
      try { return await applyCompanyContent(client, { action, expectedDatabase, ...extra }, { profile: fixtureProfile }); }
      catch (error) { cleanupError = error.connectionCleanupError; throw error; }
      finally { client.release(cleanupError); }
    };
    const snapshot = async () => {
      const tables = (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', [schema])).rows;
      const state = {};
      for (const { table_name } of tables) state[table_name] = (await pool.query(`SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb) AS value FROM (SELECT to_jsonb(t) AS v FROM "${schema}"."${table_name}" t) snapshot`)).rows[0].value;
      return state;
    };
    await work({ pool, run, snapshot, expectedDatabase });
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

sqlTest('dry run does not write and returns only safe counts, handles and a review digest', async ({ run, snapshot }) => {
  const before = await snapshot();
  const result = await run();
  assert.equal(result.status, 'dry-run-complete'); assert.equal(result.counts.changedPages, 2);
  assert.match(result.reviewContentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await snapshot(), before);
  const serialized = JSON.stringify(result);
  for (const privateValue of ['Example road', 'help@example.invalid', 'synthetic-only', 'Original content bytes', 'fixture-receipt']) assert.equal(serialized.includes(privateValue), false);
});

sqlTest('apply updates only name/content and preserves all identities, status, layout, SEO, rewrites and business data', async ({ run, snapshot }) => {
  const before = await snapshot(); const preview = await run();
  const applied = await run('apply', { expectedContentSha256: preview.reviewContentSha256 });
  assert.equal(applied.status, 'applied'); assert.equal(applied.protectedDataVerified, true);
  const after = await snapshot();
  for (const table of Object.keys(before).filter(table => table !== 'cms_page_description')) assert.deepEqual(after[table], before[table], table);
  for (const description of before.cms_page_description) {
    const updated = after.cms_page_description.find(row => row.cms_page_description_id === description.cms_page_description_id);
    if (description.url_key === 'shipping-payment') assert.deepEqual(updated, description);
    else {
      const immutable = row => Object.fromEntries(Object.entries(row).filter(([field]) => !['name', 'content'].includes(field)));
      assert.deepEqual(immutable(updated), immutable(description));
      const rows = JSON.parse(updated.content); assert.equal(rows[0].columns[0].data.blocks.length, 1);
    }
  }
  assert.equal((await run('verify')).status, 'verified');
  const repeatedPreview = await run(); assert.equal(repeatedPreview.counts.changedPages, 0);
  assert.equal((await run('apply', { expectedContentSha256: repeatedPreview.reviewContentSha256 })).counts.changedPages, 0);
  assert.deepEqual(await snapshot(), after);
});

sqlTest('missing about is reported without creation and blocks apply and verify', async ({ pool, run, snapshot }) => {
  await pool.query("DELETE FROM cms_page WHERE cms_page_id=(SELECT cms_page_description_cms_page_id FROM cms_page_description WHERE url_key='about')");
  const before = await snapshot(); const preview = await run();
  assert.equal(preview.status, 'missing-pages'); assert.deepEqual(preview.missingPages, ['about']);
  await assert.rejects(run('apply', { expectedContentSha256: preview.reviewContentSha256 }), /missing/);
  await assert.rejects(run('verify'), /missing/); assert.deepEqual(await snapshot(), before);
});

sqlTest('wrong target database is rejected before any content changes', async ({ run, snapshot }) => {
  const before = await snapshot();
  await assert.rejects(run('dry-run', { expectedDatabase: 'incorrect_synthetic_test' }), /exact target/);
  assert.deepEqual(await snapshot(), before);
});

sqlTest('an intervening CMS edit or changed public profile invalidates the reviewed apply', async ({ pool, run, snapshot }) => {
  const preview = await run();
  await pool.query("UPDATE cms_page_description SET content='New merchant edit' WHERE url_key='contact'");
  const edited = await snapshot();
  await assert.rejects(run('apply', { expectedContentSha256: preview.reviewContentSha256 }), /changed after review/);
  assert.deepEqual(await snapshot(), edited);
  const fresh = await run();
  await assert.rejects(run('apply', { expectedContentSha256: fresh.reviewContentSha256 }, { ...profile, shopName: 'Changed fixture name' }), /changed after review/);
  await assert.rejects(run('apply', { expectedContentSha256: fresh.reviewContentSha256 }, { ...profile, address: { ...profile.address, line1: 'Changed public address' } }), /changed after review/);
  assert.deepEqual(await snapshot(), edited);
});

sqlTest('a trigger changing inventory or receipts causes the complete company update to roll back', async ({ pool, run, snapshot }) => {
  await pool.query(`CREATE FUNCTION contaminate_company_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE product_inventory SET qty=999; UPDATE shusha_payment_receipt SET amount=1; RETURN NEW; END $$;
    CREATE TRIGGER company_contamination AFTER UPDATE ON cms_page_description FOR EACH ROW EXECUTE FUNCTION contaminate_company_update()`);
  const before = await snapshot(); const preview = await run();
  await assert.rejects(run('apply', { expectedContentSha256: preview.reviewContentSha256 }), /Protected business data/);
  assert.deepEqual(await snapshot(), before);
});

sqlTest('a failure on the second page rolls back the first page and preserves all records', async ({ pool, run, snapshot }) => {
  await pool.query(`CREATE FUNCTION reject_contact_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.url_key='contact' THEN RAISE EXCEPTION 'synthetic second-page failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER company_second_page_failure BEFORE UPDATE ON cms_page_description FOR EACH ROW EXECUTE FUNCTION reject_contact_update()`);
  const before = await snapshot(); const preview = await run();
  await assert.rejects(run('apply', { expectedContentSha256: preview.reviewContentSha256 }), /synthetic second-page failure/);
  assert.deepEqual(await snapshot(), before);
});
