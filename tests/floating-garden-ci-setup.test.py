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
        self.config = {'core': {'account': 'owner@example.invalid'}}
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
        self.bucket = {'name': m.BUCKET, 'projectNumber': m.NUMBER}
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
        elif stage == 'gcloud_config': result = self.config
        elif stage == 'owner_identity': result = [{'account': 'owner@example.invalid', 'status': 'ACTIVE'}]
        elif stage == 'project_identity': result = {'projectId': m.PROJECT, 'projectNumber': m.NUMBER, 'lifecycleState': 'ACTIVE'}
        elif stage == 'enabled_apis': result = [{'config': {'name': s}, 'state': 'ENABLED'} for s in self.services]
        elif stage == 'function_metadata': result = self.functions
        elif stage == 'source_bucket_policy': result = {'bindings': []}
        elif stage == 'function_policy': result = {'bindings': []}
        elif stage == 'source_bucket_owner': result = self.bucket
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

    def test_source_bucket_requires_raw_exact_owner_metadata(self):
        for number in (m.NUMBER, int(m.NUMBER)):
            with self.subTest(number_type=type(number).__name__):
                self.fake = Fake()
                self.fake.bucket['projectNumber'] = number
                s = m.collect(self.fake)
                self.assertEqual(s['bucket'], {'name': m.BUCKET, 'projectNumber': m.NUMBER})
                argv = next(args for args, stage, _ in self.fake.calls if stage == 'source_bucket_owner')
                self.assertEqual(argv, ['storage', 'buckets', 'describe', 'gs://' + m.BUCKET,
                    '--raw', '--format=json(name,projectNumber)'])
                self.assertEqual(self.fake.writes, [])

    def test_source_bucket_absent_malformed_or_foreign_owner_blocks_before_confirmation(self):
        cases = [
            ([], 'source_bucket_metadata_shape'),
            ({'projectNumber': m.NUMBER}, 'source_bucket_name_missing'),
            ({'name': 'other', 'projectNumber': m.NUMBER}, 'source_bucket_name_mismatch'),
            ({'name': m.BUCKET}, 'source_bucket_owner_missing'),
            ({'name': m.BUCKET, 'project_number': m.NUMBER}, 'source_bucket_owner_missing'),
            ({'name': m.BUCKET, 'projectNumber': None}, 'source_bucket_owner_missing'),
            ({'name': m.BUCKET, 'projectNumber': '999999999999'}, 'source_bucket_owner_mismatch'),
        ]
        cases += [({'name': m.BUCKET, 'projectNumber': number}, 'source_bucket_owner_shape')
                  for number in (True, False, int(m.NUMBER) * 1.0, '', '0', '0120030709276',
                                 ' ' + m.NUMBER, m.NUMBER + '\n', [], {})]
        for bucket, stage in cases:
            with self.subTest(bucket=bucket):
                self.fake = Fake()
                self.fake.bucket = bucket
                self.assertEqual(self.run_setup(confirm=lambda _: self.fail('must not ask approval')), 2)
                self.assertEqual(self.state.data['stage'], stage)
                self.assertEqual(self.state.data['phase'], 'initial_read')
                self.assertEqual(self.state.data['mutation_attempts_this_attempt'], 0)
                self.assertEqual(self.fake.writes, [])

    def test_source_bucket_owner_drift_after_confirmation_stops_without_write(self):
        def confirm(prompt):
            self.fake.bucket['projectNumber'] = '999999999999'
            return prompt.removeprefix('Type exactly ').removesuffix(': ')
        self.assertEqual(self.run_setup(confirm), 2)
        self.assertEqual(self.state.data['stage'], 'source_bucket_owner_mismatch')
        self.assertEqual(self.state.data['phase'], 'confirmation_read')
        self.assertEqual(self.fake.writes, [])

    def test_storage_hmac_overrides_stop_before_owner_or_bucket_read(self):
        for key in ('gs_xml_access_key_id', 'gs_xml_secret_access_key'):
            with self.subTest(key=key):
                self.fake = Fake()
                self.fake.config['storage'] = {key: 'synthetic-private'}
                self.assertEqual(self.run_setup(confirm=lambda _: self.fail('must not ask approval')), 2)
                self.assertEqual(self.state.data['stage'], 'storage_auth_override')
                self.assertEqual([stage for _, stage, _ in self.fake.calls], ['gcloud_config'])
                self.assertNotIn('synthetic-private', '\n'.join(self.output))
                with patch.dict(os.environ, {'CLOUDSDK_STORAGE_' + key.upper(): 'synthetic-private'}):
                    with self.assertRaises(m.Stop): m.Gcloud()

    def test_storage_json_api_is_pinned_without_changing_ambient_settings(self):
        with patch.dict(os.environ, {'CLOUDSDK_STORAGE_PREFERRED_API': 'grpc_with_json_fallback',
                                     'CLOUDSDK_STORAGE_USE_GRPC_IF_AVAILABLE': 'true',
                                     'CLOUDSDK_FUNCTIONS_GEN2': 'false'}):
            runner = m.Gcloud()
            self.assertEqual(runner.env['CLOUDSDK_STORAGE_PREFERRED_API'], 'json')
            self.assertEqual(runner.env['CLOUDSDK_STORAGE_USE_GRPC_IF_AVAILABLE'], 'false')
            self.assertEqual(runner.env['CLOUDSDK_FUNCTIONS_GEN2'], 'true')
            self.assertEqual(os.environ['CLOUDSDK_STORAGE_PREFERRED_API'], 'grpc_with_json_fallback')
            self.assertEqual(os.environ['CLOUDSDK_STORAGE_USE_GRPC_IF_AVAILABLE'], 'true')
            self.assertEqual(os.environ['CLOUDSDK_FUNCTIONS_GEN2'], 'false')

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

    def test_initial_function_failure_reports_no_mutations_only_for_this_attempt(self):
        self.fake.fail_stage = 'function_metadata'
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['phase'], 'initial_read')
        self.assertEqual(self.state.data['mutation_attempts_this_attempt'], 0)
        self.assertIsNone(self.state.data['federation_may_be_active'])
        self.assertIn('Earlier attempts and existing cloud state are not established', self.output[-1])

    def test_second_read_failure_still_records_no_mutations(self):
        reads = 0
        def stop(fake, args, stage, write):
            nonlocal reads
            if stage == 'function_metadata':
                reads += 1
                if reads == 2: raise m.Stop(stage, local_code='CLI_FORMAT', exit_code=1)
        self.fake.mutate = stop
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['phase'], 'confirmation_read')
        self.assertEqual(self.state.data['mutation_attempts_this_attempt'], 0)
        self.assertTrue(any('CLI_FORMAT_INVALID' in line for line in self.output))

    def test_verification_failure_never_claims_zero_mutations(self):
        def stop(fake, args, stage, write):
            if stage == 'function_metadata' and fake.writes:
                raise m.Stop(stage, local_code='CLI_FORMAT', exit_code=1)
        self.fake.mutate = stop
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.state.data['phase'], 'verification')
        self.assertEqual(self.state.data['mutation_attempts_this_attempt'], len(self.fake.writes))
        self.assertGreater(self.state.data['mutation_attempts_this_attempt'], 0)
        self.assertFalse(any('THIS_ATTEMPT_NO_MUTATIONS' in line for line in self.output))

    def test_binding_preread_failure_does_not_mark_an_unattempted_mutation(self):
        self.fake.fail_stage = 'binding_before'
        self.assertEqual(self.run_setup(), 2)
        self.assertIsNone(self.state.data['possibly_applied'])
        self.assertEqual(self.state.data['mutation_attempts_this_attempt'], len(self.fake.writes))
        self.assertFalse(any(stage == 'add_conditional_binding' for _, stage in self.fake.writes))

    def test_resume_counters_do_not_erase_previous_attempt_uncertainty(self):
        self.fake.fail_stage = 'create_deployer'
        self.assertEqual(self.run_setup(), 2)
        previous = copy.deepcopy(self.state.data)
        self.assertGreater(previous['mutation_attempts_this_attempt'], 0)
        self.assertIsNotNone(previous['possibly_applied'])
        self.state = m.State(self.state.path.parent, resume=True)
        self.fake.calls.clear()
        self.fake.fail_stage = 'function_metadata'
        self.assertEqual(self.run_setup(), 2)
        self.assertEqual(self.state.data['mutation_attempts_this_attempt'], 0)
        self.assertEqual(json.loads((self.state.path.parent / 'attempt-1-state.json').read_text()), previous)
        self.assertEqual(self.state.data['completed_steps'], previous['completed_steps'])



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
            (subprocess.CompletedProcess([], 1, b'', b'ERROR: (gcloud.functions.list) Unknown transform function buildConfig [SYNTHETIC_PRIVATE].'), 'CLI_FORMAT', 1),
            (subprocess.CompletedProcess([], 1, b'', b'ERROR: Format must be one of json; received [SYNTHETIC_PRIVATE].'), 'CLI_FORMAT', 1),
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
        self.assertIn('--format=json(name,environment,state,buildConfig.serviceAccount,buildConfig.source,serviceConfig.serviceAccountEmail)', inventory[0])
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


