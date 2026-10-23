#!/usr/bin/env python3
"""Offline renewal regression. All cloud calls fake; real processes/network forbidden.

python3 -I tests/floating-garden-ci-trust-renewal.test.py
python3 -I tests/floating-garden-ci-trust-renewal.test.py --sdk-root /trusted/google-cloud-sdk
The optional exact SDK 568/587 contract test executes its real parser/request builder with
an in-memory HTTP transport and independently blocks processes and networking.
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


m = module('garden_renewal', ROOT / 'scripts/renew-floating-garden-ci-trust-owner.py')
f = module('garden_setup_fixture', ROOT / 'tests/floating-garden-ci-setup.test.py')
f.m = m.base  # Use the shared Stop type; only borrow synthetic fixtures.
b = m.base
NEW_SHA = 'a' * 40  # Synthetic test input, never an approved/released commit.


class Fake(f.Fake):
    def __init__(self):
        super().__init__()
        self.release_sha, self.release_run_number = m.VALIDATION_SHA, '2'
        self.services = list(b.APIS) + list(b.REQUIRED_EXISTING_APIS)
        self.accounts[b.DEPLOYER] = f.account(b.DEPLOYER)
        self.pool = {'name': b.POOL_NAME, 'state': 'ACTIVE', 'displayName': 'Garden GitHub'}
        self.provider = {'name': b.PROVIDER_NAME, 'state': 'ACTIVE', 'attributeMapping': copy.deepcopy(b.MAPPING),
                         'attributeCondition': m.OLD_CONDITION, 'oidc': {'issuerUri': 'https://token.actions.githubusercontent.com'}}
        self.custom = {name: {'name': b.role_name(name), 'stage': 'GA', 'includedPermissions': list(permissions)}
                       for name, permissions in b.CUSTOM.items()}
        for target, role, member, cond in b.expected_bindings([b.RUNTIME, f.BUILD]):
            self.policies[target]['bindings'].append(f.binding(role, member, cond))
        self.after_write = None
        self.write_error = None
        self.version = {'Google Cloud SDK': '568.0.0'}
        self.owner = 'owner@example.invalid'

    def __call__(self, args, stage, write=False):
        if stage == 'owner_identity':
            self.calls.append((copy.deepcopy(args), stage, write))
            return [{'account': self.owner, 'status': 'ACTIVE'}]
        if stage == 'gcloud_version':
            self.calls.append((copy.deepcopy(args), stage, write))
            return copy.deepcopy(self.version)
        if write:
            self.calls.append((copy.deepcopy(args), stage, write))
            assert self.approved
            assert stage == 'renew_provider_condition'
            assert args == m.update_args(NEW_SHA)
            if self.mutate:
                self.mutate(self, args, stage, write)
            if self.write_error:
                raise self.write_error
            self.provider['attributeCondition'] = m.new_condition(NEW_SHA)
            if self.after_write:
                self.after_write(self)
            return {'name': 'synthetic-operation'}
        return super().__call__(args, stage, write)


class RenewalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = m.State(Path(self.temp.name) / 'private')
        self.fake, self.output = Fake(), []
        for target, attr in ((subprocess, 'run'), (subprocess, 'Popen'), (socket, 'socket'), (socket, 'create_connection')):
            guard = patch.object(target, attr, side_effect=AssertionError('Real process/network forbidden'))
            guard.start(); self.addCleanup(guard.stop)

    def run_renewal(self, confirm=None, now=None):
        return m.execute(self.fake, self.state, NEW_SHA, confirm=confirm or self.approve,
                         emit=self.output.append, now=now or (lambda: b.EXPIRY - 86400000))

    @staticmethod
    def approve(prompt):
        return prompt.removeprefix('Type exactly ').removesuffix(': ')

    def stopped_without_write(self, stage=None):
        self.assertEqual(self.run_renewal(), 2, self.output)
        self.assertEqual(self.fake.writes, [])
        self.assertFalse(self.state.data['trust_metadata_verified'])
        if stage:
            self.assertEqual(self.state.data['stage'], stage)

    def test_run5_contract_binds_verified_run4_and_preserves_setup_dependency(self):
        self.assertEqual(m.OLD_SHA, '69ef07b9356470fbd3a643638baeec12bdd5680c')
        self.assertEqual((m.OLD_RUN, m.NEW_RUN), ('4', '5'))
        self.assertEqual(m.VALIDATION_SHA, '74027567a8761e78423c8df0e744abc8d5633a8b')
        self.assertEqual(m.hashlib.sha256((ROOT / 'scripts/setup-floating-garden-ci-owner.py').read_bytes()).hexdigest(),
                         '8a4c2a4a4fc2725b19ec2159766559bed120e11e9c8605933661b11dddef77b5')
        old, new = m.OLD_CONDITION.split(' && '), m.new_condition(NEW_SHA).split(' && ')
        self.assertEqual(len(old), 9)
        self.assertEqual(len(new), 9)
        self.assertEqual(old[:7], new[:7])
        self.assertEqual(old[-2:], [f"assertion.workflow_sha == '{m.OLD_SHA}'", "assertion.run_number == '4'"])
        self.assertEqual(new[-2:], [f"assertion.workflow_sha == '{NEW_SHA}'", "assertion.run_number == '5'"])
        self.assertEqual(self.state.data['kind'], 'garden-run-5-trust-renewal-v1')
        self.assertEqual(b.EXPIRY, 1791762351472)

    def test_live_condition_verified_before_only_legacy_condition_projection(self):
        for condition in (m.OLD_CONDITION, m.new_condition(NEW_SHA)):
            self.fake.provider['attributeCondition'] = condition
            before = m.collect(self.fake, NEW_SHA)
            retained = copy.deepcopy(before)
            with patch.object(b, 'validate_state', wraps=b.validate_state) as validator:
                self.assertIn(m.validate_snapshot(before, NEW_SHA), ('original', 'intended'))
            expected = copy.deepcopy(before)
            expected['provider']['attributeCondition'] = m.VALIDATION_CONDITION
            self.assertEqual(validator.call_args.args[0], expected)
            self.assertEqual(before, retained)
            self.assertEqual(before['provider']['attributeCondition'], condition)
            plan = m.make_plan(before, NEW_SHA)
            self.assertEqual(plan['from_condition'], condition)
            self.assertEqual(plan['to_condition'], m.new_condition(NEW_SHA))
            self.assertEqual(plan['kind'], 'garden-run-5-trust-renewal-v1')
        before['provider']['attributeCondition'] = m.VALIDATION_CONDITION
        with patch.object(b, 'validate_state', side_effect=AssertionError('Must reject LIVE drift first')):
            with self.assertRaises(b.Stop): m.validate_snapshot(before, NEW_SHA)

    def test_validation_projection_never_masks_context_or_other_fields(self):
        before = m.collect(self.fake, NEW_SHA)
        for key, value in (('release_sha', m.OLD_SHA), ('release_run_number', '4')):
            changed = copy.deepcopy(before); changed[key] = value
            with self.assertRaises(b.Stop) as error: m.validate_snapshot(changed, NEW_SHA)
            self.assertEqual(error.exception.stage, 'immutable_validation_context_required')
        changed = copy.deepcopy(before)
        changed['provider']['oidc']['issuerUri'] = 'https://unexpected.invalid'
        with self.assertRaises(b.Stop): m.validate_snapshot(changed, NEW_SHA)
        changed = copy.deepcopy(before)
        changed['policies']['project']['bindings'].append(f.binding('roles/owner', b.MEMBER))
        with self.assertRaises(b.Stop): m.validate_snapshot(changed, NEW_SHA)

    def test_existing_cloud_shell_credential_discovery_is_not_overridden(self):
        with patch.dict(os.environ, {}, clear=True):
            run = m.ReadOnlyGcloud()
            self.assertNotIn('CLOUDSDK_CORE_CHECK_GCE_METADATA', run.env)
        for value in ('true', 'false'):
            with patch.dict(os.environ, {'CLOUDSDK_CORE_CHECK_GCE_METADATA': value}, clear=True):
                self.assertEqual(m.ReadOnlyGcloud().env['CLOUDSDK_CORE_CHECK_GCE_METADATA'], value)

    def test_run3_and_run4_journals_are_never_reused_or_overwritten(self):
        for run in ('3', '4'):
            with self.subTest(run=run):
                old = Path(self.temp.name) / ('old-run' + run); old.mkdir(mode=0o700)
                file = old / 'status-0000.json'
                source = '{"kind":"garden-run-' + run + '-trust-renewal-v1","mutation_attempts":1}'
                file.write_text(source); file.chmod(0o600)
                with self.assertRaises(b.Stop): m.State(old)
                self.assertEqual(file.read_text(), source)
                self.assertEqual(len(list(old.iterdir())), 1)

    def test_sdk_version_must_match_offline_contract(self):
        self.fake.version = {'Google Cloud SDK': '999.0.0'}
        self.stopped_without_write('reviewed_owner_sdk_required')
        self.assertEqual(len(self.fake.calls), 1)

    def test_exact_587_owner_renewal_keeps_same_single_write(self):
        self.fake.version = {'Google Cloud SDK': '587.0.0'}
        self.assertEqual(self.run_renewal(), 0)
        self.assertEqual(self.fake.writes, [(m.update_args(NEW_SHA), 'renew_provider_condition')])
        self.assertTrue(self.state.data['trust_metadata_verified'])
        self.assertFalse(self.state.data['release_ready'])

    def test_final_journal_failure_never_reports_completed_or_clears_uncertainty(self):
        original = self.state.save
        def save():
            if self.state.data['stage'] == 'trust_metadata_verified':
                raise OSError('synthetic final persistence failure')
            return original()
        with patch.object(self.state, 'save', side_effect=save):
            self.assertEqual(self.run_renewal(), 2)
        self.assertEqual(len(self.fake.writes), 1)
        self.assertFalse(self.state.data['trust_metadata_verified'])
        self.assertTrue(self.state.data['possibly_applied'])
        self.assertNotIn('TRUST_METADATA_VERIFIED', '\n'.join(self.output))

    def test_default_and_explicit_plan_offline_without_target(self):
        for args in ([], ['--plan'], ['--plan', '--approved-release-sha', NEW_SHA]):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(m.main(args), 0)
            data = json.loads(output.getvalue())
            self.assertEqual(data['cloud_calls'], 0)
            self.assertEqual(data['original_expiry'], b.EXPIRY)
            self.assertEqual(data['only_write_field'], 'attributeCondition')

    def test_cli_missing_scope_noninteractive_and_bypass_rejected(self):
        for args in (['--renew'], ['--renew', '--yes'], ['--renew', '--resume'], ['--setup']):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    self.assertEqual(m.main(args), 2)
                except SystemExit as error:
                    self.assertEqual(error.code, 2)
        full = ['--renew', '--project', b.PROJECT, '--project-number', b.NUMBER, '--original-expiry',
                str(b.EXPIRY), '--approved-release-sha', NEW_SHA, '--approved-release-run-number', '5',
                '--state-dir', str(Path(self.temp.name) / 'other')]
        with patch.object(sys.stdin, 'isatty', return_value=False), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(full), 2)
        self.assertFalse((Path(self.temp.name) / 'other').exists())

    def test_new_sha_and_run_are_strict(self):
        for sha in (None, '', 'a' * 39, 'A' * 40, 'g' * 40, m.OLD_SHA, "' || true", 'a' * 40 + '\n'):
            with self.subTest(sha=sha), self.assertRaises(b.Stop):
                m.new_condition(sha)
        for run in ('2', '3', '4', '6', '', None, 5, '05'):
            with self.subTest(run=run), self.assertRaises(b.Stop):
                m.new_condition(NEW_SHA, run)

    def test_exact_happy_path_only_two_claims_change_with_full_backup(self):
        initial = m.collect(self.fake, NEW_SHA)
        def before_dispatch(fake, args, stage, write):
            if write:
                saved = json.loads((self.state.path / 'before.json').read_text())
                self.assertEqual(saved, initial)
                journals = sorted(self.state.path.glob('status-*.json'))
                self.assertTrue(json.loads(journals[-1].read_text())['possibly_applied'])
        self.fake.mutate = before_dispatch
        self.assertEqual(self.run_renewal(), 0, self.output)
        self.assertEqual(self.fake.writes, [(m.update_args(NEW_SHA), 'renew_provider_condition')])
        expected = copy.deepcopy(initial)
        expected['provider']['attributeCondition'] = m.new_condition(NEW_SHA)
        self.assertEqual(json.loads((self.state.path / 'after.json').read_text()), expected)
        self.assertTrue(self.state.data['trust_metadata_verified'])
        self.assertFalse(self.state.data['possibly_applied'])
        self.assertFalse(self.state.data['release_ready'])
        self.assertFalse(self.fake.approved)
        self.assertEqual(stat.S_IMODE(self.state.path.stat().st_mode), 0o700)
        for file in self.state.path.iterdir():
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        for _, stage, _ in self.fake.calls:
            self.assertNotEqual(stage, 'custom_permission_support')
        visible = '\n'.join(self.output)
        self.assertNotIn('owner@example', visible)
        self.assertNotIn('unrelated@example', visible)
        self.assertIn(b.DEADLINE, visible)

    def test_no_write_without_exact_hash_confirmation(self):
        def decline(prompt):
            self.assertRegex(prompt, r'^Type exactly RENEW [a-f0-9]{64}: $')
            self.assertEqual(self.fake.writes, [])
            return 'yes'
        self.assertEqual(self.run_renewal(decline), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'owner_confirmation_declined')
        self.assertFalse((self.state.path / 'before.json').exists())

    def test_idempotence_only_exact_new_state_and_two_full_reads(self):
        self.fake.provider['attributeCondition'] = m.new_condition(NEW_SHA)
        self.assertEqual(self.run_renewal(lambda _: self.fail('No-op must not request mutation approval')), 0)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(sum(stage == 'provider_metadata' for _, stage, _ in self.fake.calls), 2)
        self.assertEqual(self.state.data['stage'], 'already_exact_intended_state')
        self.assertTrue(self.state.data['trust_metadata_verified'])

    def test_wrong_condition_always_fails_instead_of_repair(self):
        variants = [m.VALIDATION_CONDITION,
                    b.ATTRIBUTE_CONDITION + " && assertion.workflow_sha == '95ec4e69e4b566df91a37a4107e1a1fd94478ebf' && assertion.run_number == '3'",
                    m.OLD_CONDITION.replace("run_number == '4'", "run_number == '2'"),
                    m.OLD_CONDITION.replace("run_number == '4'", "run_number == '3'"),
                    m.OLD_CONDITION.replace("run_number == '4'", "run_number == '5'"),
                    m.OLD_CONDITION.replace(m.OLD_SHA, m.VALIDATION_SHA),
                    m.OLD_CONDITION.replace(m.OLD_SHA, 'b' * 40),
                    m.new_condition('b' * 40), m.new_condition(NEW_SHA).replace("run_number == '5'", "run_number == '4'"),
                    m.OLD_CONDITION.replace("run_attempt == '1'", "run_attempt == '2'"),
                    m.OLD_CONDITION + ' || true', m.OLD_CONDITION + ' ',
                    m.OLD_CONDITION.replace('1321198654', '999'),
                    m.OLD_CONDITION.replace("event_name == 'push'", "event_name == 'workflow_dispatch'"),
                    m.OLD_CONDITION.replace('garden-trial', 'production')]
        for condition in variants:
            with self.subTest(condition=condition):
                self.fake = Fake()
                self.fake.provider['attributeCondition'] = condition
                self.stopped_without_write('unexpected_provider_condition')

    def test_disabled_deleted_missing_or_additional_federation_rejected(self):
        cases = [lambda x: x.provider.update(disabled=True), lambda x: x.provider.update(disabled=0),
                 lambda x: x.provider.update(state='DELETED'), lambda x: x.provider.update(unknown='x'),
                 lambda x: x.provider.update(displayName='unexpected'),
                 lambda x: x.pool.update(disabled=True), lambda x: x.pool.update(displayName='unexpected'),
                 lambda x: setattr(x, 'provider', None), lambda x: setattr(x, 'pool', None),
                 lambda x: setattr(x, 'extra_provider', True)]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                self.fake = Fake(); mutate(self.fake)
                self.stopped_without_write()

    def test_issuer_mapping_audience_jwks_and_protocol_drift_rejected(self):
        cases = [lambda p: p['oidc'].update(issuerUri='https://unexpected.invalid'),
                 lambda p: p['oidc'].update(allowedAudiences=['other']),
                 lambda p: p['oidc'].update(jwksJson='{}'),
                 lambda p: p['oidc'].update(allowedAudiences=None),
                 lambda p: p['oidc'].update(extra=True), lambda p: p.update(saml={}),
                 lambda p: p['attributeMapping'].update({'attribute.extra': 'assertion.extra'})]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                self.fake = Fake(); mutate(self.fake.provider)
                self.stopped_without_write()

    def test_missing_original_grant_or_extended_expiry_rejected(self):
        for case in ('missing', 'extended', 'unconditional', 'extra'):
            with self.subTest(case=case):
                self.fake = Fake()
                binding = self.fake.policies[b.DEPLOYER]['bindings'][0]
                if case == 'missing': self.fake.policies[b.DEPLOYER]['bindings'] = []
                elif case == 'extended': binding['condition']['expression'] = "request.time < timestamp('2030-01-01T00:00:00Z')"
                elif case == 'unconditional': del binding['condition']
                else: self.fake.policies['project']['bindings'].append(f.binding('roles/owner', b.MEMBER))
                self.stopped_without_write()

    def test_missing_roles_accounts_apis_or_keys_rejected(self):
        cases = [lambda x: x.custom.pop(next(iter(x.custom))),
                 lambda x: x.accounts.pop(b.DEPLOYER), lambda x: x.services.remove(b.APIS[0]),
                 lambda x: x.keys.append({'name': 'synthetic-user-key'}),
                 lambda x: x.accounts[b.RUNTIME].update(disabled=True)]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                self.fake = Fake(); mutate(self.fake)
                self.stopped_without_write()

    def test_post_confirmation_change_stops_before_mutation(self):
        def confirm(prompt):
            self.fake.policies['project']['bindings'].append(f.binding('roles/viewer', 'user:new@example.invalid'))
            return self.approve(prompt)
        self.assertEqual(self.run_renewal(confirm), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'state_changed_confirm_again')
        self.assertTrue((self.state.path / 'before.json').exists())

    def test_account_identity_changes_cannot_reuse_approval(self):
        # Change an otherwise valid inspected account unique ID after approval.
        def confirm(prompt):
            self.fake.accounts[b.RUNTIME]['uniqueId'] = '999999999999999999999'
            return self.approve(prompt)
        self.assertEqual(self.run_renewal(confirm), 2)
        self.assertEqual(self.fake.writes, [])

    def test_signed_in_owner_change_cannot_reuse_approval(self):
        def confirm(prompt):
            self.fake.owner = 'another-owner@example.invalid'
            return self.approve(prompt)
        self.assertEqual(self.run_renewal(confirm), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'state_changed_confirm_again')
        self.assertNotIn(self.fake.owner, '\n'.join(self.output))

    def test_confirmation_eof_and_keyboard_interrupt_stop_without_write(self):
        for error in (EOFError, KeyboardInterrupt):
            with self.subTest(error=error):
                def confirm(_): raise error()
                self.assertEqual(self.run_renewal(confirm), 2)
                self.assertEqual(self.fake.writes, [])
                self.assertEqual(self.state.data['stage'], 'owner_interrupted')
                self.assertFalse(self.fake.approved)

    def test_interrupt_after_applied_write_keeps_uncertainty_and_no_retry(self):
        def interrupted(_): raise KeyboardInterrupt()
        self.fake.after_write = interrupted
        self.assertEqual(self.run_renewal(), 2)
        self.assertEqual(self.fake.provider['attributeCondition'], m.new_condition(NEW_SHA))
        self.assertEqual(len(self.fake.writes), 1)
        self.assertTrue(self.state.data['possibly_applied'])
        self.assertFalse(self.state.data['trust_metadata_verified'])
        self.assertFalse(self.fake.approved)
        self.assertEqual(self.state.data['stage'], 'owner_interrupted')

    def test_postwrite_unrelated_iam_or_provider_changes_are_not_success(self):
        for mutate in (lambda x: x.policies['project']['bindings'].append(f.binding('roles/viewer', 'user:new@example.invalid')),
                       lambda x: x.provider.update(disabled=True),
                       lambda x: x.provider.update(attributeCondition=m.OLD_CONDITION)):
            with self.subTest(mutate=mutate):
                self.fake = Fake(); self.fake.after_write = mutate
                # Each attempted renewal must use a new private history directory.
                self.state = m.State(Path(self.temp.name) / ('case-' + str(len(list(Path(self.temp.name).iterdir())))))
                self.assertEqual(self.run_renewal(), 2)
                self.assertEqual(len(self.fake.writes), 1)
                self.assertFalse(self.state.data['trust_metadata_verified'])
                self.assertTrue(self.state.data['possibly_applied'])

    def test_failed_uncertain_write_not_retried_or_rolled_back(self):
        self.fake.write_error = b.Stop('renew_provider_condition', local_code='CLI_TIMEOUT')
        self.assertEqual(self.run_renewal(), 2)
        self.assertEqual(len(self.fake.writes), 1)
        self.assertTrue(self.state.data['possibly_applied'])
        self.assertFalse(self.fake.approved)

    def test_postwrite_read_failure_retains_uncertainty(self):
        self.fake.after_write = lambda x: setattr(x, 'fail_stage', 'provider_metadata')
        self.assertEqual(self.run_renewal(), 2)
        self.assertEqual(len(self.fake.writes), 1)
        self.assertTrue(self.state.data['possibly_applied'])
        self.assertFalse(self.state.data['trust_metadata_verified'])

    def test_deadline_expired_before_reads_and_during_confirmation(self):
        self.assertEqual(self.run_renewal(now=lambda: b.EXPIRY), 2)
        self.assertEqual(self.fake.calls, [])
        clock = [b.EXPIRY - 1000]
        def confirm(prompt):
            clock[0] = b.EXPIRY
            return self.approve(prompt)
        self.assertEqual(self.run_renewal(confirm, now=lambda: clock[0]), 2)
        self.assertEqual(self.fake.writes, [])

    def test_confirmation_five_minute_limit_includes_fresh_reads(self):
        clock = [b.EXPIRY - 86400000]
        confirmed = [False]
        def confirm(prompt):
            confirmed[0] = True
            return self.approve(prompt)
        def mutate(fake, args, stage, write):
            if stage == 'provider_metadata' and confirmed[0]: clock[0] += 300001
        self.fake.mutate = mutate
        self.assertEqual(self.run_renewal(confirm, now=lambda: clock[0]), 2)
        self.assertEqual(self.fake.writes, [])

    def test_backup_failure_blocks_write_and_status_failure_is_redacted(self):
        with patch.object(self.state, 'save_file', side_effect=OSError('synthetic private detail')):
            self.assertEqual(self.run_renewal(), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertNotIn('synthetic private detail', '\n'.join(self.output))

    def test_no_backup_overwrite_and_no_state_dir_reuse_or_symlink(self):
        self.state.save_file('before.json', {'preserved': True})
        with self.assertRaises(FileExistsError): self.state.save_file('before.json', {})
        self.assertEqual(json.loads((self.state.path / 'before.json').read_text()), {'preserved': True})
        with self.assertRaises(b.Stop): m.State(self.state.path)
        link = Path(self.temp.name) / 'link'
        link.symlink_to(self.state.path, target_is_directory=True)
        with self.assertRaises(b.Stop): m.State(link)

    def test_noop_detects_drift_without_writing(self):
        self.fake.provider['attributeCondition'] = m.new_condition(NEW_SHA)
        counts = [0]
        def mutate(fake, args, stage, write):
            if stage == 'provider_metadata':
                counts[0] += 1
                if counts[0] == 2: fake.provider['attributeCondition'] = m.OLD_CONDITION
        self.fake.mutate = mutate
        self.assertEqual(self.run_renewal(), 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.state.data['stage'], 'state_changed_during_noop')

    def test_wrapper_denies_every_other_mutation_and_second_attempt(self):
        with patch.dict(os.environ, {}, clear=True): run = m.RenewalGcloud(NEW_SHA)
        with self.assertRaises(b.Stop): run(m.update_args(NEW_SHA), 'renew_provider_condition', write=True)
        run.approved = True
        for args in (m.update_args(NEW_SHA) + ['--no-disabled'], ['services', 'enable', 'iam.googleapis.com']):
            with self.assertRaises(b.Stop): run(args, 'renew_provider_condition', write=True)
        observed = []
        def process(command, **kwargs):
            observed.append(command)
            self.assertNotIn('--quiet', command)
            self.assertEqual(kwargs['env']['CLOUDSDK_CORE_DISABLE_PROMPTS'], 'false')
            self.assertEqual(os.read(kwargs['stdin'], 2), b'n\n')
            return subprocess.CompletedProcess(command, 0, b'{}', b'')
        with patch.object(b.subprocess, 'run', side_effect=process):
            run(m.update_args(NEW_SHA), 'renew_provider_condition', write=True)
            with self.assertRaises(b.Stop): run(m.update_args(NEW_SHA), 'renew_provider_condition', write=True)
        self.assertEqual(len(observed), 1)
        self.assertIn('--project=' + b.PROJECT, observed[0])
        self.assertIn('--billing-project=' + b.PROJECT, observed[0])

    def test_credential_and_endpoint_overrides_rejected(self):
        for name in ('GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_API_ENDPOINT_OVERRIDES_IAM'):
            with self.subTest(name=name), patch.dict(os.environ, {name: 'untrusted'}, clear=True), self.assertRaises(b.Stop):
                m.RenewalGcloud(NEW_SHA)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.fake, self.output = Fake(), []
        self.fake.version = {'Google Cloud SDK': '587.0.0'}
        for target, attr in ((subprocess, 'run'), (subprocess, 'Popen'), (socket, 'socket'),
                             (socket, 'create_connection'), (m, 'RenewalGcloud'), (m, 'execute'),
                             (m, 'State'), (b, 'execute'), (b, 'make_plan')):
            guard = patch.object(target, attr, side_effect=AssertionError('Audit cannot write, plan setup, or run real processes/network'))
            guard.start(); self.addCleanup(guard.stop)

    def run_audit(self, now=None):
        return m.audit(self.fake, NEW_SHA, emit=self.output.append,
                       now=now or (lambda: b.EXPIRY - 86400000))

    def test_audit_original_and_intended_two_complete_reads_redacted(self):
        for intended in (False, True):
            self.fake = Fake(); self.fake.version = {'Google Cloud SDK': '587.0.0'}
            if intended: self.fake.provider['attributeCondition'] = m.new_condition(NEW_SHA)
            self.assertEqual(self.run_audit(), 0, self.output)
            self.assertEqual(self.fake.writes, [])
            self.assertFalse(self.fake.approved)
            self.assertEqual(sum(stage == 'provider_metadata' for _, stage, _ in self.fake.calls), 2)
            value = json.loads(self.output[-1])
            self.assertEqual(value['condition_state'], 'intended' if intended else 'original')
            self.assertEqual(value['cloud_writes'], 0)
            self.assertFalse(value['release_ready'])
            self.assertEqual(value['owner_sdk'], '587.0.0')
            self.assertNotIn('owner@example', self.output[-1])
            self.assertNotIn('bindings', self.output[-1])
            self.assertNotIn('attributeCondition', self.output[-1])
            self.assertLess(len(self.output[-1]), 700)
            self.assertTrue(all(m.read_allowed(args, stage) for args, stage, _ in self.fake.calls))

    def test_exact_version_allowlist_for_audit_and_writer_preflight(self):
        for version in ('568.0.0', '587.0.0'):
            self.fake.version = {'Google Cloud SDK': version}
            self.assertEqual(self.run_audit(), 0)
        for version in ('567.0.0', '569.0.0', '586.0.0', '588.0.0', '587.0.1', '587', 587, None):
            self.fake = Fake(); self.fake.version = {'Google Cloud SDK': version}
            self.assertEqual(self.run_audit(), 2)
            self.assertEqual(len(self.fake.calls), 1)
            self.assertEqual(self.fake.writes, [])

    def test_every_baseline_drift_is_rejected_without_repair(self):
        cases = [lambda x: x.provider['oidc'].update(allowedAudiences=['other']),
                 lambda x: x.provider['attributeMapping'].update(extra='assertion.extra'),
                 lambda x: x.provider.update(attributeCondition=m.new_condition('b' * 40)),
                 lambda x: x.provider.update(disabled=True),
                 lambda x: x.pool.update(displayName='drift'),
                 lambda x: x.services.remove(b.APIS[0]),
                 lambda x: x.services.remove(b.REQUIRED_EXISTING_APIS[0]),
                 lambda x: x.custom.pop(next(iter(x.custom))),
                 lambda x: x.custom[next(iter(x.custom))]['includedPermissions'].append('iam.roles.update'),
                 lambda x: x.accounts.pop(b.DEPLOYER),
                 lambda x: x.keys.append({'name': 'synthetic-key'}),
                 lambda x: x.accounts[b.RUNTIME].update(disabled=True),
                 lambda x: x.policies[b.DEPLOYER].update(bindings=[]),
                 lambda x: x.policies['project']['bindings'].append(f.binding('roles/owner', b.MEMBER)),
                 lambda x: x.policies[b.DEPLOYER]['bindings'][0]['condition'].update(expression='true'),
                 lambda x: x.bucket.update(projectNumber='999'),
                 lambda x: x.bucket.pop('projectNumber'),
                 lambda x: x.functions.pop(),
                 lambda x: x.functions[0]['serviceConfig'].update(serviceAccountEmail=b.DEPLOYER),
                 lambda x: x.functions[0]['buildConfig']['source']['storageSource'].update(bucket='foreign'),
                 lambda x: setattr(x, 'hmac_version', '2'),
                 lambda x: x.config.update(auth={'impersonate_service_account': 'synthetic'})]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                self.fake = Fake(); mutate(self.fake)
                self.assertEqual(self.run_audit(), 2)
                self.assertEqual(self.fake.writes, [])
                self.assertFalse(self.fake.approved)
                self.assertNotIn('TRUST_AUDIT_VERIFIED', self.output[-1])

    def test_incomplete_read_or_intervening_drift_stops(self):
        for stage in ('function_metadata', 'source_bucket_owner', 'project_policy', 'role_metadata', 'provider_metadata'):
            self.fake = Fake(); self.fake.fail_stage = stage
            self.assertEqual(self.run_audit(), 2)
            self.assertEqual(self.fake.writes, [])
        self.fake = Fake()
        count = [0]
        def mutate(fake, args, stage, write):
            if stage == 'provider_metadata':
                count[0] += 1
                if count[0] == 2: fake.provider['attributeCondition'] = m.new_condition(NEW_SHA)
        self.fake.mutate = mutate
        self.assertEqual(self.run_audit(), 2)
        self.assertIn('state_changed_during_audit', self.output[-1])
        self.assertEqual(self.fake.writes, [])

    def test_expiry_checked_before_and_after_reads(self):
        self.assertEqual(self.run_audit(now=lambda: b.EXPIRY), 2)
        self.assertEqual(self.fake.calls, [])
        moments = iter([b.EXPIRY - 1, b.EXPIRY])
        self.assertEqual(self.run_audit(now=lambda: next(moments)), 2)
        self.assertEqual(self.fake.writes, [])

    def test_malformed_nested_metadata_stops_with_bounded_diagnostic(self):
        for malformed in ([], {'auth': []}, {'storage': []}):
            self.fake = Fake(); self.fake.config = malformed
            self.assertEqual(self.run_audit(), 2)
            self.assertEqual(self.fake.writes, [])
            self.assertEqual(self.output[-1], 'TRUST_AUDIT_STOP stage=metadata_or_local_state_error cloud_writes=0 release_ready=false.')

    def test_read_runner_cannot_dispatch_writer_even_mislabeled(self):
        with patch.dict(os.environ, {}, clear=True): run = m.ReadOnlyGcloud()
        run.approved = True  # This never enables the read-only boundary.
        attempts = [(m.update_args(NEW_SHA), 'renew_provider_condition'),
                    (m.update_args(NEW_SHA), 'provider_metadata'),
                    (['services', 'enable', 'iam.googleapis.com'], 'enabled_apis'),
                    (['auth', 'login'], 'owner_identity'),
                    (['secrets', 'versions', 'access', 'latest', '--secret=' + b.SECRET], 'hmac_latest_metadata'),
                    (['config', 'set', 'project', b.PROJECT], 'gcloud_config'),
                    (['version', '--quiet'], 'gcloud_version'),
                    (['iam', 'roles', 'describe', 'roles/owner', '--impersonate-service-account=x'], 'role_metadata')]
        for args, stage in attempts:
            for write in (False, True):
                with self.subTest(args=args, write=write), self.assertRaises(b.Stop):
                    run(args, stage, write=write)
        with self.assertRaises(b.Stop): run(['version'], 'gcloud_version', write=True)
        self.assertEqual(run.calls, 0)

    def test_audit_cli_no_tty_no_journal_no_writer(self):
        args = ['--audit', '--project', b.PROJECT, '--project-number', b.NUMBER,
                '--original-expiry', str(b.EXPIRY), '--approved-release-sha', NEW_SHA,
                '--approved-release-run-number', '5']
        with patch.object(m, 'ReadOnlyGcloud', return_value=self.fake), \
             patch.object(sys.stdin, 'isatty', side_effect=AssertionError('Audit does not require input')), \
             patch.object(m.time, 'time', return_value=(b.EXPIRY - 86400000) / 1000), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(args), 0)
            self.assertEqual(m.main(args + ['--state-dir', '/unused']), 2)
        self.assertIn('TRUST_AUDIT_VERIFIED', output.getvalue())
        self.assertIn('audit_has_no_state_directory', output.getvalue())
        self.assertEqual(self.fake.writes, [])

    def test_cli_requires_exact_scope_and_target_no_audit_bypass(self):
        for args in (['--audit'], ['--audit', '--renew'], ['--audit', '--plan'],
                     ['--audit', '--yes'], ['--audit', '--resume']):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try: self.assertEqual(m.main(args), 2)
                except SystemExit as error: self.assertEqual(error.code, 2)


def verify_sdk(sdk_root):
    """Execute real SDK command; replace only its HTTP boundary."""
    import runpy
    from urllib.parse import parse_qs, urlsplit
    sdk_root = sdk_root.resolve()
    sdk_version = (sdk_root / 'VERSION').read_text().strip()
    assert sdk_version in ('568.0.0', '587.0.0')
    class UnsafeAction(BaseException):
        pass
    def forbid(*args, **kwargs):
        raise UnsafeAction('Real credentials, network, process, or installation forbidden')
    def audit(event, args):
        if (event.startswith('socket.') and event != 'socket.gethostname') or event in (
                'subprocess.Popen', 'os.system', 'os.posix_spawn', 'os.spawn', 'os.exec'):
            forbid()
    sys.addaudithook(audit)
    socket.has_ipv6 = False
    with tempfile.TemporaryDirectory(prefix='garden-renewal-sdk-') as tmp:
        config = Path(tmp) / 'config'; config.mkdir(mode=0o700)
        os.environ.clear()
        os.environ.update(HOME=tmp, PATH='/usr/bin:/bin', COLUMNS='80', LINES='24',
            CLOUDSDK_CONFIG=str(config), CLOUDSDK_AUTH_DISABLE_CREDENTIALS='true',
            CLOUDSDK_CORE_CHECK_GCE_METADATA='false', CLOUDSDK_CORE_DISABLE_PROMPTS='false',
            CLOUDSDK_CORE_DISABLE_FILE_LOGGING='true', CLOUDSDK_CORE_LOG_HTTP='false',
            CLOUDSDK_CORE_DISABLE_USAGE_REPORTING='true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true',
            CLOUDSDK_CORE_PROJECT=b.PROJECT, CLOUDSDK_PYTHON_SITEPACKAGES='0')
        runpy.run_path(str(sdk_root / 'lib/gcloud.py'), run_name='gcloud_bootstrap')
        sys.modules.pop('argparse', None)
        from googlecloudsdk import gcloud_main
        from googlecloudsdk.calliope import display
        from googlecloudsdk.core import log, properties, transports as unauthenticated_transports
        from googlecloudsdk.core.configurations import named_configs
        from googlecloudsdk.core.credentials import store as credential_store, transports
        from googlecloudsdk.core.updater import update_manager
        from googlecloudsdk.command_lib import info_holder
        from googlecloudsdk.api_lib.util import apis
        from apitools.base.py import base_api
        import google.auth
        import google.auth._default
        import httplib2
        update_manager.UpdateManager.EnsureInstalledAndRestart = forbid
        update_manager.UpdateManager.Install = forbid
        base_api.BaseApiClient._SetCredentials = forbid
        for name in ('AvailableAccounts', 'GetAccessToken', 'GetAccessTokenIfEnabled',
                     'GetFreshAccessToken', 'GetFreshAccessTokenIfEnabled', 'LoadFreshCredential',
                     'LoadIfEnabled', 'Load', 'Refresh', 'RefreshIfExpireWithinWindow', 'RefreshIfAlmostExpire'):
            setattr(credential_store, name, forbid)
        google.auth.default = forbid
        google.auth._default.default = forbid
        apis.GetGapicClientInstance = forbid
        info_holder.ToolsInfo._GetVersion = lambda self, command: 'OFFLINE SDK TEST'
        subprocess.Popen = forbid
        subprocess.run = forbid
        fixture = Fake().provider
        provider_path = '/v1/' + b.PROVIDER_NAME
        project_id_path = provider_path.replace('/' + b.NUMBER + '/', '/' + b.PROJECT + '/')
        operation_path = provider_path + '/operations/synthetic-operation'

        class HTTP:
            def __init__(self, fail_patch=None, fail_once=False):
                self.calls = []
                self.current = copy.deepcopy(fixture)
                self.fail_patch = fail_patch
                self.fail_once = fail_once
                self.connections = {}
            def request(self, uri, method='GET', body=None, headers=None, **kwargs):
                parsed = urlsplit(uri)
                assert parsed.scheme == 'https' and parsed.netloc == 'iam.googleapis.com', uri
                payload = json.loads(body) if body else None
                self.calls.append((method, parsed.path, parse_qs(parsed.query), payload))
                if method == 'GET' and parsed.path in (provider_path, project_id_path):
                    result = self.current
                elif method == 'PATCH' and parsed.path in (provider_path, project_id_path):
                    assert parse_qs(parsed.query).get('updateMask') == ['attributeCondition'], self.calls[-1]
                    # SDK serializes the default disabled=false, but its update
                    # mask excludes disabled. Only attributeCondition is applied.
                    assert payload == {'disabled': False,
                                       'attributeCondition': m.new_condition(NEW_SHA)}, self.calls[-1]
                    self.current['attributeCondition'] = m.new_condition(NEW_SHA)
                    if self.fail_patch:
                        code = self.fail_patch
                        if self.fail_once: self.fail_patch = None
                        return httplib2.Response({'status': str(code), 'content-type': 'application/json'}), json.dumps(
                            {'error': {'code': code, 'message': 'synthetic response',
                                       'status': 'UNAVAILABLE' if code == 503 else 'PERMISSION_DENIED'}}).encode()
                    result = {'name': operation_path.removeprefix('/v1/'), 'done': True, 'response': self.current}
                elif method == 'GET' and parsed.path == operation_path:
                    result = {'name': operation_path.removeprefix('/v1/'), 'done': True, 'response': self.current}
                else:
                    raise UnsafeAction('Unexpected HTTP ' + method + ' ' + uri)
                return httplib2.Response({'status': '200', 'content-type': 'application/json'}), json.dumps(result).encode()

        def run(http):
            args = m.update_args(NEW_SHA) + ['--verbosity=error', '--billing-project=' + b.PROJECT,
                                            '--project=' + b.PROJECT, '--format=json']
            cli = gcloud_main.CreateCLI([])
            named_configs.FLAG_OVERRIDE_STACK.PushFromArgs(args)
            properties.VALUES.PushInvocationValues()
            try:
                parsed = cli.top_element._parser.parse_args(args)
                if parsed.CONCEPT_ARGS is not None: parsed.CONCEPT_ARGS.ParseConcepts()
                assert not parsed.IsSpecified('attribute_mapping')
                assert not parsed.IsSpecified('disabled')
                assert not parsed.IsSpecified('issuer_uri')
                assert properties.VALUES.core.disable_prompts.GetBool() is False
                command = parsed._GetCommand()
                instance = command._common_type(cli=cli, context={})
                output = io.StringIO()
                with patch.object(transports, 'GetApitoolsTransport', return_value=http), \
                     patch.object(unauthenticated_transports, 'GetApitoolsTransport', return_value=http), \
                     patch.object(log, 'out', output), patch.object(log.status, 'Print'), \
                     patch.object(sys, 'stdin', io.StringIO('n\n' * 100)), contextlib.redirect_stderr(io.StringIO()):
                    result = instance.Run(parsed)
                    display.Displayer(instance, parsed, result, display_info=command.ai.display_info).Display()
                return output.getvalue()
            finally:
                properties.VALUES.PopInvocationValues()
                named_configs.FLAG_OVERRIDE_STACK.Pop()

        http = HTTP(); run(http)
        assert sum(method == 'PATCH' for method, *_ in http.calls) == 1
        expected = copy.deepcopy(fixture); expected['attributeCondition'] = m.new_condition(NEW_SHA)
        assert http.current == expected
        denied = HTTP(fail_patch=403)
        try:
            run(denied)
            raise AssertionError('Permission denial must stop')
        except Exception as error:
            assert not isinstance(error, AssertionError), error
        assert sum(method == 'PATCH' for method, *_ in denied.calls) == 1
        # Document the real stock SDK retry boundary, rather than claim the
        # helper's one command prevents transport-level retransmission.
        transient = HTTP(fail_patch=503, fail_once=True)
        import time
        with patch.object(time, 'sleep'):
            run(transient)
        patches = [call for call in transient.calls if call[0] == 'PATCH']
        assert len(patches) == 2 and patches[0] == patches[1]
        print(json.dumps({'sdk': sdk_version, 'offline': True, 'cases': 3,
                          'stock_sdk_transient_patch_retries_observed': 1,
                          'update_mask': 'attributeCondition', 'other_writes': 0,
                          'live_credential_or_cloud_calls': 0}))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--sdk-root':
        verify_sdk(Path(sys.argv[2]))
    else:
        unittest.main()
