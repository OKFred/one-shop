import { randomUUID } from 'node:crypto';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Native v2 descriptions are editor rows; source copy is already HTML-escaped. */
export function descriptionRows(html) {
  return [{ id: `r__${randomUUID()}`, size: 1, columns: [{
    id: `c__${randomUUID()}`, size: 1,
    data: { blocks: [{ id: randomUUID(), type: 'raw', data: { html } }], version: '2.30.2' }
  }] }];
}

// These narrow SQL operations match the native v2 variant contract. The native
// REST controllers are intentionally not imported through private package paths.
export async function createVariantGroup(client, attributeCodes, groupId, sourceId) {
  assert(Array.isArray(attributeCodes) && attributeCodes.length === 2 && new Set(attributeCodes).size === 2,
    'Managed material groups require exactly two distinct select attributes');
  await client.query('BEGIN');
  try {
    const attributes = (await client.query(
      `SELECT a.attribute_id,a.attribute_code FROM attribute a JOIN attribute_group_link l
       ON l.attribute_id=a.attribute_id WHERE a.attribute_code=ANY($1::text[])
       AND a.type='select' AND l.group_id=$2`, [attributeCodes, groupId]
    )).rows;
    assert(attributes.length === 2, 'Material variant attributes must belong to the selected attribute group');
    const ids = attributeCodes.map(code => attributes.find(row => row.attribute_code === code)?.attribute_id);
    assert(ids.every(Number.isSafeInteger), 'Material select attribute IDs are unresolved');
    const row = (await client.query(
      'INSERT INTO variant_group(attribute_group_id,attribute_one,attribute_two) VALUES($1,$2,$3) RETURNING *',
      [groupId, ...ids]
    )).rows[0];
    if (sourceId) {
      const reservation = await client.query(
        `UPDATE shusha_material_publication SET group_id=$1,updated_at=now()
         WHERE source_id=$2 AND group_id IS NULL AND status='preparing'`, [row.variant_group_id, sourceId]
      );
      assert(reservation.rowCount === 1, 'Frozen publication group reservation changed');
    }
    await client.query('COMMIT');
    return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function linkVariant(client, groupUuid, productUuid) {
  await client.query('BEGIN');
  try {
    const group = (await client.query('SELECT * FROM variant_group WHERE uuid=$1 FOR UPDATE', [groupUuid])).rows[0];
    const product = (await client.query('SELECT * FROM product WHERE uuid=$1 FOR UPDATE', [productUuid])).rows[0];
    assert(group && product && product.group_id === group.attribute_group_id, 'Material variant group ownership differs');
    assert(!product.variant_group_id || product.variant_group_id === group.variant_group_id, 'Product belongs to another variant group');
    const members = (await client.query('SELECT product_id,package_id FROM product WHERE variant_group_id=$1 FOR UPDATE', [group.variant_group_id])).rows;
    const packages = [...new Set(members.map(row => row.package_id).filter(Boolean))];
    assert(packages.length <= 1, 'Variant group contains conflicting parcel definitions');
    const packageId = packages[0] || product.package_id || null;
    await client.query('UPDATE product SET variant_group_id=$1,package_id=$2 WHERE product_id=$3',
      [group.variant_group_id, packageId, product.product_id]);
    if (packageId) await client.query('UPDATE product SET package_id=$1 WHERE variant_group_id=$2 AND package_id IS DISTINCT FROM $1',
      [packageId, group.variant_group_id]);
    await client.query('COMMIT');
    return product;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function rewriteProduct(client, product) {
  const rows = (await client.query(
    `SELECT d.url_key,cd.url_key AS category_path FROM product_description d
     JOIN product p ON p.product_id=d.product_description_product_id
     JOIN category_description cd ON cd.category_description_category_id=p.category_id
     WHERE p.product_id=$1 AND p.uuid=$2`, [product.product_id, product.uuid]
  )).rows;
  assert(rows.length === 1 && ['dresses', 'tops', 'pants'].includes(rows[0].category_path), 'Material product category path is unresolved');
  const { url_key: slug, category_path: category } = rows[0];
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), 'Material product URL key is unsafe');
  const requestPath = `/${category}/${slug}`;
  const owners = (await client.query('SELECT entity_uuid,entity_type FROM url_rewrite WHERE request_path=$1', [requestPath])).rows;
  assert(owners.every(row => row.entity_uuid === product.uuid && row.entity_type === 'product'), 'Material path belongs to another entity');
  await client.query(
    `INSERT INTO url_rewrite(entity_type,entity_uuid,request_path,target_path) VALUES('product',$1,$2,$3)
     ON CONFLICT(entity_uuid) DO UPDATE SET request_path=EXCLUDED.request_path,target_path=EXCLUDED.target_path
     WHERE url_rewrite.entity_type='product'`, [product.uuid, requestPath, `/product/${product.uuid}`]
  );
}

function controller(action) {
  return async (request, response, next) => {
    try { response.status(200).json({ data: await action(request) }); }
    catch (error) { response.status(500).json({ error: { message: error.message } }); }
  };
}

export async function createCatalogServices() {
  const [{ pool }, catalog, qb, { getConfig }, settings] = await Promise.all([
    import('@evershop/evershop/lib/postgres'),
    import('@evershop/evershop/catalog/services'),
    import('@evershop/postgres-query-builder'),
    import('@evershop/evershop/lib/util/getConfig'),
    import('@evershop/evershop/setting/services')
  ]);
  try {
    await settings.refreshSetting();
    assert(settings.getStoreCurrency() === 'USD', 'Material publisher requires actual USD store currency');
    assert(getConfig('system.file_storage', 'local') === 'local', 'Material publisher requires local file storage');
  } catch (error) { await pool.end(); throw error; }
  return {
    pool, qb, createAttribute: catalog.createAttribute, createProduct: catalog.createProduct,
    updateProduct: catalog.updateProduct, descriptionRows,
    // Bind each call to a dedicated transaction while advisory locks stay on the
    // outer connection. Group reservation is completed with the frozen ledger.
    createGroup: controller(async request => {
      const client = await pool.connect();
      try { return await createVariantGroup(client, request.body.attribute_codes, request.body.attribute_group_id, request.body.source_id); }
      finally { client.release(); }
    }),
    addItem: controller(async request => {
      const client = await pool.connect();
      try { return await linkVariant(client, request.params.id, request.body.product_id); }
      finally { client.release(); }
    }),
    rewriteProduct: async product => {
      const client = await pool.connect();
      try { await rewriteProduct(client, product); } finally { client.release(); }
    }
  };
}
