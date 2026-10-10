import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../shopify/theme/', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8');
const json = async file => JSON.parse(await read(file));
const globalSchema = await json('config/settings_schema.json');
const data = await json('config/settings_data.json');
const sectionSchemas = new Map();
for (const file of await readdir(path.join(root, 'sections'))) {
  if (!file.endsWith('.liquid')) continue;
  const match = (await read(`sections/${file}`)).match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/);
  // Native static sections such as main-404 have no configurable schema.
  sectionSchemas.set(file.slice(0, -7), match ? JSON.parse(match[1]) : {});
}

// These are platform restrictions, not expectations copied from merchant values.
// Keep Dawn 16's exact native global customer-account menu contract; its special
// default must not be confused with arbitrary merchant section menu defaults.
function checkMenuDefaults(node, allowNativeAccountMenu = false) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'link_list' && Object.hasOwn(node, 'default')) {
    const nativeAccountMenu = allowNativeAccountMenu && node.id === 'customer_account_menu' &&
      node.default === 'customer-account-main-menu';
    assert(nativeAccountMenu || ['main-menu', 'footer'].includes(node.default), `unsupported link_list default: ${node.id}`);
  }
  Object.values(node).forEach(value => checkMenuDefaults(value, allowNativeAccountMenu));
}

function checkValues(definitions, values, palettes) {
  for (const setting of definitions || []) {
    if (!Object.hasOwn(values, setting.id)) continue;
    const value = values[setting.id];
    if (setting.type === 'range') {
      const steps = (value - setting.min) / (setting.step || 1);
      assert(typeof value === 'number' && Number.isFinite(value) && value >= setting.min && value <= setting.max &&
        Math.abs(steps - Math.round(steps)) < 1e-8, `invalid range: ${setting.id}`);
    }
    if (setting.type === 'select' || setting.type === 'radio') {
      assert(setting.options.some(option => option.value === value), `invalid option: ${setting.id}`);
    }
    if (setting.type === 'color_scheme') assert(Object.hasOwn(palettes, value), `missing color scheme: ${setting.id}`);
  }
}

function checkPalette(schema, values) {
  const groups = schema.flatMap(group => group.settings || []).filter(setting => setting.type === 'color_scheme_group');
  assert.equal(groups.length, 1, 'one native color scheme group is required');
  const group = groups[0], palettes = values[group.id];
  assert(palettes && Object.keys(palettes).length > 0, 'native palette data is required');
  const fieldIds = new Set(group.definition.map(field => field.id));
  const checkRoles = node => {
    if (typeof node === 'string') assert(fieldIds.has(node), `undefined color role: ${node}`);
    else Object.values(node).forEach(checkRoles);
  };
  checkRoles(group.role);
  for (const palette of Object.values(palettes)) {
    for (const field of group.definition) {
      assert(Object.hasOwn(palette.settings, field.id), `incomplete color scheme: ${field.id}`);
      const value = palette.settings[field.id];
      assert(typeof value === 'string', `invalid color scheme value: ${field.id}`);
      if (field.type === 'color') assert(/^#[0-9a-f]{6}$/i.test(value), `invalid color: ${field.id}`);
    }
  }
  checkValues(schema.flatMap(group => group.settings || []), values, palettes);
  return palettes;
}

function checkSections(document, palettes) {
  for (const section of Object.values(document.sections || {})) {
    const schema = sectionSchemas.get(section.type);
    assert(schema, `missing section file: ${section.type}`);
    checkValues(schema.settings, section.settings || {}, palettes);
    for (const block of Object.values(section.blocks || {})) {
      if (block.type === '@app') continue;
      const definition = schema.blocks?.find(item => item.type === block.type);
      assert(definition, `missing block definition: ${section.type}/${block.type}`);
      checkValues(definition.settings, block.settings || {}, palettes);
    }
  }
  for (const id of document.order || []) assert(Object.hasOwn(document.sections || {}, id), `missing ordered section: ${id}`);
}

test('every native and merchant link_list schema uses a supported default', () => {
  checkMenuDefaults(globalSchema, true);
  for (const schema of sectionSchemas.values()) checkMenuDefaults(schema);
  assert.throws(() => checkMenuDefaults({ type: 'link_list', id: 'menu', default: 'shusha-footer' }), /unsupported link_list/);
  assert.doesNotThrow(() => checkMenuDefaults({ type: 'link_list', id: 'customer_account_menu', default: 'customer-account-main-menu' }, true));
  assert.throws(() => checkMenuDefaults({ type: 'link_list', id: 'customer_account_menu', default: 'customer-account-main-menu' }), /unsupported link_list/);
});

test('current and every preset preserve complete native palettes and legal saved settings', () => {
  for (const values of [data.current, ...Object.values(data.presets)]) checkPalette(globalSchema, values);
  for (const [id, value] of [['page_width', 1280], ['spacing_grid_horizontal', 22], ['spacing_grid_vertical', 30], ['animations_hover_elements', 'none']]) {
    assert.throws(() => checkPalette(globalSchema, { ...data.current, [id]: value }), /invalid (range|option)/);
  }
});

test('palette deletion, incomplete roles and stale color selection are rejected', () => {
  assert.throws(() => checkPalette(globalSchema, { ...data.current, color_schemes: undefined }), /palette data/);
  const invalidRole = structuredClone(globalSchema);
  invalidRole.flatMap(group => group.settings || []).find(setting => setting.type === 'color_scheme_group').role.icons = 'undefined-field';
  assert.throws(() => checkPalette(invalidRole, data.current), /undefined color role/);
  const incomplete = structuredClone(data.current);
  delete incomplete.color_schemes['scheme-1'].settings.background;
  assert.throws(() => checkPalette(globalSchema, incomplete), /incomplete color scheme/);
  assert.throws(() => checkPalette(globalSchema, { ...data.current, card_color_scheme: 'uncreated-palette' }), /missing color scheme/);
});

test('all templates and section groups resolve their native section types and color settings', async () => {
  const palettes = checkPalette(globalSchema, data.current);
  for (const folder of ['templates', 'sections']) {
    for (const file of await readdir(path.join(root, folder))) {
      if (file.endsWith('.json')) checkSections(await json(`${folder}/${file}`), palettes);
    }
  }
});

test('header and footer groups remain wired into the full layout with the custom menu instance', async () => {
  const layout = await read('layout/theme.liquid');
  for (const group of ['header', 'footer']) {
    assert.match(layout, new RegExp(`{%[-]?\\s*sections\\s+['"]${group}-group['"]\\s*[-]?%}`));
    const document = await json(`sections/${group}-group.json`);
    assert.equal(document.type, group);
    assert(document.order.some(id => !document.sections[id].disabled));
  }
  const footer = await json('sections/footer-group.json');
  assert.equal(footer.sections.footer.type, 'shusha-footer');
  assert.equal(footer.sections.footer.settings.menu, 'shusha-footer');
});