def verify_sdk_response_schemas():
    """Real typed return schemas/displayer after the SDK safety guards are installed.

    No Command.Run is called; this only renders synthetic return values through
    the exact command display pipeline and checks helper plans and verification.
    """
    from apitools.base.py import encoding
    from googlecloudsdk import gcloud_main
    from googlecloudsdk.api_lib.util import apis
    from googlecloudsdk.calliope import display
    from googlecloudsdk.command_lib.storage.resources import full_resource_formatter, resource_util
    from googlecloudsdk.api_lib.storage.gcs_json import metadata_util
    from googlecloudsdk.core import log, properties
    from googlecloudsdk.core.configurations import named_configs
    from googlecloudsdk.core.resource import resource_printer

    cli = gcloud_main.CreateCLI([])
    modules = {k: apis.GetMessagesModule(*v) for k,v in {
        'iam': ('iam','v1'), 'crm1': ('cloudresourcemanager','v1'),
        'crm2': ('cloudresourcemanager','v2'), 'fn2': ('cloudfunctions','v2'),
        'secret': ('secretmanager','v1'), 'storage': ('storage','v1'),
        'service': ('serviceusage','v1')}.items()}
    seen = {}

    def typed(module, name, value):
        return encoding.JsonToMessage(getattr(modules[module], name), json.dumps(value))

    def stage_type(stage,args):
        if stage == 'project_identity': return 'crm1','Project'
        if stage == 'enabled_apis': return 'service','GoogleApiServiceusageV1Service'
        if stage == 'function_metadata': return 'fn2','Function'
        if stage == 'function_policy': return 'fn2','Policy'
        if stage == 'source_bucket_policy': return 'storage','Policy'
        if stage.startswith('hmac_'): return 'secret','SecretVersion'
        if stage == 'project_policy': return 'crm1','Policy'
        if stage == 'secret_policy': return 'secret','Policy'
        if stage == 'ancestor_policy': return ('crm2' if args[0]=='resource-manager' else 'crm1'),'Policy'
        if stage in ('account_inventory','account_metadata','create_deployer_propagation'): return 'iam','ServiceAccount'
        if stage == 'deployer_keys': return 'iam','ServiceAccountKey'
        if stage in ('custom_role_inventory','role_metadata','create_custom_role_propagation'): return 'iam','Role'
        if stage == 'custom_permission_support': return 'iam','Permission'
        if stage in ('pool_inventory','create_disabled_pool_propagation','enable_pool_last_propagation'): return 'iam','WorkloadIdentityPool'
        if stage in ('provider_inventory','provider_metadata','create_disabled_provider_propagation','enable_provider_last_propagation'): return 'iam','WorkloadIdentityPoolProvider'
        if stage in ('pool_policy','account_policy'): return 'iam','Policy'
        if stage in ('binding_before','binding_after'):
            return ('crm1' if args[0]=='projects' else 'secret' if args[0]=='secrets' else 'iam'),'Policy'
        return None

    def render(args, resources):
        argv=[*args,'--verbosity=error',f'--billing-project={m.PROJECT}']
        global_role=args[:3]==['iam','roles','describe'] and (args[3].startswith('roles/') or any(a.startswith('--organization=') for a in args))
        if not global_role: argv.append(f'--project={m.PROJECT}')
        if not any(a.startswith('--format=') for a in args): argv.append('--format=json')
        named_configs.FLAG_OVERRIDE_STACK.PushFromArgs(argv)
        properties.VALUES.PushInvocationValues()
        try:
            parsed=cli.top_element._parser.parse_args(argv)
            if parsed.CONCEPT_ARGS is not None: parsed.CONCEPT_ARGS.ParseConcepts()
            command=parsed._GetCommand()
            instance=command._common_type(cli=cli,context={})
            out=io.StringIO()
            with patch.object(log,'out',out):
                display.Displayer(instance,parsed,resources,display_info=command.ai.display_info).Display()
            return json.loads(out.getvalue())
        finally:
            properties.VALUES.PopInvocationValues()
            named_configs.FLAG_OVERRIDE_STACK.Pop()

    class TypedFake(Fake):
        def __init__(self, omit_defaults=False):
            super().__init__()
            self.omit_defaults=omit_defaults
            self.ancestors += [{'type':'folder','id':'123'},{'type':'organization','id':'456'}]
            # Exercise an existing custom role plus its describe/validation path.
            name='gardenCiMetadataRead'
            self.custom[name]={'name':m.role_name(name),'stage':'GA','includedPermissions':list(m.CUSTOM[name])}
            self.accounts[m.APPSPOT]=account(m.APPSPOT)
            self.policies[m.APPSPOT]={'version':3,'bindings':[]}
            self.ancestor_policy={'version':3,'bindings':[binding('roles/viewer','user:unrelated@example.invalid',m.condition())]}
        def __call__(self,args,stage,write=False):
            value=super().__call__(args,stage,write)
            if write: return value  # Only Fake's in-memory state changes.
            if self.omit_defaults:
                def scrub(v):
                    if isinstance(v,list): return [scrub(x) for x in v]
                    if isinstance(v,dict): return {k:scrub(x) for k,x in v.items() if x is not False and x != [] and not (k=='customRolesSupportLevel' and x=='SUPPORTED')}
                    return v
                value=scrub(value)
            schema=stage_type(stage,args)
            if schema:
                resource=[typed(*schema,x) for x in value] if isinstance(value,list) else typed(*schema,value)
            elif stage=='project_ancestors':
                resource=typed('crm1','GetAncestryResponse',{'ancestor':[{'resourceId':x} for x in value]})
            elif stage=='source_bucket_owner':
                message=typed('storage','Bucket',value)
                bucket=metadata_util.get_bucket_resource_from_metadata(message)
                resource=resource_util.get_display_dict_for_resource(bucket,full_resource_formatter.BucketDisplayTitlesAndDefaults,display_raw_keys=True)
            elif stage in ('owner_identity','gcloud_config'):
                resource=value  # These are local SDK Python dictionaries, not API messages.
            else: raise AssertionError('unmapped stage: '+stage)
            result=render(args,resource)
            seen.setdefault(stage,{'api_type':'.'.join(schema) if schema else 'transformed','shapes':set(),'calls':0})
            seen[stage]['shapes'].add(type(result).__name__)
            seen[stage]['calls']+=1
            return result

    for omit in (False,True):
        fake=TypedFake(omit)
        with tempfile.TemporaryDirectory(prefix='garden-schema-offline-') as folder:
            state=m.State(Path(folder)/'state')
            output=[]
            result=m.execute(fake,state,confirm=lambda p:p.removeprefix('Type exactly ').removesuffix(': '),emit=output.append,now=lambda:m.EXPIRY-86400000,sleep=lambda _:None)
            if result != 0:
                print(json.dumps({'status':'FAIL','omitDefaults':omit,'state':state.data,'output':output[-2:]},indent=2))
                raise AssertionError('Typed SDK pipeline stopped: '+state.data['stage'])
            assert state.data['setup_verified'] is True
            assert state.data['release_ready'] is False
            # Reusing the exact typed resources must yield a zero-change plan.
            assert m.make_plan(m.collect(fake))['actions']==[]

    assert len(seen) == 33, 'review every changed read-stage schema'
    print('SDK_RESPONSE_SCHEMAS_VERIFIED readStages=33 apiFamilies=7 fullDisplayer=true ancestorFlattening=true defaultOmission=true zeroChangePlan=true')


