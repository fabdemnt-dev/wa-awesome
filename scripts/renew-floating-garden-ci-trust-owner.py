#!/usr/bin/env python3
"""Owner-operated run-3 trust renewal, not setup or release. Default: offline plan.

The owner must separately approve the reviewed new commit and this exact trust
change. --renew requires a TTY and a fresh hash-bound approval; no --yes/resume.
--audit performs only a complete read-only baseline check; it cannot renew.
Only the existing provider's attributeCondition may be written by --renew. The original
setup module is a hash-pinned read/validation dependency; its setup never runs.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

BASE_SHA256 = '8a4c2a4a4fc2725b19ec2159766559bed120e11e9c8605933661b11dddef77b5'
OLD_SHA = '74027567a8761e78423c8df0e744abc8d5633a8b'
NEW_RUN = '3'
REVIEWED_OWNER_SDKS = ('568.0.0', '587.0.0')


def load_base():
    path = Path(__file__).resolve().with_name('setup-floating-garden-ci-owner.py')
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != BASE_SHA256:
        raise ValueError('setup_dependency_checksum_mismatch')
    # Execute the same bytes that were checked, without a second filesystem read.
    spec = importlib.util.spec_from_file_location('garden_renewal_readonly_base', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module


base = load_base()
need, Stop, digest, packed = base.need, base.Stop, base.digest, base.packed
OLD_CONDITION = base.release_condition(OLD_SHA, '2')


def new_condition(sha, run_number=NEW_RUN):
    need(isinstance(sha, str) and re.fullmatch(r'[a-f0-9]{40}', sha) and sha != OLD_SHA,
         'reviewed_new_release_commit_required')
    need(run_number == NEW_RUN, 'reviewed_run_3_required')
    return base.ATTRIBUTE_CONDITION + f" && assertion.workflow_sha == '{sha}' && assertion.run_number == '3'"


def update_args(sha):
    return ['iam', 'workload-identity-pools', 'providers', 'update-oidc', base.PROVIDER,
            '--location=global', '--workload-identity-pool=' + base.POOL,
            '--attribute-condition=' + new_condition(sha)]


def read_allowed(args, stage):
    """Finite metadata-only command surface, separate from the renewal writer.

    The hash-pinned collector selects identities from this fixed project. Even
    a mislabeled write=False mutation, extra flag, or future collector command
    is rejected here before a process can start.
    """
    fixed = {
        'gcloud_version': [['version']],
        'gcloud_config': [['config', 'list']],
        'owner_identity': [['auth', 'list', '--filter=status:ACTIVE']],
        'project_identity': [['projects', 'describe', base.PROJECT]],
        'enabled_apis': [['services', 'list', '--enabled', '--limit=1000']],
        'function_metadata': [base.function_inventory_args()],
        'function_policy': [['functions', 'get-iam-policy', name, '--region=' + base.REGION]
                            for name in base.FUNCTIONS],
        'source_bucket_owner': [['storage', 'buckets', 'describe', 'gs://' + base.BUCKET,
                                 '--raw', '--format=json(name,projectNumber)']],
        'source_bucket_policy': [['storage', 'buckets', 'get-iam-policy', 'gs://' + base.BUCKET]],
        'project_policy': [base.policy_command('project', 'get-iam-policy')],
        'secret_policy': [base.policy_command('secret', 'get-iam-policy')],
        'project_ancestors': [['projects', 'get-ancestors', base.PROJECT]],
        'account_inventory': [['iam', 'service-accounts', 'list', '--limit=1000']],
        'deployer_keys': [['iam', 'service-accounts', 'keys', 'list', '--iam-account=' + base.DEPLOYER,
                           '--managed-by=user', '--limit=1000']],
        'custom_role_inventory': [['iam', 'roles', 'list', '--show-deleted', '--limit=1000']],
        'pool_inventory': [['iam', 'workload-identity-pools', 'list', '--location=global',
                            '--show-deleted', '--limit=1000']],
        'pool_policy': [base.policy_command('pool', 'get-iam-policy')],
        'provider_inventory': [['iam', 'workload-identity-pools', 'providers', 'list', '--location=global',
                                '--workload-identity-pool=' + base.POOL, '--show-deleted', '--limit=1000']],
        'provider_metadata': [['iam', 'workload-identity-pools', 'providers', 'describe', base.PROVIDER,
                               '--location=global', '--workload-identity-pool=' + base.POOL]],
    }
    for version in ('1', 'latest'):
        fixed['hmac_' + version + '_metadata'] = [['secrets', 'versions', 'describe', version,
            '--secret=' + base.SECRET, '--format=json(name,state)']]
    if stage in fixed:
        return args in fixed[stage]
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        return False
    if stage == 'ancestor_policy':
        return ((len(args) == 4 and args[:3] == ['resource-manager', 'folders', 'get-iam-policy']) or
                (len(args) == 3 and args[:2] == ['organizations', 'get-iam-policy'])) and bool(re.fullmatch(r'[0-9]+', args[-1]))
    if stage in ('account_metadata', 'account_policy'):
        verb = 'describe' if stage == 'account_metadata' else 'get-iam-policy'
        return (len(args) == 4 and args[:3] == ['iam', 'service-accounts', verb] and
                bool(re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]@' + re.escape(base.PROJECT) + r'\.iam\.gserviceaccount\.com', args[3]) or
                     args[3] in (base.APPSPOT, base.NUMBER + '-compute@developer.gserviceaccount.com',
                                 base.NUMBER + '@cloudbuild.gserviceaccount.com')))
    if stage == 'role_metadata':
        return (len(args) in (4, 5) and args[:3] == ['iam', 'roles', 'describe'] and
                bool(re.fullmatch(r'(?:roles/)?[A-Za-z0-9_.]+', args[3])) and
                (len(args) == 4 or (not args[3].startswith('roles/') and
                                   re.fullmatch(r'--organization=[0-9]+', args[4]) is not None)))
    return False


class ReadOnlyGcloud(base.Gcloud):
    """Audit has no writer, even if approved is set or write=False is misused."""
    def __init__(self):
        super().__init__(OLD_SHA, '2')

    def __call__(self, args, stage, write=False):
        need(not write and read_allowed(args, stage), 'read_only_command_required')
        return super().__call__(args, stage, write=False)


class RenewalGcloud(ReadOnlyGcloud):
    """One narrowly allowlisted helper mutation; no setup, retry or rollback.

    Stock SDK HTTP transport retries are independent of helper command retries.
    Even the approved update uses the continuous NO prompt guard, not --quiet,
    so an unexpected SDK API-enablement prompt cannot approve a second change.
    """
    def __init__(self, sha):
        self.new_sha = sha
        new_condition(sha)
        super().__init__()
        self.mutation_attempts = 0

    def __call__(self, args, stage, write=False):
        if write:
            need(self.approved and stage == 'renew_provider_condition' and args == update_args(self.new_sha),
                 'mutation_outside_approved_condition')
            need(self.mutation_attempts == 0, 'mutation_retry_forbidden')
            self.mutation_attempts += 1
        # The shared boundary supplies fixed project/billing/JSON flags,
        # redacted diagnostics, timeouts and NO to unexpected SDK prompts.
        if write:
            return base.Gcloud.__call__(self, args, stage, write=False)
        return super().__call__(args, stage, write=False)


def strict_federation(s, sha):
    p, pool = s.get('provider'), s.get('pool')
    need(isinstance(pool, dict) and set(pool) <= {'name', 'state', 'disabled', 'displayName', 'description'} and
         pool.get('name') == base.POOL_NAME and pool.get('state') == 'ACTIVE' and
         pool.get('disabled', False) is False and pool.get('displayName') == 'Garden GitHub' and
         pool.get('description', '') == '', 'unexpected_pool_settings')
    need(isinstance(p, dict) and set(p) <= {'name', 'state', 'disabled', 'displayName', 'description',
         'attributeCondition', 'attributeMapping', 'oidc'} and p.get('name') == base.PROVIDER_NAME and
         p.get('state') == 'ACTIVE' and p.get('disabled', False) is False and
         p.get('displayName', '') == '' and p.get('description', '') == '' and
         p.get('attributeMapping') == base.MAPPING, 'unexpected_provider_settings')
    oidc = p.get('oidc')
    need(isinstance(oidc, dict) and set(oidc) <= {'issuerUri', 'allowedAudiences', 'jwksJson'} and
         oidc.get('issuerUri') == 'https://token.actions.githubusercontent.com' and
         oidc.get('allowedAudiences', []) == [] and oidc.get('jwksJson', '') == '', 'unexpected_oidc_settings')
    cond = p.get('attributeCondition')
    need(cond in (OLD_CONDITION, new_condition(sha)), 'unexpected_provider_condition')
    return 'intended' if cond == new_condition(sha) else 'original'


def validate_snapshot(s, sha):
    status = strict_federation(s, sha)
    # The original validator understands the old run-2 pin. Validate everything
    # else against the same hard constraints without changing the live snapshot.
    validation = copy.deepcopy(s)
    validation['provider']['attributeCondition'] = OLD_CONDITION
    expected = base.validate_state(validation)
    need(set(base.APIS) <= set(s['services']) and set(s['custom']) == set(base.CUSTOM) and
         base.DEPLOYER in s['accounts'], 'existing_setup_incomplete')
    need(all((r, packed(c), member) in base.policy_atoms(s['policies'].get(target, {}))
             for target, r, member, c in expected), 'original_expiry_bindings_missing')
    return status


def collect(run, sha):
    snapshot = base.collect(run, include_permission_catalog=False)
    validate_snapshot(snapshot, sha)
    return snapshot


def make_plan(snapshot, sha):
    status = validate_snapshot(snapshot, sha)
    return {'kind': 'garden-run-3-trust-renewal-v1', 'project': base.PROJECT,
            'number': base.NUMBER, 'provider': base.PROVIDER_NAME,
            'original_expiry': base.EXPIRY, 'deadline': base.DEADLINE,
            'from_condition': snapshot['provider']['attributeCondition'],
            'to_condition': new_condition(sha), 'new_release_sha': sha, 'new_run_number': NEW_RUN,
            'snapshot_sha256': digest(snapshot), 'cloud_writes': 0 if status == 'intended' else 1}


class State:
    """Private immutable snapshots plus durable redacted status. Never overwrite history."""
    def __init__(self, path):
        path = Path(path).expanduser().absolute()
        need(path == path.resolve() and path.parent.is_dir(), 'state_path')
        try:
            path.mkdir(mode=0o700)
        except OSError:
            raise Stop('fresh_private_state_directory_required') from None
        self.path = path
        self.data = {'kind': 'garden-run-3-trust-renewal-v1', 'project': base.PROJECT,
                     'original_expiry': base.EXPIRY, 'stage': 'initial_read',
                     'mutation_attempts': 0, 'possibly_applied': False,
                     'trust_metadata_verified': False, 'release_ready': False}
        self.save()

    def check_dir(self):
        info = self.path.lstat()
        need(stat.S_ISDIR(info.st_mode) and self.path == self.path.resolve() and
             stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid(), 'state_directory_changed')

    def save_file(self, name, value):
        self.check_dir()
        fd = os.open(self.path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, sort_keys=True, indent=2)
            output.write('\n'); output.flush(); os.fsync(output.fileno())
        directory = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def save(self):
        self.check_dir()
        # Append-only redacted journal prevents a crash from truncating the
        # previously durable uncertainty marker or overwriting any backup.
        index = len(list(self.path.glob('status-*.json')))
        self.save_file(f'status-{index:04d}.json', self.data)


def check_sdk(run):
    version = run(['version'], 'gcloud_version')
    need(isinstance(version, dict) and version.get('Google Cloud SDK') in REVIEWED_OWNER_SDKS,
         'reviewed_owner_sdk_required')
    return version['Google Cloud SDK']


def audit(run, sha, *, emit=print, now=lambda: time.time() * 1000):
    """Read-only full baseline validation, never a plan, journal, or writer.

    Only bounded fixed labels and digests leave memory. The owner account,
    policies and raw snapshots are not printed or saved. Two complete matching
    reads detect intervening drift, but cannot guarantee future immutability.
    """
    try:
        new_condition(sha)
        need(now() < base.EXPIRY, 'original_deadline_expired')
        sdk = check_sdk(run)
        before = collect(run, sha)
        need(collect(run, sha) == before, 'state_changed_during_audit')
        need(now() < base.EXPIRY, 'original_deadline_expired')
        emit(json.dumps({'result': 'TRUST_AUDIT_VERIFIED', 'mode': 'read-only-audit',
                         'project': base.PROJECT, 'number': base.NUMBER, 'owner_sdk': sdk,
                         'original_expiry': base.EXPIRY, 'deadline': base.DEADLINE,
                         'condition_state': validate_snapshot(before, sha),
                         'snapshot_sha256': digest(before), 'complete_matching_reads': 2,
                         'cloud_writes': 0, 'release_ready': False}, sort_keys=True))
        return 0
    except (Stop, EOFError, KeyboardInterrupt, AttributeError, KeyError, TypeError, ValueError, OSError) as error:
        stage = error.stage if isinstance(error, Stop) else 'metadata_or_local_state_error'
        emit('TRUST_AUDIT_STOP stage=' + stage + ' cloud_writes=0 release_ready=false.')
        return 2
    finally:
        run.approved = False


def execute(run, state, sha, *, confirm=input, emit=print, now=lambda: time.time() * 1000):
    try:
        new_condition(sha)
        need(now() < base.EXPIRY, 'original_deadline_expired')
        check_sdk(run)
        before = collect(run, sha)
        plan = make_plan(before, sha)
        token = digest(plan)
        emit(json.dumps(plan, indent=2))
        emit('Only workflow_sha and run_number change. All other claims, mapping, issuer, accounts, IAM and original expiry stay unchanged. No release, credentials or setup are included.')
        if not plan['cloud_writes']:
            # Re-read the complete state even for a no-op. An arbitrary other
            # SHA/run does not enter this path; it was rejected above.
            need(collect(run, sha) == before, 'state_changed_during_noop')
            need(now() < base.EXPIRY, 'original_deadline_expired')
            state.data.update(stage='already_exact_intended_state', trust_metadata_verified=True)
            state.save()
            emit('TRUST_ALREADY_EXACT cloud_writes=0 release_ready=false.')
            return 0
        state.data.update(stage='owner_confirmation', plan_sha256=token)
        state.save()
        emit('Owner: ensure no concurrent provider/IAM edits. This API has no compare-and-swap precondition. Stock gcloud may retry an HTTP request internally; this helper never retries a mutation command. Keep the private backup on this computer.')
        phrase = 'RENEW ' + token
        started = now()
        need(confirm('Type exactly ' + phrase + ': ') == phrase, 'owner_confirmation_declined')
        need(now() < base.EXPIRY and now() - started <= 300000, 'owner_confirmation_expired')
        state.save_file('before.json', before)
        state.save_file('plan.json', plan)
        # Fresh reads finish at provider describe, immediately before the write.
        fresh = collect(run, sha)
        need(fresh == before and digest(make_plan(fresh, sha)) == token, 'state_changed_confirm_again')
        need(now() < base.EXPIRY and now() - started <= 300000, 'owner_confirmation_expired')
        state.data.update(stage='renew_provider_condition', mutation_attempts=1, possibly_applied=True)
        state.save()  # Durable uncertainty marker BEFORE dispatch.
        run.approved = True
        run(update_args(sha), 'renew_provider_condition', write=True)
        run.approved = False
        after = collect(run, sha)
        expected = copy.deepcopy(before)
        expected['provider']['attributeCondition'] = new_condition(sha)
        need(after == expected, 'exact_readback_not_observed')
        state.save_file('after.json', after)
        need(now() < base.EXPIRY, 'original_deadline_expired')
        state.data.update(stage='trust_metadata_verified', possibly_applied=False, trust_metadata_verified=True)
        state.save()
        emit('TRUST_METADATA_VERIFIED mutation_commands=1 release_ready=false. Exact provider and inspected IAM readback passed. This does not prove token exchange, deployment or Garden readiness.')
        return 0
    except (Stop, EOFError, KeyboardInterrupt, AttributeError, KeyError, TypeError, ValueError, OSError) as error:
        stage = error.stage if isinstance(error, Stop) else ('owner_interrupted' if isinstance(error, (EOFError, KeyboardInterrupt)) else 'metadata_or_local_state_error')
        state.data.update(stage=stage, trust_metadata_verified=False,
                          possibly_applied=state.data['mutation_attempts'] > 0,
                          provider_code=error.code if isinstance(error, Stop) else 'UNKNOWN',
                          local_code=error.local_code if isinstance(error, Stop) else 'UNKNOWN')
        try:
            state.save()
        except (OSError, Stop):
            emit('TRUST_STATE_SAVE_FAILED. Keep the existing private journal; cloud outcome may be unknown.')
        emit(f"TRUST_RENEWAL_STOP stage={stage} mutation_commands={state.data['mutation_attempts']} possibly_applied={str(state.data['possibly_applied']).lower()}. No automatic helper retry or rollback. Reconcile live state before any further action.")
        return 2
    finally:
        run.approved = False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--plan', action='store_true')
    modes.add_argument('--renew', action='store_true')
    modes.add_argument('--audit', action='store_true')
    parser.add_argument('--project')
    parser.add_argument('--project-number')
    parser.add_argument('--original-expiry', type=int)
    parser.add_argument('--approved-release-sha')
    parser.add_argument('--approved-release-run-number')
    parser.add_argument('--state-dir')
    args = parser.parse_args(argv)
    try:
        if not args.renew and not args.audit:
            sha = args.approved_release_sha
            condition = new_condition(sha, args.approved_release_run_number or NEW_RUN) if sha else '<requires reviewed NEW 40-hex commit; run 3 only>'
            need(args.approved_release_run_number in (None, NEW_RUN), 'reviewed_run_3_required')
            print(json.dumps({'mode': 'offline-plan', 'cloud_calls': 0, 'provider': base.PROVIDER_NAME,
                              'original_expiry': base.EXPIRY, 'deadline': base.DEADLINE,
                              'old_condition': OLD_CONDITION, 'new_condition': condition,
                              'only_write_field': 'attributeCondition', 'setup_dependency_sha256': BASE_SHA256,
                              'source_commit_verification': 'Owner must verify both scripts from the reviewed new commit; no new commit SHA is known by this template.',
                              'next': 'Separately authorized owner uses --renew with exact fixed scope and reviews the live hash-bound plan.'}, indent=2))
            return 0
        need(args.project == base.PROJECT and args.project_number == base.NUMBER and
             args.original_expiry == base.EXPIRY, 'explicit_fixed_scope_required')
        new_condition(args.approved_release_sha, args.approved_release_run_number)
        need(time.time() * 1000 < base.EXPIRY, 'original_deadline_expired')
        if args.audit:
            need(args.state_dir is None, 'audit_has_no_state_directory')
            return audit(ReadOnlyGcloud(), args.approved_release_sha)
        need(args.state_dir and sys.stdin.isatty(),
             'explicit_fixed_scope_and_interactive_owner_required')
        new_condition(args.approved_release_sha, args.approved_release_run_number)
        need(time.time() * 1000 < base.EXPIRY, 'original_deadline_expired')
        run = RenewalGcloud(args.approved_release_sha)
        return execute(run, State(args.state_dir), args.approved_release_sha)
    except (Stop, OSError, ValueError) as error:
        stage = error.stage if isinstance(error, Stop) else 'local_state_unavailable'
        print(('TRUST_AUDIT_STOP' if args.audit else 'TRUST_RENEWAL_STOP') + ' stage=' + stage)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
