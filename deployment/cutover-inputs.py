#!/usr/bin/env python3
"""Private cutover input sealing. Never emits credentials or file contents."""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

FLAGS = ('buildPassed', 'bankIntegrationPassed', 'pricingParityPassed',
         'baselinePassed', 'candidateHttpPassed')
HASHES = ('sourceTreeSha256', 'runtimeConfigSha256', 'candidateEnvSha256',
          'supplierEnvSha256', 'receivingConfigSha256')
SKIP = {'.git', 'node_modules', 'dist', '.evershop', 'private', 'data', 'media',
        'artifacts', 'coverage', '.cache', '__pycache__'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def within(filename, directory):
    filename = Path(filename).resolve(strict=True)
    directory = Path(directory).resolve(strict=True)
    require(filename == directory or directory in filename.parents, 'Path guard rejected an input')
    return filename


def source_hash(directory):
    directory = Path(directory).resolve(strict=True)
    entries = []
    for folder, directories, files in os.walk(directory, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in SKIP)
        for name in directories:
            require(not Path(folder, name).is_symlink(), 'Nested source symlinks require separate review')
        for name in sorted(files):
            if name == '.env' or name.endswith('.private.json') or name.endswith('.private.log'):
                raise ValueError('Private source input is forbidden')
            filename = Path(folder, name)
            require(not filename.is_symlink(), 'Source file symlinks require separate review')
            entries.append((filename.relative_to(directory).as_posix(), digest(filename.read_bytes())))
    require(entries, 'Source input is empty')
    return digest(canonical(sorted(entries)))


def inputs(release, image):
    release = Path(release).resolve(strict=True)
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', image), 'Full immutable image ID is required')
    # The top-level source symlink is deliberate in final rehearsals. The shell
    # separately checks that its resolved destination remains inside the base.
    source = Path(release, 'source').resolve(strict=True)
    require(json.loads((source / 'packages/evershop/package.json').read_text())['version'] == '2.2.1', 'Source must be pinned to v2.2.1')
    config = {}
    for name in ('default.json', 'production.json'):
        config[name] = json.loads(within(release / 'config-candidate' / name, release).read_text())
        system = config[name].get('system', {})
        require(system.get('jobs') == [], 'Candidate jobs must be disabled')
        notifications = system.get('notification_emails', {})
        require(all(notifications.get(key, {}).get('enabled') is False for key in
                    ('order_confirmation', 'customer_welcome', 'shipment_created', 'shipment_delivered')),
                'Candidate notifications must remain disabled')
    return {
        'schemaVersion': 1, 'imageId': image,
        'sourceTreeSha256': source_hash(source),
        'runtimeConfigSha256': digest(canonical(config)),
        'candidateEnvSha256': digest(within(release / 'candidate.env', release).read_bytes()),
        'supplierEnvSha256': digest(within(release / 'private-candidate/supplier.env', release).read_bytes()),
        'receivingConfigSha256': digest(within(release / 'private-candidate/receiving.json', release).read_bytes())
    }


def validate(acceptance, actual):
    require(acceptance.get('schemaVersion') == 1, 'Acceptance schema is invalid')
    require(all(acceptance.get(flag) is True for flag in FLAGS), 'Acceptance is incomplete')
    require(acceptance.get('imageId') == actual['imageId'], 'Accepted image differs')
    require(all(acceptance.get(key) == actual[key] for key in HASHES), 'Accepted inputs changed')


def read_env(filename):
    result = {}
    for line in Path(filename).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        require(separator and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key), 'Runtime environment syntax is invalid')
        require(key not in result and '\x00' not in value, 'Runtime environment has duplicate or invalid entries')
        result[key] = value
    return result


def private_write(filename, content):
    with open(filename, 'x', encoding='utf-8') as output:
        output.write(content)
    os.chmod(filename, 0o600)


