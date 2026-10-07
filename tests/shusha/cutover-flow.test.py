"""Linux shell control-flow rehearsals using an isolated fake Docker executable.

Run with Python on Linux/WSL. No Docker socket, database or provider is used.
The genuine baseline comparison itself is covered by migration-baseline.test.mjs.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('cutover_inputs', ROOT / 'deployment/cutover-inputs.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
IMAGE = 'sha256:' + 'a' * 64

DOCKER = r'''#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path
a = sys.argv[1:]
root = Path(os.environ['MOCK_ROOT'])
statefile = root / 'docker-state.json'
s = json.loads(statefile.read_text())
scenario = os.environ['MOCK_SCENARIO']
s['calls'].append(a)
def save(): statefile.write_text(json.dumps(s))
def done(value='', code=0):
    save()
    if value: print(value)
    sys.exit(code)
def item(name): return s['containers'][name]
if a[0] == 'ps':
    name = a[-1].removeprefix('name=^/').removesuffix('$')
    done(item(name)['Id'] if name in s['containers'] else '')
if a[0] == 'inspect':
    name = a[1]
    if name == s['image']: done(s['image'])
    c = item(name)
    if '--format' not in a: done(json.dumps([c]))
    f = a[-1]
    done({'{{.State.Running}}': str(c['State']['Running']).lower(), '{{.Id}}': c['Id'], '{{.Image}}': c['Image']}[f])
if a[:2] == ['image', 'inspect']: done(json.dumps([{'Id': s['image']}]))
if a[0] == 'rename':
    if a[2] in s['containers']: done(code=1)
    s['containers'][a[2]] = s['containers'].pop(a[1]); done()
if a[0] == 'stop': item(a[-1])['State']['Running'] = False; done()
if a[0] == 'start': item(a[-1])['State']['Running'] = True; done()
if a[0] == 'create':
    name = a[a.index('--name')+1]
    if name in s['containers']: done(code=1)
    mounts=[]
    for i,value in enumerate(a):
        if value == '-v':
            source,destination,*rest = a[i+1].split(':')
            mounts.append({'Source':source,'Destination':destination,'Type':'bind'})
    item_new={'Id':name+'-id','Image':s['image'],'State':{'Running':False},'Mounts':mounts}
    s['containers'][name]=item_new; done(name)
if a[0] == 'exec':
    b = a[1:]
    if b[0]=='-i': b=b[1:]
    name,command,*arguments=b
    if command=='psql':
        if scenario=='preflight-query-failed': done(code=1)
        query = arguments[-1]
        if 'pg_stat_activity' in query:
            target = re.search(r"\bdatname='([^']+)'", query)
            if not target or "backend_type='client backend'" not in query: done(code=1)
            observer_pid = 101
            connections = [{'datname':arguments[arguments.index('-d')+1],
                            'backend_type':'client backend','pid':observer_pid},
                           *s['clientConnections']]
            exclude_self = bool(re.search(r'\bpid\s*<>\s*pg_backend_pid\s*\(\s*\)', query))
            count = sum(connection['datname']==target.group(1)
                        and connection['backend_type']=='client backend'
                        and (not exclude_self or connection['pid']!=observer_pid)
                        for connection in connections)
            s['connectionCounts'].append(count)
            done(str(count))
        done()
    if command=='pg_dump': done('synthetic-custom-dump')
    if command=='createdb': s['databaseCreated']=True; done()
    if command=='pg_restore': sys.stdin.read(); done()
    if command=='node':
        if arguments[0]=='-e':
            if 'readFileSync' in arguments[1]: done('1.2.2')
            done(code=1 if scenario.startswith('health-') else 0)
        filename=arguments[0]
        private=next(Path(m['Source']) for m in item(name)['Mounts'] if m['Destination']=='/private')
        if filename.endswith('capture-baseline.mjs'):
            output=arguments[arguments.index('--output')+1]
            (private / output.removeprefix('/private/')).write_text('{"synthetic":true}')
            done('{"status":"captured","counts":{"orders":4}}')
        if filename.endswith('migrate-v2.mjs'): done('{"status":"verified"}', 1 if scenario=='migration-failed' else 0)
        if filename.endswith('adapt-store-content.mjs'):
            done(json.dumps({'status':'applied' if '--apply' in arguments else 'verified','packageId':1}))
        if filename.endswith('verify-baseline.mjs'):
            rollback = 'pre-public-v2.private.json' in arguments[-1]
            done('{"status":"mismatch"}' if rollback and scenario=='health-new-order' else '{"status":"verified"}',
                 2 if rollback and scenario=='health-new-order' else 0)
        if filename.endswith('runtime-processes.mjs'):
            done('{"status":"verified","counts":{"cronjob":1,"eventManager":1,"unreadable":0}}')
done(code=1)
'''


@unittest.skipUnless(os.name == 'posix', 'Shell rehearsal requires Linux or WSL')
class CutoverFlowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='shusha-cutover-mock-')
        self.root = Path(self.temporary.name)
        self.release = self.root / 'releases/final'
        self.backup = self.root / 'backups'
        self.source = self.release / 'source'
        self.bin = self.root / 'fake-bin'
        for folder in (self.backup, self.bin, self.source / 'deployment', self.source / 'packages/evershop',
                       self.release / 'config-candidate', self.release / 'private-candidate', self.root / 'old/library/jobs',
                       self.root / 'old/media', self.root / 'old/wise', self.root / 'old/config'):
            folder.mkdir(parents=True, exist_ok=True)
        for name in ('cutover-v2.sh', 'cutover-inputs.py'):
            shutil.copyfile(ROOT / 'deployment' / name, self.source / 'deployment' / name)
        (self.source / 'packages/evershop/package.json').write_text('{"version":"2.2.1"}')
        config={'system':{'jobs':[],'notification_emails':{name:{'enabled':False} for name in
                ('order_confirmation','customer_welcome','shipment_created','shipment_delivered')}}}
        (self.source / 'deployment/config.shusha.json').write_text(json.dumps(config))
        for name in ('default.json','production.json'):
            (self.release / 'config-candidate' / name).write_text(json.dumps(config))
            (self.root / 'old/config' / name).write_text('{}')
        env={'DB_HOST':'pg','DB_PORT':'5432','DB_NAME':'shusha_v2_candidate','DB_USER':'application',
             'DB_PASSWORD':'synthetic-password',**{name:'synthetic-secret' for name in
             ('JWT_ADMIN_SECRET','JWT_ADMIN_REFRESH_SECRET','JWT_CUSTOMER_SECRET','JWT_CUSTOMER_REFRESH_SECRET')}}
        (self.release / 'candidate.env').write_text(''.join(f'{k}={v}\n' for k,v in env.items()))
        (self.release / 'private-candidate/supplier.env').write_text('SUUSHA_PRICE_API_KEY=synthetic-token\n')
        for filename in (self.release / 'private-candidate/receiving.json', self.root / 'old/wise/receiving.json'):
            filename.write_text('{"configured":false}')
        accepted={**helper.inputs(self.release,IMAGE),**{flag:True for flag in helper.FLAGS}}
        (self.release / 'private-candidate/acceptance.json').write_text(json.dumps(accepted))
        # Production's old store is postgres, also used by the observer psql.
        oldenv={**env,'DB_NAME':'postgres'}
        old={'Id':'original-old-id','Image':'old-image','State':{'Running':True},'Config':{'Env':[f'{k}={v}' for k,v in oldenv.items()]},
             'HostConfig':{'PortBindings':{'3000/tcp':[{'HostPort':'5433','HostIp':'127.0.0.1'}]}},
             'NetworkSettings':{'Networks':{'MyEverShop':{}}},'Mounts':[{'Type':'bind','Destination':destination,'Source':str(self.root/source)}
                for destination,source in (('/app/data/material-library','old/library'),('/app/media','old/media'),
                ('/wise-private','old/wise'),('/app/config','old/config'))]}
        state={'image':IMAGE,'databaseCreated':False,'calls':[],'clientConnections':[],'connectionCounts':[],
               'containers':{'evershop':old,'pg':{'Id':'synthetic-pg-id','Image':'synthetic-pg-image','State':{'Running':True}}}}
        (self.root / 'docker-state.json').write_text(json.dumps(state))
        (self.bin / 'docker').write_text(DOCKER)
        # One immediate health attempt keeps a negative rehearsal bounded.
        (self.bin / 'seq').write_text('#!/bin/sh\nprintf "1\\n"\n')
        (self.bin / 'sleep').write_text('#!/bin/sh\nexit 0\n')
        for filename in self.bin.iterdir(): filename.chmod(0o700)

    def tearDown(self):
        self.temporary.cleanup()

    def run_cutover(self, scenario):
        result = subprocess.run(['bash',str(self.source / 'deployment/cutover-v2.sh'),str(self.release),str(self.backup),IMAGE],
            env={**os.environ,'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],'MOCK_ROOT':str(self.root),
                 'MOCK_SCENARIO':scenario,'SHUSHA_BASE_DIR':str(self.root)},capture_output=True,text=True,timeout=20)
        self.assertNotIn('synthetic-password', result.stdout)
        self.assertNotIn('synthetic-token', result.stdout)
        state=json.loads((self.root/'docker-state.json').read_text())
        report=json.loads(result.stdout.splitlines()[-1])
        return result,state,report

    def test_success_preserves_original_database_container_and_uses_one_public_writer(self):
        result,state,report=self.run_cutover('success')
        self.assertEqual(result.returncode,0)
        self.assertEqual(report['status'],'cutover-complete')
        self.assertEqual(state['connectionCounts'],[0])
        self.assertTrue(state['containers']['evershop']['State']['Running'])
        self.assertFalse(state['containers']['evershop-v1-rollback']['State']['Running'])
        self.assertFalse(state['containers']['evershop-v2-maintenance']['State']['Running'])
        self.assertEqual(state['containers']['evershop-v1-rollback']['Id'],'original-old-id')
        self.assertFalse(any('dropdb' in call or 'rm' in call for call in state['calls']))

    def assert_stopped_writer_resumed_before_backup(self, result, state, report):
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(report['status'],'failed-old-resumed')
        self.assertEqual(report['stage'],'stop-old-writers')
        self.assertTrue(report['oldResumed'])
        self.assertEqual(state['containers']['evershop']['Id'],'original-old-id')
        self.assertTrue(state['containers']['evershop']['State']['Running'])
        self.assertFalse(state['databaseCreated'])
        self.assertFalse(any('pg_dump' in call or 'createdb' in call or 'pg_restore' in call for call in state['calls']))
        self.assertFalse(any(any('migrate-v2.mjs' in argument for argument in call) for call in state['calls']))

    def test_observer_blocks_itself_when_pid_exclusion_is_missing(self):
        script=self.source/'deployment/cutover-v2.sh'
        text=script.read_text()
        exclusion=' AND pid <> pg_backend_pid()'
        self.assertEqual(text.count(exclusion),1)
        # Negative control changes only the isolated rehearsal copy.
        script.write_text(text.replace(exclusion,''))
        accepted={**helper.inputs(self.release,IMAGE),**{flag:True for flag in helper.FLAGS}}
        (self.release/'private-candidate/acceptance.json').write_text(json.dumps(accepted))
        result,state,report=self.run_cutover('success')
        self.assertEqual(state['connectionCounts'],[1])
        self.assert_stopped_writer_resumed_before_backup(result,state,report)

    def test_other_idle_client_still_blocks_when_observer_is_excluded(self):
        statefile=self.root/'docker-state.json'
        state=json.loads(statefile.read_text())
        state['clientConnections']=[{'datname':'postgres','backend_type':'client backend','pid':102,'state':'idle'}]
        statefile.write_text(json.dumps(state))
        result,state,report=self.run_cutover('success')
        self.assertEqual(state['connectionCounts'],[1])
        self.assert_stopped_writer_resumed_before_backup(result,state,report)

    def test_migration_failure_resumes_original_writer_and_preserves_failed_copy(self):
        result,state,report=self.run_cutover('migration-failed')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(report['status'],'failed-old-resumed')
        self.assertEqual(state['containers']['evershop']['Id'],'original-old-id')
        self.assertTrue(state['containers']['evershop']['State']['Running'])
        self.assertTrue(state['databaseCreated'])

    def test_failed_absence_query_cannot_stop_the_existing_writer(self):
        result,state,report=self.run_cutover('preflight-query-failed')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(report['status'],'preflight-rejected')
        self.assertFalse(state['databaseCreated'])
        self.assertTrue(state['containers']['evershop']['State']['Running'])
        self.assertFalse(any(call[0]=='stop' for call in state['calls']))

    def test_post_public_health_failure_rolls_back_only_after_v2_backup_and_strict_guard(self):
        result,state,report=self.run_cutover('health-unchanged')
        self.assertNotEqual(result.returncode,0)
        self.assertTrue(report['rollbackGuardPassed'])
        self.assertTrue(report['oldResumed'])
        dumps=[call for call in state['calls'] if 'pg_dump' in call]
        self.assertEqual(len(dumps),2)
        self.assertIn('shusha_v2_production',dumps[-1])
        self.assertEqual(state['containers']['evershop']['Id'],'original-old-id')
        self.assertTrue(state['containers']['evershop']['State']['Running'])

    def test_post_public_new_order_blocks_old_database_rollback(self):
        result,state,report=self.run_cutover('health-new-order')
        self.assertEqual(result.returncode,3)
        self.assertEqual(report['status'],'failed-new-business-data-protected')
        self.assertFalse(report['rollbackGuardPassed'])
        self.assertFalse(report['oldResumed'])
        self.assertFalse(state['containers']['evershop']['State']['Running'])
        self.assertFalse(state['containers']['evershop-v1-rollback']['State']['Running'])
        self.assertTrue(any('pg_dump' in call and 'shusha_v2_production' in call for call in state['calls']))


if __name__ == '__main__':
    unittest.main()
