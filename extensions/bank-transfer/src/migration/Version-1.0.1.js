import { countries } from '@evershop/evershop/lib/locale/countries';

// Called only after core v2 migrations. The old quote/receipt schema is
// unchanged; native backfill identified manual_quote as core, so correct the
// stable method identity without changing any money, order or shipment state.
export default async (connection) => {
  const zoneUuid = 'ed8f7156-3636-4d8b-8e64-0e894795d7f6';
  const zone = (await connection.query(`INSERT INTO shipping_zone(uuid,name) VALUES($1,'SHUSHA worldwide quotation') ON CONFLICT(uuid) DO UPDATE SET name=EXCLUDED.name RETURNING shipping_zone_id`, [zoneUuid])).rows[0];
  for (const { code } of countries) {
    await connection.query('INSERT INTO shipping_zone_country(zone_id,country) VALUES($1,$2) ON CONFLICT(zone_id,country) DO NOTHING', [zone.shipping_zone_id, code]);
  }
  await connection.query(`INSERT INTO shipping_zone_provider(zone_id,provider_code,is_enabled) VALUES($1,'shusha',TRUE) ON CONFLICT(zone_id,provider_code) DO NOTHING`, [zone.shipping_zone_id]);
  await connection.query(`UPDATE "order" SET shipping_method_data=jsonb_set(shipping_method_data,'{provider_code}','"shusha"'::jsonb) WHERE payment_method='banktransfer' AND shipping_method_data->>'method_code'='manual_quote' AND shipping_method_data->>'provider_code'='core'`);
  // Persisted v1 cart shipping columns were dropped by core. Force checkout to
  // select the new provider; don't invent address-dependent fingerprints.
  await connection.query(`UPDATE cart SET shipping_method_data=NULL WHERE shipping_method_data->>'method_code'='manual_quote' AND shipping_method_data->>'provider_code'='core'`);
};