def prepare(release, backup, shared, database, home):
    release, backup, shared = map(Path, (release, backup, shared))
    require(re.fullmatch(r'[a-z][a-z0-9_]*_production', database), 'Final database name guard failed')
    require(re.fullmatch(r'https://[A-Za-z0-9.-]+(?::443)?/?', home), 'HTTPS store origin is required')
    old = json.loads((backup / 'old-container.private.json').read_text())[0]
    old_env = dict(item.split('=', 1) for item in old['Config']['Env'])
    candidate = read_env(release / 'candidate.env')
    for key in ('DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'COOKIE_SECRET', 'SESSION_SECRET',
                'JWT_ADMIN_SECRET', 'JWT_ADMIN_REFRESH_SECRET', 'JWT_CUSTOMER_SECRET', 'JWT_CUSTOMER_REFRESH_SECRET'):
        if key in old_env:
            require(candidate.get(key) == old_env[key], 'Candidate database or session configuration differs')
    require(all(candidate.get(key) for key in ('DB_HOST', 'DB_USER', 'DB_PASSWORD', 'JWT_ADMIN_SECRET',
            'JWT_ADMIN_REFRESH_SECRET', 'JWT_CUSTOMER_SECRET', 'JWT_CUSTOMER_REFRESH_SECRET')), 'Runtime credentials are incomplete')
    require(not any(key in candidate for key in ('NODE_CONFIG', 'NODE_CONFIG_DIR', 'bootstrapContext')), 'Runtime overrides require review')
    supplier = read_env(release / 'private-candidate/supplier.env')
    require(set(supplier) <= {'SUUSHA_PRICE_API_URL', 'SUUSHA_PRICE_API_KEY'} and supplier.get('SUUSHA_PRICE_API_KEY'), 'Private supplier configuration is incomplete')
    candidate.update(supplier)
    candidate.update(DB_NAME=database, PORT='3000', TZ='Asia/Shanghai', NODE_ENV='production',
                     EVERSHOP_HOME_URL=home.rstrip('/'), PRIVATE_DATA_DIR='/app/data',
                     MATERIAL_LIBRARY_DIR='/app/data/material-library', MATERIAL_MEDIA_DIR='/app/media/source-library',
                     SOURCE_SYNC_BACKUP_DIR='/private/source-price-backups', SHUSHA_WISE_RECEIVING_CONFIG='/private/receiving.json')
    candidate.pop('SHUSHA_PRODUCTION_MIGRATION_GUARD', None)
    candidate.pop('MATERIAL_PUBLICATION_PACKAGE_ID', None)
    text = ''.join(f'{key}={value}\n' for key, value in sorted(candidate.items()))
    private_write(shared / 'private/productionruntime.env', text)
    private_write(shared / 'private/maintenance.env', text + f'SHUSHA_PRODUCTION_MIGRATION_GUARD=v2.2.1:{database}\n')
    config = json.loads((release / 'source/deployment/config.shusha.json').read_text())
    require(config.get('system', {}).get('jobs') == [], 'Source maintenance jobs must be disabled')
    preserved_session = {}
    for name in ('default.json', 'production.json'):
        old_file = backup / 'config' / name
        if old_file.exists():
            session = json.loads(old_file.read_text()).get('system', {}).get('session')
            if session:
                preserved_session.update(session)
    if preserved_session:
        config['system']['session'] = preserved_session
    candidate_config = {name: json.loads((release / 'config-candidate' / name).read_text()) for name in ('default.json', 'production.json')}
    require(all(canonical(config) == canonical(value) for value in candidate_config.values()), 'Final maintenance configuration differs from accepted candidate')
    for name in ('default.json', 'production.json'):
        private_write(shared / 'config-maintenance' / name, json.dumps(config, indent=2) + '\n')
    config['system']['jobs'] = [
        {'name': 'source-sync', 'resolve': 'scripts/jobs/source-sync.js', 'schedule': '0 9 * * *', 'enabled': True},
        {'name': 'material-drop', 'resolve': 'scripts/jobs/material-drop.js', 'schedule': '0 10 * * 2,5', 'enabled': True}
    ]
    for name in ('default.json', 'production.json'):
        private_write(shared / 'config-runtime' / name, json.dumps(config, indent=2) + '\n')


def main(argv):
    mode, *args = argv
    if mode in ('seal', 'verify'):
        actual = inputs(args[0], args[1])
        if mode == 'verify':
            validate(json.loads(within(args[2], args[0]).read_text()), actual)
            print(json.dumps({'status': 'accepted-inputs-verified', 'checks': len(FLAGS) + len(HASHES) + 1}))
        else:
            print(json.dumps(actual, indent=2))
    elif mode == 'prepare':
        require(len(args) == 5, 'Preparation arguments are incomplete')
        prepare(*args)
    else:
        raise ValueError('Unsupported cutover helper mode')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception:
        print(json.dumps({'status': 'cutover-inputs-rejected', 'detailsWithheld': True}), file=sys.stderr)
        sys.exit(1)