def verify_sdk_parser_and_prompts(sdk_root):
    """Real SDK argument parsing, resource formatting and prompt rejection.

    Called separately by credential-free CI after the official pinned SDK is
    installed. A private empty configuration, network/process audit hook, and
    SDK dispatch/auth intercepts fail closed before any provider operation.
    Never CLI.Execute/Command.Run; every resource used below is synthetic.
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
        # argparse accepts --format as a string without compiling its resource
        # projection. Exercise the real printer too: the original nested-field
        # spelling was interpreted as a transform and failed only at display.
        from googlecloudsdk.core.resource import resource_exceptions, resource_printer
        from apitools.base.py import encoding
        formats = {next(arg.split('=', 1)[1] for arg in argv if arg.startswith('--format=')) for argv in captured}
        assert len(formats) == 4, 'review all changed output formats'
        for argv in captured:
            projection = next(arg.split('=', 1)[1] for arg in argv if arg.startswith('--format='))
            resource_printer.Printer(projection, out=io.StringIO())
        function_format = next(f for f in formats if 'buildConfig' in f)
        expected_functions = Fake().functions
        samples = copy.deepcopy(expected_functions)
        for item in samples:
            item['labels'] = {'synthetic-private': 'must-not-appear'}
            item['buildConfig']['environmentVariables'] = {'SYNTHETIC_PRIVATE': 'must-not-appear'}
            item['serviceConfig']['environmentVariables'] = {'SYNTHETIC_PRIVATE': 'must-not-appear'}
        messages = apis.GetMessagesModule('cloudfunctions', 'v2')
        typed = [encoding.JsonToMessage(messages.Function, json.dumps(item)) for item in samples]
        for resources in (samples, typed):
            out = io.StringIO()
            resource_printer.Print(resources, function_format, out=out)
            assert json.loads(out.getvalue()) == expected_functions, 'nested function/source shape changed'
            assert 'SYNTHETIC_PRIVATE' not in out.getvalue() and 'must-not-appear' not in out.getvalue()
        fixtures = {
            'json': ({'synthetic': ['kept']}, {'synthetic': ['kept']}),
            'json(name,state)': ({'name': 'synthetic-secret-metadata', 'state': 'ENABLED', 'SYNTHETIC_PRIVATE': 'omit'},
                                 {'name': 'synthetic-secret-metadata', 'state': 'ENABLED'}),
            'json(name,projectNumber)': ({'name': 'synthetic-bucket', 'projectNumber': m.NUMBER, 'SYNTHETIC_PRIVATE': 'omit'},
                                        {'name': 'synthetic-bucket', 'projectNumber': m.NUMBER}),
        }
        assert formats == {function_format, *fixtures}
        for projection, (sample, expected) in fixtures.items():
            out = io.StringIO()
            resource_printer.Print(sample, projection, out=out, single=True)
            assert json.loads(out.getvalue()) == expected
        # Exercise the real provider-specific pipeline, not a hand-authored
        # display dictionary: API message -> GCS resource -> describe display
        # transform -> resource printer -> the helper's ownership predicate.
        from googlecloudsdk.api_lib.storage.gcs_json import metadata_util
        from googlecloudsdk.command_lib.storage.resources import full_resource_formatter, resource_util
        storage_messages = apis.GetMessagesModule('storage', 'v1')
        bucket_argv = next(argv for argv in captured if argv[:3] == ('storage', 'buckets', 'describe'))
        assert '--raw' in bucket_argv
        bucket_format = next(a.split('=', 1)[1] for a in bucket_argv if a.startswith('--format='))
        old_bucket_format = 'json(name,projectNumber,project_number)'
        for owner, expected_stage in ((int(m.NUMBER), None), (999999999999, 'source_bucket_owner_mismatch'),
                                       (None, 'source_bucket_owner_missing')):
            api_metadata = storage_messages.Bucket(name=m.BUCKET, projectNumber=owner,
                labels=storage_messages.Bucket.LabelsValue(additionalProperties=[
                    storage_messages.Bucket.LabelsValue.AdditionalProperty(key='synthetic-private', value='must-not-appear')]))
            resource = metadata_util.get_bucket_resource_from_metadata(api_metadata)
            assert resource.project_number == owner
            standard_display = resource_util.get_display_dict_for_resource(resource,
                full_resource_formatter.BucketDisplayTitlesAndDefaults, display_raw_keys=False)
            old_output = io.StringIO()
            resource_printer.Print(standard_display, old_bucket_format, out=old_output, single=True)
            assert json.loads(old_output.getvalue()) == {'name': m.BUCKET}, 'old command always loses owner evidence'
            raw_display = resource_util.get_display_dict_for_resource(resource,
                full_resource_formatter.BucketDisplayTitlesAndDefaults, display_raw_keys=True)
            output = io.StringIO()
            resource_printer.Print(raw_display, bucket_format, out=output, single=True)
            assert 'synthetic-private' not in output.getvalue() and 'must-not-appear' not in output.getvalue()
            try:
                identity = m.source_bucket_identity(json.loads(output.getvalue()))
            except m.Stop as error:
                assert expected_stage and error.stage == expected_stage
            else:
                assert expected_stage is None and identity == {'name': m.BUCKET, 'projectNumber': m.NUMBER}
        old_format = 'json(name,environment,state,buildConfig(serviceAccount,source),serviceConfig(serviceAccountEmail))'
        consumed = []
        def unseen():
            consumed.append(True)
            yield samples[0]
        try:
            resource_printer.Print(unseen(), old_format, out=io.StringIO())
        except resource_exceptions.UnknownTransformError as error:
            assert 'Unknown transform function buildConfig' in str(error)
        else:
            raise AssertionError('old invalid projection must fail the real SDK formatter')
        assert not consumed, 'format fails before consuming list resources'
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
        # Verify actual SDK backend/generation selection against hostile parent
        # defaults. Read class identities only; never instantiate any client.
        from googlecloudsdk.api_lib.storage import api_factory
        from googlecloudsdk.api_lib.storage.gcs_json import client as json_client
        from googlecloudsdk.command_lib.storage import storage_url
        from googlecloudsdk.command_lib.functions import flags as function_flags
        with patch.dict(os.environ, {'CLOUDSDK_STORAGE_PREFERRED_API': 'grpc_with_json_fallback',
                                     'CLOUDSDK_STORAGE_USE_GRPC_IF_AVAILABLE': 'true',
                                     'CLOUDSDK_FUNCTIONS_GEN2': 'false'}):
            runner = m.Gcloud()
            with patch.dict(os.environ, runner.env, clear=True):
                assert properties.VALUES.storage.preferred_api.Get() == 'json'
                assert properties.VALUES.storage.use_grpc_if_available.GetBool() is False
                assert api_factory._get_api_class(storage_url.ProviderPrefix.GCS, False) is json_client.JsonClient
                assert function_flags.ShouldUseGen2() is True and function_flags.ShouldUseGen1() is False
        verify_sdk_response_schemas()
        assert not blocked
        print('SDK_PARSE_VERIFIED version=568.0.0 argvVariants=67 oldInvalidFlagRejected=true commandRuns=0 networkRequests=0 credentialAccess=0')
        print('SDK_FORMAT_VERIFIED argvVariants=67 formats=4 dictAndProtoShape=true privateFieldsOmitted=true oldInvalidFormatRejected=true')
        print('SDK_BUCKET_PIPELINE_VERIFIED rawApiResourceDisplayProjection=true standardDisplayDropsOwner=true exactOwnerRequired=true wrongAndMissingOwnerRejected=true')
        print('SDK_API_SELECTION_VERIFIED storageJson=true functionsGen2=true parentSettingsUnchanged=true alternateStorageCredentialsRejected=true')
        print('SDK_PROMPT_VERIFIED repeatedNo=true eofDefaultYesReproduced=true ownerApprovalInputUntouched=true')


if __name__ == '__main__':
    unittest.main(verbosity=2)
