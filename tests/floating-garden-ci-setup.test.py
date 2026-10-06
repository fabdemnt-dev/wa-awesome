"""Run: python3 -I tests/floating-garden-ci-setup.test.py
All cloud calls use a fake in-memory gcloud runner; subprocess is forbidden.
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garden_setup', ROOT / 'scripts/setup-floating-garden-ci-owner.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BUILD = f'{m.NUMBER}-compute@developer.gserviceaccount.com'


def account(email):
    return {'email': email, 'projectId': m.PROJECT, 'uniqueId': '123456789012345678901', 'disabled': False}


def binding(role, member, cond=None):
    return {'role': role, 'members': [member], **({'condition': cond} if cond else {})}


class Fake:
    def __init__(self):
        self.release_sha = 'a' * 40
        self.release_run_number = '2'
        self.approved = False
        self.calls = []
        self.fail_stage = None
        self.mutate = None
        self.pool = None
        self.provider = None
        self.custom = {}
        self.accounts = {a: account(a) for a in (m.RUNTIME, BUILD)}
        self.policies = {t: {'version': 3, 'bindings': []} for t in ('project', 'secret', 'pool', m.RUNTIME, BUILD, m.DEPLOYER)}
        self.policies['project']['bindings'] = [binding('roles/editor', 'serviceAccount:' + BUILD),
                                               binding('roles/viewer', 'user:unrelated@example.invalid')]
        self.services = list(m.APIS[:2])
        self.functions = [{'name': f'projects/{m.PROJECT}/locations/{m.REGION}/functions/{name}',
            'environment': 'GEN_2', 'state': 'ACTIVE', 'serviceConfig': {'serviceAccountEmail': m.RUNTIME},
            'buildConfig': {'serviceAccount': f'projects/{m.PROJECT}/serviceAccounts/{BUILD}',
                'source': {'storageSource': {'bucket': m.BUCKET, 'object': name + '.zip'}}}} for name in m.FUNCTIONS]
        self.support = [{'name': p, 'customRolesSupportLevel': 'SUPPORTED'} for ps in m.CUSTOM.values() for p in ps]
        self.keys = []
        self.hmac_version = '1'
        self.extra_provider = False
        self.ancestors = [{'type': 'project', 'id': m.NUMBER}]
        self.ancestor_policy = {'bindings': []}

    def target(self, args):
        if args[0] == 'projects': return 'project'
        if args[0] == 'secrets': return 'secret'
        if args[1] == 'workload-identity-pools': return 'pool'
        return args[3]

    def __call__(self, args, stage, write=False):
        self.calls.append((copy.deepcopy(args), stage, write))
        if self.mutate: self.mutate(self, args, stage, write)
        if stage == self.fail_stage: raise m.Stop(stage, 'PERMISSION_DENIED')
        if write:
            assert self.approved, 'write before owner confirmation'
            if stage == 'enable_api': self.services.append(args[2])
            elif stage == 'create_disabled_pool':
                self.pool = {'name': m.POOL_NAME, 'state': 'ACTIVE', 'disabled': True}
            elif stage == 'create_disabled_provider':
                self.provider = {'name': m.PROVIDER_NAME, 'state': 'ACTIVE', 'disabled': True,
                    'attributeMapping': copy.deepcopy(m.MAPPING), 'attributeCondition': m.release_condition('a' * 40, '2'),
                    'oidc': {'issuerUri': 'https://token.actions.githubusercontent.com'}}
            elif stage == 'create_deployer': self.accounts[m.DEPLOYER] = account(m.DEPLOYER)
            elif stage == 'create_custom_role':
                name = args[3]
                self.custom[name] = {'name': m.role_name(name), 'stage': 'GA', 'includedPermissions': list(m.CUSTOM[name])}
            elif stage == 'add_conditional_binding':
                role = next(a.split('=', 1)[1] for a in args if a.startswith('--role='))
                member = next(a.split('=', 1)[1] for a in args if a.startswith('--member='))
                condition = next(a.split('=', 1)[1] for a in args if a.startswith('--condition='))
                cond = dict(part.split('=', 1) for part in condition[len('^~^'):].split('~'))
                target = self.target(args)
                self.policies[target]['bindings'].append(binding(role, member, cond))
            elif stage == 'enable_provider_last': self.provider['disabled'] = False
            elif stage == 'enable_pool_last': self.pool['disabled'] = False
            else: raise AssertionError('Unexpected write ' + stage)
            return {}
        if stage == 'enable_pool_last_propagation': result = self.pool
        elif stage == 'enable_provider_last_propagation': result = self.provider
        elif stage == 'create_deployer_propagation': result = self.accounts[m.DEPLOYER]
        elif stage == 'create_disabled_pool_propagation': result = self.pool
        elif stage == 'create_disabled_provider_propagation': result = self.provider
        elif stage == 'create_custom_role_propagation': result = self.custom[args[3]]
        elif stage == 'gcloud_config': result = {'core': {'account': 'owner@example.invalid'}}
        elif stage == 'owner_identity': result = [{'account': 'owner@example.invalid', 'status': 'ACTIVE'}]
        elif stage == 'project_identity': result = {'projectId': m.PROJECT, 'projectNumber': m.NUMBER, 'lifecycleState': 'ACTIVE'}
        elif stage == 'enabled_apis': result = [{'config': {'name': s}, 'state': 'ENABLED'} for s in self.services]
        elif stage == 'function_metadata': result = self.functions
        elif stage == 'source_bucket_policy': result = {'bindings': []}
        elif stage == 'function_policy': result = {'bindings': []}
        elif stage == 'source_bucket_owner': result = {'name': m.BUCKET, 'project_number': m.NUMBER}
        elif stage.startswith('hmac_'): result = {'name': f'projects/{m.NUMBER}/secrets/{m.SECRET}/versions/{self.hmac_version}', 'state': 'ENABLED'}
        elif stage in ('project_policy', 'secret_policy', 'account_policy', 'pool_policy', 'binding_before', 'binding_after'):
            result = self.policies[self.target(args)]
        elif stage == 'project_ancestors': result = self.ancestors
        elif stage == 'ancestor_policy': result = self.ancestor_policy
        elif stage == 'account_inventory': result = list(self.accounts.values())
        elif stage == 'account_metadata': result = self.accounts[args[3]]
        elif stage == 'deployer_keys': result = self.keys
        elif stage == 'custom_role_inventory': result = list(self.custom.values())
        elif stage == 'custom_permission_support': result = self.support
        elif stage == 'role_metadata':
            name = args[3]
            result = self.custom[name] if name in self.custom else {'name': name, 'stage': 'GA',
                'includedPermissions': ['resourcemanager.projects.setIamPolicy'] if name == 'roles/editor' else ['example.resources.get']}
        elif stage == 'pool_inventory': result = [self.pool] if self.pool else []
        elif stage == 'provider_inventory':
            result = ([self.provider] if self.provider else []) + ([{'name': m.POOL_NAME + '/providers/other'}] if self.extra_provider else [])
        elif stage == 'provider_metadata': result = self.provider
        else: raise AssertionError('Unexpected read ' + stage + ' ' + repr(args))
        return copy.deepcopy(result)

    @property
    def writes(self): return [(a, s) for a, s, w in self.calls if w]


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.no_process = patch.object(m.subprocess, 'run', side_effect=AssertionError('Real subprocess forbidden in tests'))
        self.no_process.start()
        self.addCleanup(self.no_process.stop)
        self.fake = Fake()
        self.state = m.State(Path(self.temp.name) / 'private')
        self.output = []

    def run_setup(self, confirm=None, now=None, sleep=None):
        return m.execute(self.fake, self.state,
            confirm=confirm or (lambda prompt: prompt.removeprefix('Type exactly ').removesuffix(': ')),
            emit=self.output.append, now=now or (lambda: m.EXPIRY - 86400000), sleep=sleep or (lambda _: None))

    def test_default_and_explicit_plan_are_offline(self):
        for args in ([], ['--plan']):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(m.main(args), 0)
            data = json.loads(out.getvalue())
            self.assertEqual(data['cloud_calls'], 0)
            self.assertEqual(data['original_expiry'], m.EXPIRY)
            self.assertIn('environment', data['attribute_condition'])

    def test_cli_rejects_bypass_and_missing_scope(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): m.main(['--setup', '--yes'])
        with contextlib.redirect_stdout(io.StringIO()): self.assertEqual(m.main(['--setup']), 2)

    def test_happy_path_is_disabled_first_enabled_last_preserves_iam(self):
        original = m.policy_atoms(self.fake.policies['project'])
        self.assertEqual(self.run_setup(), 0, self.output[-1])
        stages = [s for _, s in self.fake.writes]
        self.assertEqual(stages[-2:], ['enable_provider_last', 'enable_pool_last'])
        self.assertIn('--disabled', self.fake.writes[2][0])
        self.assertTrue(original <= m.policy_atoms(self.fake.policies['project']))
        self.assertFalse(self.fake.pool['disabled'])
        self.assertFalse(self.fake.provider['disabled'])
        self.assertTrue(self.state.data['setup_verified'])
        self.assertFalse(self.state.data['release_ready'])
        for args, stage in self.fake.writes:
            if stage == 'add_conditional_binding':
                c = next(a for a in args if a.startswith('--condition='))
                self.assertIn(m.DEADLINE, c)
        serialized = json.dumps(self.state.data)
        self.assertNotIn('owner@example', serialized)
        self.assertNotIn('unrelated@example', serialized)
        self.assertIn('ACTAS ' + BUILD + '; inspected roles: roles/editor', self.output[0])
        self.assertIn('indirect', self.output[0])
        self.assertNotIn('roles/editor', [a for args, _ in self.fake.writes for a in args])

    def test_no_write_before_exact_confirmation(self):
        def reject(prompt):
            self.assertEqual(self.fake.writes, [])
            self.assertRegex(prompt, r'Type exactly APPROVE [a-f0-9]{12}: ')
            return 'yes'
        self.assertEqual(self.run_setup(reject), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'owner_confirmation_declined')

    def test_deadline_never_extends(self):
        self.assertEqual(self.run_setup(now=lambda: m.EXPIRY), 2)
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.state.data['stage'], 'original_deadline_expired')

    def test_metadata_change_after_confirmation_blocks_all_writes(self):
        def confirm(prompt):
            self.fake.services.append('sts.googleapis.com')
            return prompt.removeprefix('Type exactly ').removesuffix(': ')
        self.assertEqual(self.run_setup(confirm), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'plan_changed_confirm_again')

    def test_reject_foreign_missing_build_and_source_before_writes(self):
        for bad in ('', 'projects/another-project/serviceAccounts/x@another-project.iam.gserviceaccount.com'):
            with self.subTest(bad=bad):
                self.fake = Fake()
                self.fake.functions[0]['buildConfig']['serviceAccount'] = bad
                self.assertEqual(self.run_setup(), 2)
                self.assertEqual(self.fake.writes, [])
        self.fake = Fake()
        self.fake.functions[0]['buildConfig']['source']['storageSource']['bucket'] = 'other'
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.state.data['stage'], 'source_bucket_mismatch')
        self.assertEqual(self.fake.writes, [])

    def test_appspot_absent_never_granted_and_broad_role_blocks(self):
        s = m.collect(self.fake)
        self.assertNotIn(m.APPSPOT, s['act_as'])
        self.fake.accounts[m.APPSPOT] = account(m.APPSPOT)
        self.fake.policies[m.APPSPOT] = {'bindings': []}
        self.fake.policies['project']['bindings'].append(binding('roles/editor', 'serviceAccount:' + m.APPSPOT))
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'broad_act_as_account')

    def test_permission_support_missing_unsupported_and_api_disabled_block(self):
        for change in ('missing', 'NOT_SUPPORTED', 'TESTING', 'disabled'):
            with self.subTest(change=change):
                self.fake = Fake()
                if change == 'missing': self.fake.support.pop()
                elif change == 'disabled': self.fake.support[0]['apiDisabled'] = True
                else: self.fake.support[0]['customRolesSupportLevel'] = change
                self.assertEqual(self.run_setup(), 2)
                self.assertEqual(self.fake.writes, [])
                self.assertTrue(self.state.data['stage'].startswith('unsupported_or_unknown_custom_permission:'))
        self.fake = Fake()
        del self.fake.support[0]['customRolesSupportLevel']
        self.assertTrue(m.make_plan(m.collect(self.fake)))  # documented protobuf enum default

    def test_hmac_latest_must_be_original_enabled_version_one(self):
        self.fake.hmac_version = '2'
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])

    def test_custom_role_deleted_or_extra_permission_blocks(self):
        for bad in ('deleted', 'broader'):
            self.fake = Fake()
            self.fake.custom['gardenCiSourceRead'] = {'name': m.role_name('gardenCiSourceRead'), 'stage': 'GA',
                'includedPermissions': [*m.CUSTOM['gardenCiSourceRead'], 'storage.objects.create'] if bad == 'broader' else list(m.CUSTOM['gardenCiSourceRead']),
                'deleted': bad == 'deleted'}
            self.assertEqual(self.run_setup(), 2)
            self.assertEqual(self.fake.writes, [])

    def test_no_fork_default_audience_exact_environment_and_workflow(self):
        self.assertEqual(m.MAPPING['attribute.environment'], 'assertion.environment')
        for value in ('1321198654', '312340196', m.REF, m.WORKFLOW, 'push', 'garden-trial'):
            self.assertIn(value, m.release_condition('a' * 40, '2'))
        plan = m.make_plan(m.collect(self.fake))
        provider = next(a for a in plan['actions'] if a['stage'] == 'create_disabled_provider')
        self.assertFalse(any(a.startswith('--allowed-audiences') for a in provider['args']))
        self.assertIn("assertion.workflow_sha == '" + self.fake.release_sha + "'", ' '.join(provider['args']))

    def seed_existing(self):
        self.assertEqual(self.run_setup(), 0)
        self.fake.calls.clear()
        self.output.clear()

    def test_exact_existing_setup_is_noop(self):
        self.seed_existing()
        self.assertEqual(self.run_setup(), 0)
        self.assertEqual(self.fake.writes, [])

    def test_other_provider_or_bad_condition_or_keys_blocks_before_writes(self):
        self.seed_existing()
        self.fake.extra_provider = True
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])
        self.fake.extra_provider = False
        self.fake.provider['attributeCondition'] = 'true'
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])
        self.fake.provider['attributeCondition'] = m.release_condition('a' * 40, '2')
        self.fake.keys = [{'name': 'existing-user-key'}]
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])

    def test_broader_existing_bindings_and_live_partial_setup_block(self):
        self.seed_existing()
        self.fake.policies['project']['bindings'].append(binding('roles/owner', m.MEMBER))
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.state.data['stage'], 'broader_existing_target_binding')
        self.assertEqual(self.fake.writes, [])
        self.fake.policies['project']['bindings'].pop()
        self.fake.policies['secret']['bindings'].clear()
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.state.data['stage'], 'existing_federation_live_with_remaining_changes')
        self.assertEqual(self.fake.writes, [])

    def test_partial_failure_records_safe_stage_and_keeps_federation_disabled(self):
        self.fake.fail_stage = 'create_deployer'
        self.assertEqual(self.run_setup(), 2)
        self.assertTrue(self.fake.pool['disabled'])
        self.assertTrue(self.fake.provider['disabled'])
        self.assertEqual(self.state.data['provider_code'], 'PERMISSION_DENIED')
        self.assertEqual(self.state.data['possibly_applied']['stage'], 'create_deployer')
        self.assertEqual([s for _, s in self.fake.writes].count('create_deployer'), 1)
        self.assertNotIn('enable_pool_last', [s for _, s in self.fake.writes])
        self.assertEqual(set(self.state.data['created_targets']), {m.POOL_NAME, m.PROVIDER_NAME})

    def test_resume_fresh_read_confirmation_and_remaining_diff_same_folder(self):
        self.fake.fail_stage = 'create_deployer'
        self.assertEqual(self.run_setup(), 2)
        first_created = self.state.data['created_targets'][:]
        self.state = m.State(self.state.path.parent, resume=True)
        self.assertEqual(self.state.data['created_targets'], first_created)
        self.fake.fail_stage = None
        self.fake.calls.clear()
        self.assertEqual(self.run_setup(), 0)
        self.assertNotIn('create_disabled_pool', [s for _, s in self.fake.writes])
        self.assertNotIn('create_disabled_provider', [s for _, s in self.fake.writes])
        self.assertEqual(len(list(Path(self.temp.name).iterdir())), 1)

    def test_unrelated_policy_loss_stops_before_enable(self):
        def change(fake, args, stage, write):
            if stage == 'binding_after' and args[0] == 'projects':
                fake.policies['project']['bindings'] = [b for b in fake.policies['project']['bindings'] if b['members'] != ['user:unrelated@example.invalid']]
        self.fake.mutate = change
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.state.data['stage'], 'binding_verification')
        self.assertNotIn('enable_pool_last', [s for _, s in self.fake.writes])

    def test_inherited_target_access_blocks(self):
        self.fake.ancestors.append({'type': 'organization', 'id': '123'})
        self.fake.ancestor_policy = {'bindings': [binding('roles/owner', m.MEMBER)]}
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])

    def test_conditional_scope_exact_not_prefix_database_or_wrong_bucket(self):
        bindings = m.expected_bindings([m.RUNTIME, BUILD])
        source = next(c for _, r, _, c in bindings if r == m.role_name('gardenCiSourceRead'))['expression']
        gate = next(c for _, r, _, c in bindings if r == m.role_name('gardenCiGateUpdate'))['expression']
        self.assertEqual(source, m.SOURCE_CONDITION)
        self.assertEqual(gate, m.GATE_CONDITION)
        self.assertNotIn('startsWith', gate)
        self.assertNotIn('datastore.entities.create', m.CUSTOM['gardenCiGateUpdate'])
        self.assertNotIn('datastore.entities.delete', m.CUSTOM['gardenCiGateUpdate'])

    def test_read_errors_and_expired_prompt_do_not_write(self):
        self.fake.fail_stage = 'project_policy'
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])
        self.fake = Fake()
        ticks = iter([m.EXPIRY - 1000000, m.EXPIRY - 1000000, m.EXPIRY - 600000, m.EXPIRY - 600000])
        self.assertEqual(self.run_setup(now=lambda: next(ticks)), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'owner_confirmation_expired')



    def test_new_account_waits_60_seconds_then_only_reads_until_visible(self):
        sleeps = []
        counts = {'n': 0}
        def delay(fake, args, stage, write):
            if stage == 'create_deployer_propagation':
                counts['n'] += 1
                if counts['n'] < 3: raise m.Stop(stage, 'NOT_FOUND')
        self.fake.mutate = delay
        self.assertEqual(self.run_setup(sleep=sleeps.append), 0)
        self.assertEqual(sleeps[:3], [60, 10, 10])
        self.assertEqual([s for _, s in self.fake.writes].count('create_deployer'), 1)
        self.assertEqual(counts['n'], 3)

    def test_propagation_exhaustion_is_bounded_and_federation_stays_unenabled(self):
        def invisible(fake, args, stage, write):
            if stage == 'create_deployer_propagation': raise m.Stop(stage, 'NOT_FOUND')
        self.fake.mutate = invisible
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(sum(s == 'create_deployer_propagation' for _, s, _ in self.fake.calls), 7)
        self.assertEqual([s for _, s in self.fake.writes].count('create_deployer'), 1)
        self.assertFalse(self.state.data['federation_may_be_active'])

    def test_enable_failure_records_possibly_active_without_rollback_or_retry(self):
        self.fake.fail_stage = 'enable_pool_last'
        self.assertEqual(self.run_setup(), 2)
        self.assertTrue(self.state.data['federation_may_be_active'])
        self.assertEqual([s for _, s in self.fake.writes].count('enable_pool_last'), 1)
        self.assertNotIn('delete', [a for args, _ in self.fake.writes for a in args])

    def test_numeric_function_aliases_and_duplicate_alias_rejection(self):
        for f in self.fake.functions: f['name'] = f['name'].replace(m.PROJECT, m.NUMBER)
        self.assertEqual(self.run_setup(), 0)
        self.fake = Fake()
        self.fake.functions[-1]['name'] = self.fake.functions[0]['name'].replace(m.PROJECT, m.NUMBER)
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])

    def test_owner_review_does_not_dump_predefined_permissions_or_full_policy(self):
        plan = m.make_plan(m.collect(self.fake))
        review = m.render_plan(plan, m.digest(plan))
        self.assertLess(len(review.splitlines()), 70)
        self.assertNotIn('example.resources.get', review)
        self.assertNotIn('unrelated@example.invalid', review)
        self.assertIn('roles/serviceusage.apiKeysViewer', review)
        self.assertIn('datastore.entities.update', review)

    def test_command_surface_is_setup_only_no_payload_or_deployment(self):
        self.assertEqual(self.run_setup(), 0)
        for args, stage, write in self.fake.calls:
            self.assertNotIn('access', args)
            self.assertNotIn('set-iam-policy', args)
            self.assertNotIn('login', args)
            self.assertNotIn('install', args)
            self.assertNotIn('deploy', args)
            self.assertNotIn('delete', args)
            self.assertNotIn('undelete', args)
            self.assertNotIn('cloudbilling.googleapis.com', args)
            self.assertNotIn('--role=roles/iam.serviceAccountTokenCreator', args)
            if write and args[:2] == ['services', 'enable']:
                self.assertIn(args[2], m.APIS)
            if write and args[0] == 'projects':
                self.assertNotIn('--role=roles/iam.serviceAccountUser', args)
        provider = self.fake.provider
        self.assertIn("assertion.environment == 'garden-trial'", provider['attributeCondition'])

    def test_deleted_pool_and_preexisting_pool_policy_block(self):
        self.fake.pool = {'name': m.POOL_NAME, 'state': 'DELETED', 'disabled': True}
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])
        self.fake.pool['state'] = 'ACTIVE'
        self.fake.policies['pool']['bindings'].append(binding('roles/iam.workloadIdentityPoolAdmin', 'user:unexpected@example.invalid'))
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])

    def test_safe_existing_appspot_gets_only_scoped_actas(self):
        self.fake.accounts[m.APPSPOT] = account(m.APPSPOT)
        self.fake.policies[m.APPSPOT] = {'bindings': []}
        self.fake.policies['project']['bindings'].append(binding('roles/logging.logWriter', 'serviceAccount:' + m.APPSPOT))
        self.assertEqual(self.run_setup(), 0)
        grants = self.fake.policies[m.APPSPOT]['bindings']
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0]['role'], 'roles/iam.serviceAccountUser')
        self.assertEqual(grants[0]['condition'], m.condition())

    def test_deleted_deployer_policy_reference_blocks_recreation(self):
        self.fake.policies['project']['bindings'].append(binding('roles/viewer', 'deleted:serviceAccount:' + m.DEPLOYER + '?uid=12345'))
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.state.data['stage'], 'deleted_target_account')
        self.assertEqual(self.fake.writes, [])

    def test_gcloud_reads_reject_all_yes_no_prompts_without_eof_defaults(self):
        seen = []
        def read(command, **kwargs):
            self.assertNotIn('--no-quiet', command)
            self.assertNotIn('--quiet', command)
            self.assertEqual(kwargs['env']['CLOUDSDK_CORE_DISABLE_PROMPTS'], 'false')
            self.assertNotEqual(kwargs['stdin'], subprocess.DEVNULL)
            # The real pipe supplies more than one decline and never borrows
            # the owner stdin used by the final exact approval prompt.
            with os.fdopen(os.dup(kwargs['stdin'])) as input_stream:
                self.assertEqual([input_stream.readline() for _ in range(8)], ['n\n'] * 8)
            seen.append(command)
            return subprocess.CompletedProcess(command, 0, b'{}', b'')
        with patch.object(m.subprocess, 'run', side_effect=read):
            self.assertEqual(m.Gcloud()(['config', 'list'], 'gcloud_config'), {})
        self.assertEqual(len(seen), 1)

    def test_read_prompt_producer_failure_cannot_become_default_accepting_eof(self):
        import select
        # Even a failed producer must leave the writer open while the command
        # runs. The reader blocks rather than observing EOF/default-YES.
        with patch.object(m.os, 'write', side_effect=OSError('synthetic producer fault')):
            with m.reject_sdk_prompts() as fd:
                self.assertEqual(select.select([fd], [], [], 0.01)[0], [])

    def test_gcloud_write_requires_own_approval_then_dispatches_once(self):
        runner = m.Gcloud()
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'{}', b'')) as dispatch:
            with self.assertRaises(m.Stop):
                runner(['services', 'enable', 'iam.googleapis.com'], 'enable_apis', write=True)
            dispatch.assert_not_called()
            runner.approved = True
            self.assertEqual(runner(['services', 'enable', 'iam.googleapis.com'], 'enable_apis', write=True), {})
            dispatch.assert_called_once()
            command = dispatch.call_args.args[0]
            self.assertEqual(command.count('--quiet'), 1)
            self.assertNotIn('--no-quiet', command)
            self.assertEqual(dispatch.call_args.kwargs['stdin'], subprocess.DEVNULL)

    def test_gcloud_timeout_cleans_up_read_prompt_pipe_and_thread(self):
        import threading
        before_threads = set(threading.enumerate())
        descriptors = Path('/proc/self/fd')
        before_fds = len(list(descriptors.iterdir())) if descriptors.exists() else None
        with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 60)):
            for _ in range(20):
                with self.assertRaises(m.Stop) as caught:
                    m.Gcloud()(['config', 'list'], 'gcloud_config')
                self.assertEqual(caught.exception.local_code, 'CLI_TIMEOUT')
        self.assertEqual(set(threading.enumerate()), before_threads)
        if before_fds is not None:
            self.assertEqual(len(list(descriptors.iterdir())), before_fds)

    def test_gcloud_local_failures_are_sanitized_and_specific(self):
        cases = [
            (subprocess.CompletedProcess([], 2, b'', b'unrecognized arguments: --no-quiet SYNTHETIC_PRIVATE'), 'CLI_ARGUMENT', 2),
            (subprocess.CompletedProcess([], 1, b'', b'SYNTHETIC_PRIVATE'), 'CLI_EXIT_NONZERO', 1),
            (subprocess.CompletedProcess([], 0, b'SYNTHETIC_PRIVATE', b''), 'NON_JSON_RESPONSE', 0),
            (FileNotFoundError('SYNTHETIC_PRIVATE'), 'CLI_MISSING', None),
            (subprocess.TimeoutExpired('SYNTHETIC_PRIVATE', 60), 'CLI_TIMEOUT', None),
        ]
        for failure, code, exit_code in cases:
            with self.subTest(code=code), patch.object(m.subprocess, 'run',
                **({'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure})):
                with self.assertRaises(m.Stop) as caught:
                    m.Gcloud()(['config', 'list'], 'gcloud_config')
                self.assertEqual(caught.exception.local_code, code)
                self.assertEqual(caught.exception.exit_code, exit_code)
                self.assertNotIn('SYNTHETIC_PRIVATE', str(caught.exception))

    def test_resume_archives_original_failure_bytes_and_rejects_history_overwrite(self):
        self.state.data.update(stage='gcloud_config', provider_code='UNKNOWN')
        self.state.save()
        # A record with CRLF must be retained without newline translation.
        previous = self.state.path.read_bytes().replace(b'\n', b'\r\n')
        self.state.path.write_bytes(previous)
        resumed = m.State(self.state.path.parent, resume=True)
        history = self.state.path.parent / 'attempt-1-state.json'
        self.assertEqual(history.read_bytes(), previous)
        self.assertEqual(os.stat(history).st_mode & 0o777, 0o600)
        self.assertEqual(resumed.data['attempt'], 2)
        self.state.path.write_bytes(previous)
        # Semantically identical JSON with different bytes must also block.
        history.write_bytes(previous.replace(b'\r\n', b'\n'))
        with self.assertRaises(m.Stop): m.State(self.state.path.parent, resume=True)
        self.assertEqual(self.state.path.read_bytes(), previous)
        self.assertEqual(history.read_bytes(), previous.replace(b'\r\n', b'\n'))

    def test_state_hardlink_is_rejected_before_truncation(self):
        other = self.state.path.parent / 'other.json'
        os.link(self.state.path, other)
        before = other.read_bytes()
        with self.assertRaises(m.Stop): self.state.save()
        self.assertEqual(other.read_bytes(), before)

    def test_function_policy_reads_use_documented_flags_after_v2_identity_check(self):
        m.collect(self.fake)
        inventory = [args for args, stage, _ in self.fake.calls if stage == 'function_metadata']
        self.assertEqual(len(inventory), 1)
        self.assertIn('--v2', inventory[0])
        policies = [args for args, stage, _ in self.fake.calls if stage == 'function_policy']
        self.assertEqual(policies, [['functions', 'get-iam-policy', name, '--region=' + m.REGION] for name in m.FUNCTIONS])
        self.assertFalse(any('--gen2' in args for args in policies))

    def test_exact_source_and_first_run_trust_is_mandatory(self):
        for bad in (None, '', 'MAIN', 'a' * 39, 'g' * 40):
            with self.assertRaises(m.Stop): m.release_condition(bad, '2')
        condition = m.release_condition('a' * 40, '2')
        self.assertIn("assertion.workflow_sha == '" + 'a' * 40 + "'", condition)
        self.assertIn("assertion.run_number == '2'", condition)
        self.assertIn("assertion.run_attempt == '1'", condition)
        for bad in (None, '', '0', '-1', '1 OR true', 2):
            with self.assertRaises(m.Stop): m.release_condition('a' * 40, bad)
        self.fake.release_sha = None
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])

    def test_state_rejects_existing_directory_symlink_and_is_private(self):
        self.assertEqual(os.stat(self.state.path.parent).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.state.path).st_mode & 0o777, 0o600)
        with self.assertRaises(m.Stop): m.State(self.state.path.parent)
        link = Path(self.temp.name) / 'alias'
        link.symlink_to(self.state.path.parent)
        with self.assertRaises(m.Stop): m.State(link, resume=True)


def verify_sdk_parser_and_prompts(sdk_root):
    """Real SDK argument/concept parsing only; never CLI.Execute/Command.Run.

    Called separately by credential-free CI after the official pinned SDK is
    installed. A private empty configuration, network/process audit hook, and
    SDK dispatch/auth intercepts fail closed before any provider operation.
    """
    import socket
    import runpy
    sdk_root = Path(sdk_root).resolve()
    assert (sdk_root / 'VERSION').read_text().strip() == '568.0.0'
    with tempfile.TemporaryDirectory(prefix='garden-sdk-parser-') as folder:
        folder = Path(folder)
        (folder / 'config').mkdir(mode=0o700)
        os.environ.clear()
        os.environ.update(HOME=str(folder), PATH='/usr/bin:/bin', COLUMNS='80', LINES='24',
            CLOUDSDK_CONFIG=str(folder / 'config'), CLOUDSDK_AUTH_DISABLE_CREDENTIALS='true',
            CLOUDSDK_CORE_CHECK_GCE_METADATA='false', CLOUDSDK_CORE_DISABLE_PROMPTS='false',
            CLOUDSDK_CORE_DISABLE_FILE_LOGGING='true', CLOUDSDK_CORE_LOG_HTTP='false',
            CLOUDSDK_CORE_DISABLE_USAGE_REPORTING='true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true',
            CLOUDSDK_CORE_PROJECT=m.PROJECT, CLOUDSDK_PYTHON_SITEPACKAGES='0')
        blocked = []
        class UnsafeAction(BaseException): pass
        def fail(*args, **kwargs):
            blocked.append('forbidden-sdk-dispatch')
            raise UnsafeAction('forbidden-sdk-dispatch')
        def audit(event, args):
            if (event.startswith('socket.') and event != 'socket.gethostname') or event in (
                'subprocess.Popen', 'os.system', 'os.posix_spawn', 'os.spawn', 'os.exec'):
                blocked.append(event)
                raise UnsafeAction(event)
        sys.addaudithook(audit)
        # Avoid an unrelated urllib3 import-time IPv6 loopback probe.
        socket.has_ipv6 = False
        runpy.run_path(str(sdk_root / 'lib/gcloud.py'), run_name='gcloud_bootstrap')
        # The fixture imported Python's argparse before the SDK bootstrap. A
        # real gcloud subprocess starts with its bundled fork instead; load
        # that exact parser, without modifying either implementation.
        sys.modules.pop('argparse', None)
        import argparse as sdk_argparse
        assert Path(sdk_argparse.__file__).resolve() == sdk_root / 'lib/third_party/argparse/__init__.py'
        from googlecloudsdk import gcloud_main
        from googlecloudsdk.calliope import backend
        from googlecloudsdk.core import properties
        from googlecloudsdk.core.configurations import named_configs
        from googlecloudsdk.core.updater import update_manager
        backend.Command.Run = fail
        update_manager.UpdateManager.EnsureInstalledAndRestart = fail
        update_manager.UpdateManager.Install = fail
        cli = gcloud_main.CreateCLI([])
        from googlecloudsdk.calliope import cli as cli_module
        from googlecloudsdk.api_lib.util import apis, apis_internal
        from apitools.base.py import base_api, http_wrapper
        from googlecloudsdk.core.credentials import store as credential_store, transports
        from googlecloudsdk.command_lib import info_holder
        from googlecloudsdk.core.console import console_io
        import google.auth
        import google.auth._default
        backend.Command.Run = fail
        cli_module.CLI.Execute = fail
        gcloud_main.main = fail
        update_manager.UpdateManager.EnsureInstalledAndRestart = fail
        update_manager.UpdateManager.Install = fail
        original_client = apis_internal._GetClientInstance
        def local_client(api_name, api_version, no_http=False, *args, **kwargs):
            if no_http is not True:
                fail()
            return original_client(api_name, api_version, no_http, *args, **kwargs)
        apis_internal._GetClientInstance = local_client
        apis.GetGapicClientInstance = fail
        base_api.BaseApiService._RunMethod = fail
        base_api.BaseApiClient._SetCredentials = fail
        http_wrapper.MakeRequest = fail
        for name in ('AvailableAccounts', 'GetAccessToken', 'GetAccessTokenIfEnabled',
            'GetFreshAccessToken', 'GetFreshAccessTokenIfEnabled', 'LoadFreshCredential',
            'LoadIfEnabled', 'Load', 'Refresh', 'RefreshIfExpireWithinWindow', 'RefreshIfAlmostExpire'):
            setattr(credential_store, name, fail)
        transports.GetApitoolsTransport = fail
        google.auth.default = fail
        google.auth._default.default = fail
        # Storage imports otherwise run local git/ssh version probes, unrelated
        # to parser behavior. No subprocess is permitted in this test.
        info_holder.ToolsInfo._GetVersion = lambda self, command: 'OFFLINE PARSER TEST'
        fake = Fake()
        fake.ancestors += [{'type': 'folder', 'id': '123'}, {'type': 'organization', 'id': '456'}]
        with patch.object(subprocess, 'run', side_effect=fail):
            assert m.execute(fake, m.State(folder / 'state'),
                confirm=lambda p: p.removeprefix('Type exactly ').removesuffix(': '),
                emit=lambda _: None, now=lambda: m.EXPIRY - 86400000, sleep=lambda _: None) == 0
            m.read_role(fake, 'organizations/456/roles/synthetic')
        captured = {}
        current_write = False
        def capture(command, **kwargs):
            assert command[0] == 'gcloud' and not kwargs.get('shell', False)
            assert kwargs['env']['CLOUDSDK_CORE_DISABLE_PROMPTS'] == 'false'
            if not current_write:
                assert kwargs['stdin'] != subprocess.DEVNULL
            captured[tuple(command[1:])] = current_write
            return subprocess.CompletedProcess(command, 0, b'{}', b'')
        with patch.object(subprocess, 'run', side_effect=capture):
            runner = m.Gcloud()
            runner.approved = True
            for args, stage, write in fake.calls:
                current_write = write
                runner(args, stage, write=write)
        assert len(captured) == 67
        for raw_argv, write in sorted(captured.items()):
            argv = list(raw_argv)
            # No --help and no argument removal: parse exactly what the real
            # helper would submit, including every resource/condition value.
            assert '--help' not in argv and '--no-quiet' not in argv
            named_configs.FLAG_OVERRIDE_STACK.PushFromArgs(argv)
            properties.VALUES.PushInvocationValues()
            try:
                parsed = cli.top_element._parser.parse_args(list(argv))
                if parsed.CONCEPT_ARGS is not None:
                    parsed.CONCEPT_ARGS.ParseConcepts()
                assert properties.VALUES.core.disable_prompts.GetBool() is write
            finally:
                properties.VALUES.PopInvocationValues()
                named_configs.FLAG_OVERRIDE_STACK.Pop()
        # Regression: the exact old first read must be rejected by this same
        # real parser. A help-only probe would incorrectly accept the command.
        old_first = next(list(argv) for argv in captured if argv[:2] == ('config', 'list')) + ['--no-quiet']
        named_configs.FLAG_OVERRIDE_STACK.PushFromArgs(old_first)
        properties.VALUES.PushInvocationValues()
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                try:
                    cli.top_element._parser.parse_args(old_first)
                except SystemExit as error:
                    assert error.code == 2
                else:
                    raise AssertionError('old invalid flag must fail actual argument parsing')
        finally:
            properties.VALUES.PopInvocationValues()
            named_configs.FLAG_OVERRIDE_STACK.Pop()
        # Actual SDK prompt routine: EOF's default-YES behavior is reproduced,
        # and the read-command pipe declines repeatedly for either default.
        with patch.object(sys, 'stdin', io.StringIO('')), contextlib.redirect_stderr(io.StringIO()):
            assert console_io.PromptContinue(default=True) is True
        with m.reject_sdk_prompts() as fd:
            with os.fdopen(os.dup(fd)) as stream, patch.object(sys, 'stdin', stream), contextlib.redirect_stderr(io.StringIO()):
                for default in (True, False, True, False):
                    assert console_io.PromptContinue(default=default, throw_if_unattended=True) is False
        assert not blocked
        print('SDK_PARSE_VERIFIED version=568.0.0 argvVariants=67 oldInvalidFlagRejected=true commandRuns=0 networkRequests=0 credentialAccess=0')
        print('SDK_PROMPT_VERIFIED repeatedNo=true eofDefaultYesReproduced=true ownerApprovalInputUntouched=true')


if __name__ == '__main__':
    unittest.main(verbosity=2)
