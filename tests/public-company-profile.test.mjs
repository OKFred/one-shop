import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePublicMerchantProfile, loadPublicMerchantProfile, publicAddressLines, publicMapUrl, shopifyPublicProfileSettings, buildPublicCompanyPages } from '../scripts/merchant/public-profile.mjs';
import { normalizePublicContent, validatePreparationInput } from '../scripts/shopify/prepare-store.mjs';
import { writeMerchantThemeConfig, buildContentPlan } from '../scripts/shopify/sync-content.mjs';

const profile = () => ({ schemaVersion: 1, shopName: 'SHUSHA', legalName: '',
  address: { line1: 'Suite 9, 10 Example Road', line2: '', city: 'Example City', postalCode: '12345', country: 'Example Country', countryCode: 'ZZ' },
  support: { email: '', whatsappSriLanka: 'https://wa.me/12345678901', whatsappChina: '' } });

test('public boundary rejects extra/private fields and unsafe contact links', () => {
  for (const extra of [{ bankDetails: {} }, { apiKey: 'synthetic' }, { customer: {} }]) assert.throws(() => validatePublicMerchantProfile({ ...profile(), ...extra }), /unsupported fields/);
  for (const link of ['javascript:alert(1)', 'https://wa.me/12345678901?token=synthetic', 'https://wa.me@other.invalid/12345678901', 'https://wa.me/01234567890']) assert.throws(() => validatePublicMerchantProfile({ ...profile(), support: { whatsappSriLanka: link } }), /WhatsApp/);
  assert.throws(() => validatePublicMerchantProfile({ ...profile(), support: { email: 'help@example.invalid\r\nBcc:private@example.invalid' } }), /text/);
  assert.throws(() => validatePublicMerchantProfile({ ...profile(), address: { line1: 'Only one field' } }), /city and country/);
});

test('unconfirmed identity/contact fields stay empty, maps only use the confirmed address', () => {
  const empty = validatePublicMerchantProfile({ schemaVersion: 1, shopName: 'SHUSHA' });
  assert.equal(empty.legalName, ''); assert.equal(empty.support.email, ''); assert.deepEqual(publicAddressLines(empty), []); assert.equal(publicMapUrl(empty), '');
  const url = new URL(publicMapUrl(profile()));
  assert.equal(url.origin, 'https://www.google.com'); assert.equal(url.searchParams.get('query'), publicAddressLines(profile()).join(', '));
  assert.equal(shopifyPublicProfileSettings(profile()).shusha_business_name, '');
});

test('generated body copy escapes supplied names and stays compatible with both CMS representations', () => {
  const input = { ...profile(), shopName: 'SHUSHA & <test>', legalName: 'Example & Company' };
  const pages = buildPublicCompanyPages(input);
  for (const page of pages) {
    assert.equal(normalizePublicContent(page.bodyHtml), page.bodyHtml);
    assert.ok(!page.bodyHtml.includes('<test>')); assert.match(page.bodyHtml, /SHUSHA &amp; &lt;test&gt;/);
    assert.doesNotMatch(page.bodyHtml, /guaranteed|free shipping|24\/7|registered in|return within/i);
  }
  assert.deepEqual(pages.map(page => page.templateSuffix), ['about', 'contact']);
});

test('company templates remain part of page synchronization and unrelated templates stay untouched', () => {
  const pages = buildPublicCompanyPages(profile()).map((page, i) => ({ ...page, sourceUuid: `synthetic-page-${i}` }));
  const plan = buildContentPlan({ pages });
  assert.equal(plan.pages[0].templateSuffix, 'about'); assert.equal(plan.pages[1].templateSuffix, 'contact'); assert.equal(plan.pages[0].isPublished, false);
  assert.throws(() => buildContentPlan({ pages: [{ ...pages[0], templateSuffix: 'unreviewed-template' }] }), /Unreviewed/);
  assert.equal(buildContentPlan({ pages: [{ ...pages[0], templateSuffix: undefined }] }).pages[0].templateSuffix, undefined);
  assert.throws(() => validatePreparationInput({ schemaVersion: 1, approvedPageHandles: [], publicProfile: profile(), support: { whatsappSriLanka: 'https://wa.me/12345678902' } }), /match/);
});

test('profile reads are bounded, private, schema checked and missing explicit paths fail closed', async () => {
  const root = path.resolve('private', `company-test-${process.pid}-${Date.now()}`); await fs.mkdir(root, { recursive: true });
  const filename = path.join(root, 'public-company-profile.json');
  try {
    await fs.writeFile(filename, JSON.stringify(profile()));
    assert.deepEqual(await loadPublicMerchantProfile({ env: { SHUSHA_PUBLIC_PROFILE_FILE: filename } }), validatePublicMerchantProfile(profile()));
    await fs.writeFile(filename, JSON.stringify({ ...profile(), accountNumber: 'synthetic' }));
    await assert.rejects(loadPublicMerchantProfile({ env: { SHUSHA_PUBLIC_PROFILE_FILE: filename } }), /^Error: Public company profile is unavailable or invalid$/);
    await fs.writeFile(filename, ' '.repeat(32_769));
    await assert.rejects(loadPublicMerchantProfile({ env: { SHUSHA_PUBLIC_PROFILE_FILE: filename } }), /unavailable or invalid/);
    await assert.rejects(loadPublicMerchantProfile({ env: { SHUSHA_PUBLIC_PROFILE_FILE: path.join(root, 'missing.json') } }), /unavailable or invalid/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('both shop theme settings derive from the private profile without writing merchant facts into source', async () => {
  const root = path.resolve('private', `company-theme-test-${process.pid}-${Date.now()}`); await fs.mkdir(root, { recursive: true });
  const themePath = path.resolve('shopify/theme'); const before = await fs.readFile(path.join(themePath, 'config/settings_data.json'), 'utf8');
  try {
    const badOutput = path.join(root, 'conflicting-theme');
    await assert.rejects(writeMerchantThemeConfig({ themePath, outputPath: badOutput, merchant: { publicProfile: profile(), support: { whatsappSriLanka: 'https://wa.me/12345678902' } } }), /must match/);
    await assert.rejects(fs.stat(badOutput), { code: 'ENOENT' });
    await writeMerchantThemeConfig({ themePath, outputPath: path.join(root, 'theme'), merchant: { publicProfile: profile() } });
    const settings = JSON.parse(await fs.readFile(path.join(root, 'theme/config/settings_data.json'), 'utf8')).current;
    for (const [key, value] of Object.entries(shopifyPublicProfileSettings(profile()))) assert.equal(settings[key], value);
    assert.equal(await fs.readFile(path.join(themePath, 'config/settings_data.json'), 'utf8'), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
