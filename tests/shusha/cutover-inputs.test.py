"""Synthetic acceptance and runtime derivation tests; no Docker/provider calls."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

module = Path(__file__).resolve().parents[2] / 'deployment/cutover-inputs.py'
spec = importlib.util.spec_from_file_location('cutover_inputs', module)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
IMAGE = 'sha256:' + 'a' * 64


class CutoverInputsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='shusha-synthetic-cutover-')
        self.root = Path(self.temporary.name)
        self.release = self.root / 'release'
        self.source = self.release / 'source'
        self.backup = self.root / 'backup'
        self.shared = self.root / 'shared-v2'
        for folder in ('source/packages/evershop', 'source/deployment', 'config-candidate', 'private-candidate'):
            (self.release / folder).mkdir(parents=True, exist_ok=True)
        (self.backup / 'config').mkdir(parents=True)
        for folder in ('private', 'config-maintenance', 'config-runtime'):
            (self.shared / folder).mkdir(parents=True, exist_ok=True)
        (self.source / 'packages/evershop/package.json').write_text('{"version":"2.2.1"}')
        self.config = {'system': {'jobs': [], 'notification_emails': {
            name: {'enabled': False} for name in ('order_confirmation', 'customer_welcome', 'shipment_created', 'shipment_delivered')}}}
        self.session = {'secret': 'synthetic-session-secret'}
        (self.source / 'deployment/config.shusha.json').write_text(json.dumps(self.config))
        self.accepted_config = copy.deepcopy(self.config)
        self.accepted_config['system']['session'] = self.session
        for name in ('default.json', 'production.json'):
            (self.release / 'config-candidate' / name).write_text(json.dumps(self.accepted_config))
            (self.backup / 'config' / name).write_text(json.dumps({'system': {'session': self.session}}))
        self.env = {'DB_HOST': 'pg', 'DB_PORT': '5432', 'DB_USER': 'application', 'DB_PASSWORD': 'synthetic-db-password',
                    'DB_NAME': 'shusha_v2_candidate', **{name: 'synthetic-' + name for name in
                    ('JWT_ADMIN_SECRET', 'JWT_ADMIN_REFRESH_SECRET', 'JWT_CUSTOMER_SECRET', 'JWT_CUSTOMER_REFRESH_SECRET')}}
        self.write_env(self.release / 'candidate.env', self.env)
        self.write_env(self.release / 'private-candidate/supplier.env', {'SUUSHA_PRICE_API_KEY': 'synthetic-supplier-token'})
        (self.release / 'private-candidate/receiving.json').write_text('{"configured":false}')
        old_env = {name: value for name, value in self.env.items() if name.startswith('DB_')}
        old_env['DB_NAME'] = 'legacy_store'
        (self.backup / 'old-container.private.json').write_text(json.dumps([{'Config': {'Env': [f'{k}={v}' for k, v in old_env.items()]}}]))

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def write_env(filename, values):
        filename.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))

    def accepted(self):
        return {**helper.inputs(self.release, IMAGE), **{name: True for name in helper.FLAGS}}

    def test_seal_requires_each_positive_acceptance_and_exact_image(self):
        accepted = self.accepted()
        helper.validate(accepted, helper.inputs(self.release, IMAGE))
        for name in helper.FLAGS:
            bad = {**accepted, name: False}
            with self.assertRaises(ValueError):
                helper.validate(bad, helper.inputs(self.release, IMAGE))
        with self.assertRaises(ValueError):
            helper.validate(accepted, helper.inputs(self.release, 'sha256:' + 'b' * 64))

    def test_each_sealed_input_change_is_rejected(self):
        for field in helper.HASHES:
            accepted = self.accepted()
            accepted[field] = '0' * 64
            with self.assertRaises(ValueError):
                helper.validate(accepted, helper.inputs(self.release, IMAGE))
        accepted = self.accepted()
        (self.source / 'reviewed.js').write_text('export const changed=true;')
        with self.assertRaises(ValueError):
            helper.validate(accepted, helper.inputs(self.release, IMAGE))

    def test_notifications_jobs_and_core_version_fail_closed(self):
        for name in ('order_confirmation', 'customer_welcome', 'shipment_created', 'shipment_delivered'):
            changed = copy.deepcopy(self.accepted_config)
            changed['system']['notification_emails'][name]['enabled'] = True
            (self.release / 'config-candidate/default.json').write_text(json.dumps(changed))
            with self.assertRaises(ValueError):
                helper.inputs(self.release, IMAGE)
        (self.release / 'config-candidate/default.json').write_text(json.dumps(self.accepted_config))
        changed = copy.deepcopy(self.accepted_config)
        changed['system']['jobs'] = [{'enabled': True}]
        (self.release / 'config-candidate/default.json').write_text(json.dumps(changed))
        with self.assertRaises(ValueError):
            helper.inputs(self.release, IMAGE)
        (self.release / 'config-candidate/default.json').write_text(json.dumps(self.accepted_config))
        (self.source / 'packages/evershop/package.json').write_text('{"version":"2.3.0"}')
        with self.assertRaises(ValueError):
            helper.inputs(self.release, IMAGE)

    def test_runtime_preserves_credentials_and_session_with_exact_two_job_schedules(self):
        helper.prepare(self.release, self.backup, self.shared, 'shusha_v2_production', 'https://shop.example.com')
        runtime = helper.read_env(self.shared / 'private/productionruntime.env')
        maintenance = helper.read_env(self.shared / 'private/maintenance.env')
        self.assertEqual(runtime['DB_PASSWORD'], self.env['DB_PASSWORD'])
        self.assertEqual(runtime['JWT_CUSTOMER_SECRET'], self.env['JWT_CUSTOMER_SECRET'])
        self.assertEqual(runtime['DB_NAME'], 'shusha_v2_production')
        self.assertEqual(runtime['TZ'], 'Asia/Shanghai')
        self.assertNotIn('SHUSHA_PRODUCTION_MIGRATION_GUARD', runtime)
        self.assertEqual(maintenance['SHUSHA_PRODUCTION_MIGRATION_GUARD'], 'v2.2.1:shusha_v2_production')
        config = json.loads((self.shared / 'config-runtime/production.json').read_text())
        self.assertEqual(config['system']['session'], self.session)
        self.assertEqual([job['schedule'] for job in config['system']['jobs']], ['0 9 * * *', '0 10 * * 2,5'])
        self.assertEqual([job['resolve'] for job in config['system']['jobs']], ['scripts/jobs/source-sync.js', 'scripts/jobs/material-drop.js'])
        self.assertEqual(json.loads((self.shared / 'config-maintenance/default.json').read_text())['system']['jobs'], [])

    def test_changed_session_unknown_supplier_variable_and_unsafe_origin_are_rejected(self):
        for home in ('http://shop.example.com', 'https://shop.example.com/path', 'https://name:secret@shop.example.com'):
            with self.assertRaises(ValueError):
                helper.prepare(self.release, self.backup, self.shared, 'shusha_v2_production', home)
        self.write_env(self.release / 'private-candidate/supplier.env', {'SUUSHA_PRICE_API_KEY': 'synthetic-token', 'NODE_CONFIG': '{}'})
        with self.assertRaises(ValueError):
            helper.prepare(self.release, self.backup, self.shared, 'shusha_v2_production', 'https://shop.example.com')
        self.write_env(self.release / 'private-candidate/supplier.env', {'SUUSHA_PRICE_API_KEY': 'synthetic-token'})
        (self.backup / 'config/production.json').write_text('{"system":{"session":{"secret":"different-synthetic-secret"}}}')
        with self.assertRaises(ValueError):
            helper.prepare(self.release, self.backup, self.shared, 'shusha_v2_production', 'https://shop.example.com')

    def test_session_default_fields_and_production_overrides_match_candidate_preparation(self):
        (self.backup / 'config/default.json').write_text('{"system":{"session":{"cookie":{"name":"synthetic-cookie"},"secret":"old-synthetic-secret"}}}')
        (self.backup / 'config/production.json').write_text('{"system":{"session":{"secret":"production-synthetic-secret"}}}')
        combined = {'cookie': {'name': 'synthetic-cookie'}, 'secret': 'production-synthetic-secret'}
        config = copy.deepcopy(self.config)
        config['system']['session'] = combined
        for name in ('default.json', 'production.json'):
            (self.release / 'config-candidate' / name).write_text(json.dumps(config))
        helper.prepare(self.release, self.backup, self.shared, 'shusha_v2_production', 'https://shop.example.com')
        self.assertEqual(json.loads((self.shared / 'config-runtime/production.json').read_text())['system']['session'], combined)

    def test_private_source_and_duplicate_environment_are_rejected(self):
        (self.source / '.env').write_text('SYNTHETIC=value')
        with self.assertRaises(ValueError):
            helper.inputs(self.release, IMAGE)
        filename = self.root / 'synthetic.env'
        filename.write_text('DB_NAME=first\nDB_NAME=second\n')
        with self.assertRaises(ValueError):
            helper.read_env(filename)


if __name__ == '__main__':
    unittest.main()
