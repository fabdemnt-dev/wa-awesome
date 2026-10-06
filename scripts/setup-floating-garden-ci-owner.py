#!/usr/bin/env python3
"""Finite owner-operated WIF setup; default is offline. Never deploys the garden.

Local review: python3 scripts/setup-floating-garden-ci-owner.py --plan
Owner execution (requires fresh authorization outside this helper):
  python3 scripts/setup-floating-garden-ci-owner.py --setup \
    --project wa-awesome-garden-stg --project-number 120030709276 \
    --original-expiry 1791762351472 --approved-release-sha REVIEWED_40_HEX_COMMIT --approved-release-run-number EXPECTED_NEXT_RUN --state-dir "$HOME/garden-ci-owner-setup-20261006"
A retry uses the SAME --state-dir and --resume; it always reads afresh and asks
for the new plan hash. No --yes, credentials, login, installs, key generation,
secret payload access, billing change, deployment or application-data writes.
"""
import argparse
import contextlib
import threading
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

PROJECT, NUMBER, REGION = 'wa-awesome-garden-stg', '120030709276', 'asia-northeast1'
EXPIRY, DEADLINE = 1791762351472, '2026-10-11T23:45:51.472Z'
DEPLOYER = f'garden-github-deployer@{PROJECT}.iam.gserviceaccount.com'
RUNTIME = f'garden-trial-runtime@{PROJECT}.iam.gserviceaccount.com'
APPSPOT = f'{PROJECT}@appspot.gserviceaccount.com'
SECRET = 'FLOATING_GARDEN_INVITE_HMAC_KEY'
BUCKET = f'gcf-v2-sources-{NUMBER}-{REGION}'
POOL, PROVIDER = 'garden-github', 'wa-awesome-release'
POOL_NAME = f'projects/{NUMBER}/locations/global/workloadIdentityPools/{POOL}'
PROVIDER_NAME = f'{POOL_NAME}/providers/{PROVIDER}'
PRINCIPAL = f'principalSet://iam.googleapis.com/{POOL_NAME}/attribute.repository_id/1321198654'
MEMBER = f'serviceAccount:{DEPLOYER}'
REF = 'refs/heads/release/garden-trial'
WORKFLOW = f'fabdemnt-dev/wa-awesome/.github/workflows/deploy-floating-garden-trial.yml@{REF}'
FUNCTIONS = ('floatingGardenCreateRoom', 'floatingGardenJoinRoom', 'floatingGardenStartMatch',
             'floatingGardenGetSnapshot', 'floatingGardenSubmitAction')
APIS = ('iam.googleapis.com', 'cloudresourcemanager.googleapis.com',
        'iamcredentials.googleapis.com', 'sts.googleapis.com')
PROJECT_ROLES = ('roles/cloudfunctions.developer', 'roles/firebasehosting.admin',
                 'roles/firebaserules.admin', 'roles/serviceusage.serviceUsageConsumer',
                 'roles/serviceusage.apiKeysViewer')
CUSTOM = {
    'gardenCiMetadataRead': ('resourcemanager.projects.getIamPolicy', 'cloudfunctions.functions.getIamPolicy',
        'firebaseauth.configs.get', 'firebaseappcheck.recaptchaEnterpriseConfig.get', 'firebaseappcheck.services.get',
        'firebaseextensions.instances.list'),
    'gardenCiSourceRead': ('storage.buckets.get', 'storage.objects.get'),
    'gardenCiGateUpdate': ('datastore.databases.getMetadata', 'datastore.databases.get',
        'datastore.entities.get', 'datastore.entities.list', 'datastore.entities.update'),
}
COMMAND_TIMEOUT_SECONDS = 60
PERMISSION_CATALOG_TIMEOUT_SECONDS = 600
PERMISSION_CATALOG_LIMIT = 50000
PERMISSION_PROGRESS_SECONDS = 30
MAPPING = {'google.subject': 'assertion.sub', **{f'attribute.{k}': f'assertion.{k}' for k in
    ('repository_id', 'repository_owner_id', 'ref', 'workflow_ref', 'event_name', 'environment')}}
ATTRIBUTE_CONDITION = ' && '.join(f"assertion.{k} == '{v}'" for k, v in (
    ('repository_id', '1321198654'), ('repository_owner_id', '312340196'),
    ('ref', REF), ('workflow_ref', WORKFLOW), ('event_name', 'push'), ('environment', 'garden-trial'),
    ('run_attempt', '1')))
TIME_CONDITION = f"request.time < timestamp('{DEADLINE}')"
SOURCE_CONDITION = TIME_CONDITION + f" && (resource.name == 'projects/_/buckets/{BUCKET}' || resource.name.startsWith('projects/_/buckets/{BUCKET}/objects/'))"
GATE_CONDITION = TIME_CONDITION + f" && resource.name == 'projects/{PROJECT}/databases/(default)'"
DISCLOSURES = [
    'SETUP ONLY. This does not release or prove the garden is ready.',
    'Project predefined roles permit broad Garden product create/delete; these are NOT permissions limited to five functions.',
    'roles/serviceusage.apiKeysViewer permits API key STRING retrieval. The helper itself never retrieves key strings.',
    'Gate role permits database-wide existing-document updates in (default), NOT only three gate documents; no entity create/delete permission.',
    'Source role reads the verified source bucket and every object below its prefix.',
    'actAs on each listed existing runtime/build/appspot account permits acting with that account’s inspected roles.',
    'Actual build accounts can already hold Editor or other broad roles. actAs permits indirect use of those privileges; no such role is added or removed.',
    'Inspected policies are this project and visible ancestors/resources. Other existing grants to an actAs account elsewhere are not globally inventoried.',
    'The future release job must declare GitHub environment garden-trial. Its existence/protection is not verified or changed here.',
    'All new IAM bindings expire at the ORIGINAL deadline; the deadline is never extended.',
    'New pool/provider stay disabled until verification; no automatic rollback, repair, undelete or destructive cleanup.',
    'Metadata verification does not prove IAM permission enforcement. Future CI must wait and recheck actual keyless access.',
    'Two full IAM permission-catalog scans protect the initial plan and post-confirmation plan. Each has a 10-minute limit and 30-second progress reports; 20 minutes is their combined upper bound, not an estimate or a total setup limit.',
    'After writes, verification reads the exact custom roles, IAM policies and federation settings rather than scanning the permission catalog again; no timed-out command is retried automatically.',
    'A new deployer account gets a 60-second propagation pause, then bounded read-only readiness checks; mutations are never blindly retried.',
    'Firebase Admin 12.7 WIF compatibility fix is a separate release change. Firebase CLI generateServiceIdentity compatibility remains unverified.',
]
# Appspot is an extra impersonation surface. Unknown roles, custom roles, broad
# basic roles and powerful administrative roles fail closed before any write.
APPSPOT_ALLOWED_ROLES = {'roles/logging.logWriter', 'roles/monitoring.metricWriter',
                         'roles/cloudtrace.agent', 'roles/datastore.user'}


def release_condition(release_sha, release_run_number):
    need(isinstance(release_sha, str) and re.fullmatch(r'[a-f0-9]{40}', release_sha), 'reviewed_release_commit_required')
    need(isinstance(release_run_number, str) and re.fullmatch(r'[1-9][0-9]{0,8}', release_run_number), 'reviewed_release_run_required')
    return ATTRIBUTE_CONDITION + " && assertion.workflow_sha == '" + release_sha + "' && assertion.run_number == '" + release_run_number + "'"


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


PROVIDER_CODES = {'PERMISSION_DENIED', 'UNAUTHENTICATED', 'NOT_FOUND', 'ALREADY_EXISTS',
                  'INVALID_ARGUMENT', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE'}


LOCAL_CODES = {'UNKNOWN', 'CLI_ARGUMENT', 'CLI_FORMAT', 'CLI_MISSING', 'CLI_START_FAILED', 'CLI_TIMEOUT', 'CLI_EXIT_NONZERO', 'NON_JSON_RESPONSE'}


class Stop(Exception):
    def __init__(self, stage, code='UNKNOWN', local_code='UNKNOWN', exit_code=None):
        self.stage = stage
        self.code = code if code in PROVIDER_CODES else 'UNKNOWN'
        self.local_code = local_code if local_code in LOCAL_CODES else 'UNKNOWN'
        self.exit_code = exit_code if isinstance(exit_code, int) and 0 <= exit_code <= 255 else None
        super().__init__(f'{stage} provider_code={self.code}')


def need(ok, stage):
    if not ok:
        raise Stop(stage)


def bounded_list(value, stage, limit=1000):
    need(isinstance(value, list) and len(value) < limit and all(isinstance(x, dict) for x in value), stage)
    return value


def condition(expression=TIME_CONDITION):
    return {'title': 'garden-ci-original-expiry', 'description': 'Original trial deadline; do not extend',
            'expression': expression}


def role_name(role):
    return f'projects/{PROJECT}/roles/{role}'


def policy_command(target, verb):
    if target == 'project':
        return ['projects', verb, PROJECT]
    if target == 'pool':
        return ['iam', 'workload-identity-pools', verb, POOL, '--location=global']
    if target == 'secret':
        return ['secrets', verb, SECRET]
    return ['iam', 'service-accounts', verb, target]


def policy_atoms(policy):
    need(isinstance(policy, dict), 'policy_shape')
    out = set()
    for b in bounded_list(policy.get('bindings', []), 'policy_shape', 3000):
        need(isinstance(b.get('role'), str) and isinstance(b.get('members'), list) and
             all(isinstance(m, str) for m in b['members']), 'policy_shape')
        for m in b['members']:
            out.add((b['role'], packed(b.get('condition')), m))
    return out


def expected_bindings(accounts):
    bindings = [('project', r, MEMBER, condition()) for r in PROJECT_ROLES]
    for r in CUSTOM:
        expression = SOURCE_CONDITION if r == 'gardenCiSourceRead' else GATE_CONDITION if r == 'gardenCiGateUpdate' else TIME_CONDITION
        bindings.append(('project', role_name(r), MEMBER, condition(expression)))
    bindings += [('secret', 'roles/secretmanager.viewer', MEMBER, condition()),
                 (RUNTIME, 'roles/iam.serviceAccountViewer', MEMBER, condition()),
                 (DEPLOYER, 'roles/iam.workloadIdentityUser', PRINCIPAL, condition())]
    bindings += [(a, 'roles/iam.serviceAccountUser', MEMBER, condition()) for a in sorted(accounts)]
    return bindings


def permission_query_args():
    # SDK 568 uses 100 records per API page and has no --page-size/--limit.
    # --filter is client-side, so it cannot reduce the requests. Keep the full
    # count bound, but omit descriptions/titles which validation never uses.
    return ['iam', 'list-testable-permissions',
            f'//cloudresourcemanager.googleapis.com/projects/{PROJECT}',
            '--format=json(name,customRolesSupportLevel,onlyInPredefinedRoles,apiDisabled)']


def function_inventory_args():
    return ['functions', 'list', '--v2', f'--regions={REGION}', '--limit=1000',
            '--format=json(name,environment,state,buildConfig.serviceAccount,buildConfig.source,serviceConfig.serviceAccountEmail)']


def validate_function_inventory_diagnostics(stderr):
    # SDK568 flattens ListFunctionsResponse and emits unreachable only as a
    # warning. An otherwise plausible five-function list is not complete
    # evidence when that warning is present. Never expose raw diagnostics.
    need(len(stderr) <= 262144, 'function_inventory_diagnostics_size')
    text = stderr.decode('utf-8', 'replace')
    need(not re.search(r'The following regions were fully or partially unreachable\s+for query:', text),
         'function_inventory_incomplete')


def permission_support(run):
    records = bounded_list(run(permission_query_args(), 'custom_permission_support'),
                           'custom_permission_support', PERMISSION_CATALOG_LIMIT)
    needed = {p for ps in CUSTOM.values() for p in ps}
    found, seen = {}, set()
    for record in records:
        name = record.get('name')
        need(isinstance(name, str) and name and name not in seen, 'custom_permission_catalog_identity')
        seen.add(name)
        if name not in needed:
            continue
        support = record.get('customRolesSupportLevel', 'SUPPORTED')
        only_predefined, disabled = record.get('onlyInPredefinedRoles', False), record.get('apiDisabled', False)
        need(support in ('SUPPORTED', 'TESTING', 'NOT_SUPPORTED') and
             type(only_predefined) is bool and type(disabled) is bool, 'custom_permission_record_shape')
        found[name] = {'name': name, 'customRolesSupportLevel': support,
                       'onlyInPredefinedRoles': only_predefined, 'apiDisabled': disabled}
    # Keep every required permission's evidence fresh on every collect. Ignore
    # unrelated catalog metadata in the plan hash, never a missing target.
    return [found[name] for name in sorted(found)]


@contextlib.contextmanager
def catalog_progress(emit, phase):
    """Fixed, redacted progress only; no resource names or subprocess output."""
    done = threading.Event()
    started = time.monotonic()
    need(phase in ('preflight', 'initial_plan', 'confirmation_read'), 'catalog_read_phase')
    def report():
        while not done.wait(PERMISSION_PROGRESS_SECONDS):
            emit(f'READ_WAIT stage=custom_permission_support phase={phase} elapsed_seconds=' +
                 str(int(time.monotonic() - started)) +
                 f' timeout_seconds={PERMISSION_CATALOG_TIMEOUT_SECONDS} metadata_only=true')
    thread = threading.Thread(target=report, daemon=True)
    emit(f'READ_START stage=custom_permission_support phase={phase} timeout_seconds={PERMISSION_CATALOG_TIMEOUT_SECONDS} '
         'metadata_only=true full_catalog_scan=true')
    try:
        thread.start()
    except RuntimeError:
        raise Stop('local_progress_guard') from None
    try:
        yield
    finally:
        done.set()
        thread.join(timeout=1)
        need(not thread.is_alive(), 'local_progress_guard')


@contextlib.contextmanager
def reject_sdk_prompts():
    """A bounded kernel pipe continuously answers NO to subprocess prompts.

    EOF can select an SDK prompt's default YES. Keep the write end open for the
    entire read command, even if the producer encounters an error: an empty
    pipe then blocks until the existing command timeout instead of accepting a
    default. This never consumes or supplies the owner's own approval input.
    """
    reader, writer = os.pipe()
    def produce():
        try:
            while True:
                os.write(writer, b'n\n' * 128)
        except OSError:
            pass  # Parent retains writer until subprocess completion.
    thread = threading.Thread(target=produce, daemon=True)
    try:
        thread.start()
    except RuntimeError:
        os.close(reader); os.close(writer)
        raise Stop('local_prompt_guard') from None
    try:
        yield reader
    finally:
        os.close(reader)
        thread.join(timeout=1)
        os.close(writer)
        need(not thread.is_alive(), 'local_prompt_guard')


class Gcloud:
    """The sole process boundary. Instantiated only for explicit owner --setup.

    SDK normal read-only transport retries may occur; mutations are submitted
    once. No explicit mutation retry. stdout/stderr are private memory only.
    """
    def __init__(self, release_sha=None, release_run_number=None, emit=None):
        self.release_sha = release_sha
        self.release_run_number = release_run_number
        forbidden = ('CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
                     'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
                     'CLOUDSDK_AUTH_LOGIN_CONFIG_FILE', 'GOOGLE_APPLICATION_CREDENTIALS',
                     'CLOUDSDK_STORAGE_GS_XML_ACCESS_KEY_ID', 'CLOUDSDK_STORAGE_GS_XML_SECRET_ACCESS_KEY',
                     'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE')
        need(not any(os.environ.get(k) for k in forbidden) and
             not any(v and k.startswith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') for k, v in os.environ.items()) and
             not any(os.environ.get(k, 'false').lower() not in ('false', '0', '') for k in
                     ('CLOUDSDK_CORE_LOG_HTTP', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION')),
             'credential_or_endpoint_override')
        self.env = dict(os.environ, CLOUDSDK_CORE_DISABLE_PROMPTS='false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING='true',
                        CLOUDSDK_CORE_LOG_HTTP='false', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING='true',
                        CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true', CLOUDSDK_CORE_PROJECT=PROJECT,
                        CLOUDSDK_STORAGE_PREFERRED_API='json', CLOUDSDK_STORAGE_USE_GRPC_IF_AVAILABLE='false',
                        CLOUDSDK_FUNCTIONS_GEN2='true')
        self.approved = False
        self.calls = 0
        self.emit = emit or (lambda line: print(line, flush=True))
        self.read_phase = 'preflight'

    def __call__(self, args, stage, write=False):
        need(not write or self.approved, 'write_without_owner_confirmation')
        self.calls += 1
        need(self.calls <= 2000, 'command_budget')
        function_inventory = not write and stage == 'function_metadata' and args == function_inventory_args()
        verbosity = 'warning' if function_inventory else 'error'
        command = ['gcloud', *args, '--verbosity=' + verbosity, f'--billing-project={PROJECT}']
        global_role = args[:3] == ['iam', 'roles', 'describe'] and (args[3].startswith('roles/') or any(a.startswith('--organization=') for a in args))
        if not global_role:
            command.append(f'--project={PROJECT}')
        if not any(a.startswith('--format=') for a in args):
            command.append('--format=json')
        # --quiet is applied only after the explicit, hash-bound owner prompt.
        if write:
            command.append('--quiet')
        catalog = not write and stage == 'custom_permission_support' and args == permission_query_args()
        timeout = PERMISSION_CATALOG_TIMEOUT_SECONDS if catalog else COMMAND_TIMEOUT_SECONDS
        # There is no global --no-quiet argument. The explicit false prompt
        # environment override plus a continuous NO stream protects reads.
        try:
            guard = contextlib.nullcontext(subprocess.DEVNULL) if write else reject_sdk_prompts()
            progress = catalog_progress(self.emit, self.read_phase) if catalog else contextlib.nullcontext()
            with progress, guard as input_fd:
                p = subprocess.run(command, env=self.env, stdin=input_fd,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        except FileNotFoundError:
            raise Stop(stage, local_code='CLI_MISSING') from None
        except subprocess.TimeoutExpired:
            raise Stop(stage, local_code='CLI_TIMEOUT') from None
        except OSError:
            raise Stop(stage, local_code='CLI_START_FAILED') from None
        if p.returncode:
            text = p.stderr[:262144].decode('utf-8', 'replace')
            code = next((c for c in sorted(PROVIDER_CODES) if re.search(r'\b' + c + r'\b', text)), 'UNKNOWN')
            # Classify fixed SDK error phrases only. Never expose stderr, which
            # can contain account identities, resource bodies or credentials.
            if re.search(r'Unknown transform function |Format must be one of ', text):
                local = 'CLI_FORMAT'
            elif re.search(r'unrecognized arguments:|unrecognized flag|Invalid choice:', text, re.IGNORECASE):
                local = 'CLI_ARGUMENT'
            else:
                local = 'CLI_EXIT_NONZERO'
            raise Stop(stage, code, local, p.returncode)
        if function_inventory:
            validate_function_inventory_diagnostics(p.stderr)
        need(len(p.stdout) <= 8 * 1024 * 1024, 'response_size')
        try:
            return json.loads(p.stdout or b'{}')
        except (ValueError, UnicodeError):
            raise Stop(stage, local_code='NON_JSON_RESPONSE', exit_code=p.returncode) from None


def read_role(run, name):
    if name.startswith('roles/'):
        return run(['iam', 'roles', 'describe', name], 'role_metadata')
    parts = name.split('/')
    need(len(parts) == 4 and parts[0] in ('projects', 'organizations') and parts[2] == 'roles' and
         re.fullmatch(r'[A-Za-z0-9_.]+', parts[3]), 'role_identity')
    if parts[0] == 'projects':
        need(parts[1] == PROJECT, 'foreign_custom_role')
        return run(['iam', 'roles', 'describe', parts[3]], 'role_metadata')
    need(parts[1].isdigit(), 'organization_identity')
    # Organization role selection is explicit, while quota/project remains fixed.
    return run(['iam', 'roles', 'describe', parts[3], '--organization=' + parts[1]], 'role_metadata')


def source_bucket_identity(value):
    """Require ownership evidence from raw Storage API metadata, never a name guess."""
    need(isinstance(value, dict), 'source_bucket_metadata_shape')
    need(isinstance(value.get('name'), str) and value['name'], 'source_bucket_name_missing')
    need(value['name'] == BUCKET, 'source_bucket_name_mismatch')
    number = value.get('projectNumber')
    need(number is not None, 'source_bucket_owner_missing')
    need(type(number) in (int, str) and re.fullmatch(r'[1-9][0-9]*', str(number)),
         'source_bucket_owner_shape')
    need(str(number) == NUMBER, 'source_bucket_owner_mismatch')
    return {'name': value['name'], 'projectNumber': str(number)}


def collect(run, include_permission_catalog=True):
    """One bounded metadata pass. No secret access, auth/appcheck or data writes."""
    s = {'release_sha': run.release_sha, 'release_run_number': run.release_run_number}
    release_condition(s['release_sha'], s['release_run_number'])
    config = run(['config', 'list'], 'gcloud_config')
    auth, core = config.get('auth', {}), config.get('core', {})
    # Legacy Storage HMAC settings select an alternate principal/API even when
    # gcloud's active owner is correct. Do not use them or alter stored settings.
    need(not any(config.get('storage', {}).get(k) for k in ('gs_xml_access_key_id', 'gs_xml_secret_access_key')),
         'storage_auth_override')
    need(not any(auth.get(k) for k in ('credential_file_override', 'impersonate_service_account', 'access_token_file', 'access_token', 'login_config_file')) and
         not any(config.get('api_endpoint_overrides', {}).values()) and not core.get('custom_ca_certs_file') and
         all(str(section.get(k, 'false')).lower() in ('false', '0', '') for section, k in
             ((core, 'log_http'), (core, 'disable_ssl_validation'), (auth, 'disable_ssl_validation'))), 'gcloud_config_override')
    identity = bounded_list(run(['auth', 'list', '--filter=status:ACTIVE'], 'owner_identity'), 'owner_identity', 2)
    need(len(identity) == 1 and isinstance(identity[0].get('account'), str) and
         not identity[0]['account'].endswith('gserviceaccount.com'), 'owner_identity')
    s['owner_hash'] = digest(identity[0]['account'])
    s['project'] = run(['projects', 'describe', PROJECT], 'project_identity')
    need(s['project'].get('projectId') == PROJECT and str(s['project'].get('projectNumber')) == NUMBER and
         s['project'].get('lifecycleState') == 'ACTIVE', 'project_identity')
    s['services'] = sorted(x['config']['name'] for x in bounded_list(
        run(['services', 'list', '--enabled', '--limit=1000'], 'enabled_apis'), 'enabled_apis')
        if x.get('state') == 'ENABLED')
    s['functions'] = bounded_list(run(function_inventory_args(), 'function_metadata'), 'function_metadata')
    aliases = {f'projects/{p}/locations/{REGION}/functions/{n}': f'projects/{PROJECT}/locations/{REGION}/functions/{n}'
               for p in (PROJECT, NUMBER) for n in FUNCTIONS}
    need(len(s['functions']) == 5 and all(f.get('name') in aliases for f in s['functions']), 'exact_five_functions')
    for f in s['functions']:
        f['name'] = aliases[f['name']]
    need(len({f['name'] for f in s['functions']}) == 5, 'exact_five_functions')
    build = set()
    for f in s['functions']:
        need(f.get('environment') == 'GEN_2' and f.get('state') == 'ACTIVE' and
             f.get('serviceConfig', {}).get('serviceAccountEmail') == RUNTIME, 'function_runtime')
        b = f.get('buildConfig', {})
        need(b.get('source', {}).get('storageSource', {}).get('bucket') == BUCKET, 'source_bucket_mismatch')
        v = b.get('serviceAccount', '')
        match = re.fullmatch(r'projects/([^/]+)/serviceAccounts/([^/]+)', v)
        need(match is not None and match[1] in (PROJECT, NUMBER), 'actual_build_identity_missing_or_foreign')
        email = match[2]
        need(re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]@' + re.escape(PROJECT) + r'\.iam\.gserviceaccount\.com', email)
             or email in (f'{NUMBER}-compute@developer.gserviceaccount.com', f'{NUMBER}@cloudbuild.gserviceaccount.com', APPSPOT), 'actual_build_identity_invalid')
        build.add(email)
    # The v2 inventory establishes exact GEN_2 identities. The subprocess env
    # pins the same generation, regardless of the owner's stored CLI default.
    s['function_policies'] = {name: run(['functions', 'get-iam-policy', name, f'--region={REGION}'], 'function_policy') for name in FUNCTIONS}
    s['functions'].sort(key=lambda f: f['name'])
    # The SDK's standardized bucket display omits the owning project even
    # when the API returned it. --raw preserves API fields before projection;
    # only the exact name and owner number enter helper memory/state hashing.
    s['bucket'] = source_bucket_identity(run(['storage', 'buckets', 'describe', f'gs://{BUCKET}',
        '--raw', '--format=json(name,projectNumber)'], 'source_bucket_owner'))
    for version in ('1', 'latest'):
        v = run(['secrets', 'versions', 'describe', version, '--secret=' + SECRET,
                 '--format=json(name,state)'], 'hmac_' + version + '_metadata')
        need(v.get('name') in [f'projects/{p}/secrets/{SECRET}/versions/1' for p in (PROJECT, NUMBER)] and
             v.get('state') == 'ENABLED', 'hmac_original_version')
        s['hmac_' + version] = v
    s['bucket_policy'] = run(['storage', 'buckets', 'get-iam-policy', f'gs://{BUCKET}'], 'source_bucket_policy')
    s['policies'] = {'project': run(policy_command('project', 'get-iam-policy'), 'project_policy'),
                     'secret': run(policy_command('secret', 'get-iam-policy'), 'secret_policy')}
    ancestors = bounded_list(run(['projects', 'get-ancestors', PROJECT], 'project_ancestors'), 'project_ancestors', 20)
    need(any(a.get('type') == 'project' and str(a.get('id')) in (PROJECT, NUMBER) for a in ancestors), 'project_ancestors')
    s['ancestors'] = {}
    for a in ancestors:
        if a.get('type') == 'project':
            continue
        kind, aid = a.get('type'), str(a.get('id'))
        need(kind in ('folder', 'organization') and aid.isdigit(), 'project_ancestors')
        cmd = ['resource-manager', 'folders'] if kind == 'folder' else ['organizations']
        s['ancestors'][kind + '/' + aid] = run([*cmd, 'get-iam-policy', aid], 'ancestor_policy')
    accounts = bounded_list(run(['iam', 'service-accounts', 'list', '--limit=1000'], 'account_inventory'), 'account_inventory')
    need(len({a.get('email') for a in accounts}) == len(accounts), 'account_inventory')
    by_email = {a.get('email'): a for a in accounts}
    targets = build | {RUNTIME}
    if APPSPOT in by_email:
        targets.add(APPSPOT)
    need(DEPLOYER not in targets, 'deployer_is_existing_build_account')
    s['build_accounts'] = sorted(build)
    s['act_as'] = sorted(targets)
    s['accounts'] = {}
    for email in sorted(targets | ({DEPLOYER} if DEPLOYER in by_email else set())):
        a = run(['iam', 'service-accounts', 'describe', email], 'account_metadata')
        need(a.get('email') == email and a.get('projectId') == PROJECT and a.get('uniqueId') and
             not a.get('disabled') and not a.get('deleted'), 'account_identity_or_disabled')
        s['accounts'][email] = a
        s['policies'][email] = run(policy_command(email, 'get-iam-policy'), 'account_policy')
    s['deployer_keys'] = run(['iam', 'service-accounts', 'keys', 'list', '--iam-account=' + DEPLOYER,
        '--managed-by=user', '--limit=1000'], 'deployer_keys') if DEPLOYER in by_email else []
    need(s['deployer_keys'] == [], 'existing_deployer_user_keys')
    s['policies'].setdefault(DEPLOYER, {})
    custom = bounded_list(run(['iam', 'roles', 'list', '--show-deleted', '--limit=1000'], 'custom_role_inventory'), 'custom_role_inventory')
    s['custom'] = {}
    for r in custom:
        if r.get('name') in [role_name(n) for n in CUSTOM]:
            need(not r.get('deleted'), 'deleted_custom_role')
            short = r['name'].split('/')[-1]
            s['custom'][short] = read_role(run, r['name'])
    if include_permission_catalog:
        s['permission_support'] = permission_support(run)
    all_policies = [*s['policies'].values(), *s['ancestors'].values(), s['bucket_policy'], *s['function_policies'].values()]
    relevant_roles = set(PROJECT_ROLES)
    s['account_roles'] = {a: set() for a in targets}
    for p in all_policies:
        for r, _, m in policy_atoms(p):
            need(not (m.startswith('deleted:serviceAccount:') and any(a in m for a in targets | {DEPLOYER})), 'deleted_target_account')
            if m in ['serviceAccount:' + a for a in targets]:
                email = m.split(':', 1)[1]
                s['account_roles'][email].add(r)
                relevant_roles.add(r)
            if (m == MEMBER or '/workloadIdentityPools/' + POOL in m) and p in s['ancestors'].values():
                raise Stop('inherited_target_access')
    need(len(relevant_roles) <= 64, 'account_role_inventory_limit')
    s['role_metadata'] = {r: read_role(run, r) for r in sorted(relevant_roles)}
    s['account_roles'] = {a: sorted(r) for a, r in s['account_roles'].items()}
    pools = bounded_list(run(['iam', 'workload-identity-pools', 'list', '--location=global',
        '--show-deleted', '--limit=1000'], 'pool_inventory'), 'pool_inventory')
    matches = [p for p in pools if p.get('name') == POOL_NAME]
    need(len(matches) <= 1, 'pool_collision')
    s['pool'] = matches[0] if matches else None
    s['provider'] = None
    s['policies']['pool'] = {}
    if s['pool']:
        s['policies']['pool'] = run(policy_command('pool', 'get-iam-policy'), 'pool_policy')
        need(not policy_atoms(s['policies']['pool']), 'existing_pool_policy')
        need(s['pool'].get('state') == 'ACTIVE', 'pool_deleted_or_inactive')
        providers = bounded_list(run(['iam', 'workload-identity-pools', 'providers', 'list', '--location=global',
            '--workload-identity-pool=' + POOL, '--show-deleted', '--limit=1000'], 'provider_inventory'), 'provider_inventory')
        need(len(providers) <= 1 and all(p.get('name') == PROVIDER_NAME for p in providers), 'other_pool_provider')
        if providers:
            s['provider'] = run(['iam', 'workload-identity-pools', 'providers', 'describe', PROVIDER,
                '--location=global', '--workload-identity-pool=' + POOL], 'provider_metadata')
    return s


def validate_permission_support(s):
    """Capability evidence for the exact proposed custom-role permissions."""
    supports = {p.get('name'): p for p in s['permission_support']}
    for p in [p for ps in CUSTOM.values() for p in ps]:
        v = supports.get(p)
        # SUPPORTED is the API enum's default, so protobuf may omit it. A
        # returned permission record is required; a missing record is unknown.
        need(v is not None and v.get('customRolesSupportLevel', 'SUPPORTED') == 'SUPPORTED' and
             not v.get('onlyInPredefinedRoles') and not v.get('apiDisabled'), 'unsupported_or_unknown_custom_permission:' + p)


def validate_state(s):
    """Validate actual resources/grants, independently of the advisory catalog.

    Post-write verification uses fresh role metadata and exact included
    permissions; no old catalog is copied in or represented as a fresh read.
    """
    for name, r in s['custom'].items():
        need(r.get('name') == role_name(name) and not r.get('deleted') and r.get('stage') == 'GA' and
             set(r.get('includedPermissions', [])) == set(CUSTOM[name]), 'custom_role_collision')
    for r in s['role_metadata'].values():
        need(not r.get('deleted') and r.get('stage') not in ('DISABLED', 'DEPRECATED') and
             isinstance(r.get('includedPermissions'), list) and r['includedPermissions'], 'role_metadata_unknown')
    for email, roles in s['account_roles'].items():
        for r in roles:
            # Existing actual build accounts may be broadly privileged. This
            # is displayed as indirect privilege in the exact owner plan.
            if email in s['build_accounts'] and email != APPSPOT and email != RUNTIME:
                continue
            need(r not in ('roles/owner', 'roles/editor', 'roles/iam.securityAdmin', 'roles/iam.serviceAccountAdmin',
                           'roles/iam.serviceAccountTokenCreator', 'roles/resourcemanager.projectIamAdmin'), 'broad_act_as_account')
            permissions = s['role_metadata'][r]['includedPermissions']
            need(not any(p.startswith(('iam.roles.', 'iam.serviceAccountKeys.')) or
                         p in ('resourcemanager.projects.setIamPolicy', 'iam.serviceAccounts.setIamPolicy',
                               'iam.serviceAccounts.getAccessToken', 'iam.serviceAccounts.signJwt',
                               'iam.serviceAccounts.signBlob') for p in permissions), 'powerful_act_as_account')
            if email == APPSPOT:
                need(r in APPSPOT_ALLOWED_ROLES, 'appspot_role_scope_uncertain')
    p = s['provider']
    if p:
        need(p.get('name') == PROVIDER_NAME and p.get('state') == 'ACTIVE' and p.get('oidc', {}).get('issuerUri') ==
             'https://token.actions.githubusercontent.com' and not p['oidc'].get('allowedAudiences') and
             not p['oidc'].get('jwksJson') and p.get('attributeMapping') == MAPPING and
             p.get('attributeCondition') == release_condition(s['release_sha'], s['release_run_number']), 'provider_collision')
    expected = expected_bindings(s['act_as'])
    allowed = {(target, role, packed(c), member) for target, role, member, c in expected}
    checked_policies = {**s['policies'], 'source_bucket': s['bucket_policy'],
                        **{'function:' + n: p for n, p in s['function_policies'].items()}}
    for target, policy in checked_policies.items():
        for role, cond, member in policy_atoms(policy):
            pool_member = '/workloadIdentityPools/' + POOL in member
            if member == MEMBER or pool_member or target == DEPLOYER:
                need((target, role, cond, member) in allowed, 'broader_existing_target_binding')
    return expected


def validate(s):
    validate_permission_support(s)
    return validate_state(s)


def make_plan(s):
    expected = validate(s)
    actions = []
    def add(stage, args, target=None, create=False, binding=None):
        actions.append({'stage': stage, 'args': args, 'target': target, 'create': create, 'binding': binding})
    for api in APIS:
        if api not in s['services']:
            add('enable_api', ['services', 'enable', api], api)
    if not s['pool']:
        add('create_disabled_pool', ['iam', 'workload-identity-pools', 'create', POOL, '--location=global',
            '--display-name=Garden GitHub', '--disabled'], POOL_NAME, True)
    if not s['provider']:
        add('create_disabled_provider', ['iam', 'workload-identity-pools', 'providers', 'create-oidc', PROVIDER,
            '--location=global', '--workload-identity-pool=' + POOL, '--disabled',
            '--issuer-uri=https://token.actions.githubusercontent.com',
            '--attribute-mapping=' + ','.join(k + '=' + v for k, v in MAPPING.items()),
            '--attribute-condition=' + release_condition(s['release_sha'], s['release_run_number'])], PROVIDER_NAME, True)
    if DEPLOYER not in s['accounts']:
        add('create_deployer', ['iam', 'service-accounts', 'create', 'garden-github-deployer',
            '--display-name=Garden GitHub deployer'], DEPLOYER, True)
    for name, permissions in CUSTOM.items():
        if name not in s['custom']:
            add('create_custom_role', ['iam', 'roles', 'create', name, '--title=' + name, '--stage=GA',
                '--permissions=' + ','.join(permissions)], role_name(name), True)
    for target, role, member, c in expected:
        if (role, packed(c), member) not in policy_atoms(s['policies'].get(target, {})):
            add('add_conditional_binding', [*policy_command(target, 'add-iam-policy-binding'),
                '--member=' + member, '--role=' + role, '--condition=^~^' + '~'.join(k + '=' + v for k, v in c.items())],
                target, binding=[role, packed(c), member])
    already_live = s['pool'] and not s['pool'].get('disabled', False) and s['provider'] and not s['provider'].get('disabled', False)
    need(not (actions and already_live), 'existing_federation_live_with_remaining_changes')
    if not s['provider'] or s['provider'].get('disabled', False):
        add('enable_provider_last', ['iam', 'workload-identity-pools', 'providers', 'update-oidc', PROVIDER,
            '--location=global', '--workload-identity-pool=' + POOL, '--no-disabled'], PROVIDER_NAME)
    if not s['pool'] or s['pool'].get('disabled', False):
        add('enable_pool_last', ['iam', 'workload-identity-pools', 'update', POOL, '--location=global', '--no-disabled'], POOL_NAME)
    return {'project': PROJECT, 'number': NUMBER, 'original_expiry': EXPIRY, 'deadline': DEADLINE,
            'release_sha': s['release_sha'], 'release_run_number': s['release_run_number'], 'attribute_condition': release_condition(s['release_sha'], s['release_run_number']),
            'disclosures': DISCLOSURES, 'act_as_accounts': s['act_as'], 'inspected_account_roles': s['account_roles'],
            'build_account_indirect_scope': {a: {r: {
                'permission_count': len(s['role_metadata'][r]['includedPermissions']),
                'permissions_sha256': digest(sorted(s['role_metadata'][r]['includedPermissions'])),
                'broad_basic_role': r in ('roles/editor', 'roles/owner')}
                for r in s['account_roles'][a]} for a in s['build_accounts']},
            'project_role_ids': PROJECT_ROLES, 'custom_role_permissions': CUSTOM,
            'appspot_present': APPSPOT in s['accounts'], 'actions': actions, 'metadata_hash': digest(s)}


def render_plan(plan, token):
    """Short exact grant/diff review, without raw IAM policies or giant role bodies."""
    lines = [f"PROJECT {PROJECT} ({NUMBER}); original expiry {DEADLINE} ({EXPIRY})", *DISCLOSURES]
    lines += ['WIF issuer=https://token.actions.githubusercontent.com; audience=default provider resource',
              'WIF mapping: ' + packed(MAPPING), 'WIF condition: ' + plan['attribute_condition'],
              'Binding condition title=garden-ci-original-expiry; description=Original trial deadline; do not extend',
              'TIME: ' + TIME_CONDITION, 'SOURCE: ' + SOURCE_CONDITION, 'GATE: ' + GATE_CONDITION]
    lines += [f"CUSTOM {role_name(r)}: {', '.join(p)}" for r, p in CUSTOM.items()]
    lines += [f"ACTAS {a}; inspected roles: {', '.join(plan['inspected_account_roles'][a]) or '(none)'}" for a in plan['act_as_accounts']]
    lines.append('EXACT REMAINING CHANGES:')
    if not plan['actions']:
        lines.append('None. Existing setup matches; cloud writes=0.')
    for index, action in enumerate(plan['actions'], 1):
        if action['binding']:
            role, cond, member = action['binding']
            expression = json.loads(cond)['expression']
            scope = 'SOURCE' if expression == SOURCE_CONDITION else 'GATE' if expression == GATE_CONDITION else 'TIME'
            lines.append(f"{index}. GRANT {role} to {member} on {action['target']}; condition={scope}")
        else:
            lines.append(f"{index}. {action['stage']} {action['target']}")
    lines.append('Plan SHA256: ' + token)
    return '\n'.join(lines)


class State:
    """Only a small redacted status record; no policies, identity, tokens or metadata."""
    def __init__(self, path, resume=False):
        path = Path(path).expanduser().absolute()
        need(path == path.resolve() and path.parent.is_dir(), 'state_path')
        if resume:
            need(path.is_dir() and not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o700 and
                 path.stat().st_uid == os.getuid(), 'state_directory')
        else:
            try:
                path.mkdir(mode=0o700)
            except OSError:
                raise Stop('state_directory_already_exists_use_resume') from None
        self.path = path / 'state.json'
        previous = {}
        if resume:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as f:
                st = os.fstat(f.fileno())
                need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.getuid() and
                     stat.S_IMODE(st.st_mode) == 0o600 and st.st_size < 65536, 'state_file')
                previous_bytes = f.read()
                previous = json.loads(previous_bytes)
            need(previous.get('kind') == 'garden-ci-owner-setup-v1' and previous.get('project') == PROJECT and
                 previous.get('original_expiry') == EXPIRY and type(previous.get('attempt')) is int and 1 <= previous['attempt'] < 20, 'state_identity')
            # Preserve the exact failed/partial attempt before the live state
            # file is advanced. Never overwrite an existing history record.
            archive = path / f"attempt-{previous['attempt']}-state.json"
            try:
                saved = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                saved = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(saved, 'rb') as f:
                    st = os.fstat(f.fileno())
                    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.getuid() and
                         stat.S_IMODE(st.st_mode) == 0o600 and st.st_size < 65536 and f.read() == previous_bytes, 'state_history_conflict')
            else:
                with os.fdopen(saved, 'wb') as f:
                    f.write(previous_bytes); f.flush(); os.fsync(f.fileno())
        self.data = {'kind': 'garden-ci-owner-setup-v1', 'project': PROJECT, 'original_expiry': EXPIRY,
                     'stage': 'reading', 'provider_code': 'UNKNOWN', 'local_code': 'UNKNOWN', 'exit_code': None, 'created_targets': previous.get('created_targets', []),
                     'completed_steps': previous.get('completed_steps', []), 'attempt': previous.get('attempt', 0) + 1,
                     'possibly_applied': None, 'setup_verified': False, 'release_ready': False,
                     'phase': 'initial_read', 'mutation_attempts_this_attempt': 0,
                     'federation_may_be_active': None}
        need(self.data['attempt'] <= 20 and len(self.data['completed_steps']) < 256, 'state_attempt_limit')
        self.save()

    def save(self):
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            need(stat.S_ISREG(os.fstat(f.fileno()).st_mode) and os.fstat(f.fileno()).st_nlink == 1 and
                 os.fstat(f.fileno()).st_uid == os.getuid() and stat.S_IMODE(os.fstat(f.fileno()).st_mode) == 0o600, 'state_file')
            os.ftruncate(f.fileno(), 0)
            json.dump(self.data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())


def foundations(s):
    return {k: s[k] for k in ('owner_hash', 'project', 'functions', 'function_policies', 'release_sha', 'release_run_number', 'bucket', 'bucket_policy', 'hmac_1', 'hmac_latest',
                              'act_as', 'build_accounts', 'ancestors', 'account_roles', 'role_metadata')}


def verify_expected(run, before, expected, sleep):
    # Bounded READ-ONLY propagation checks. Never repeat a mutation on a timeout.
    last = None
    for attempt in range(3):
        current = collect(run, include_permission_catalog=False)
        validate_state(current)
        # apiDisabled was checked in both pre-write catalog snapshots. Keep
        # project-specific capability drift visible without rescanning the
        # public catalog: setup may add APIs but must not lose existing ones.
        need(set(before['services']) <= set(current['services']), 'existing_api_disabled')
        need(foundations(before) == foundations(current), 'foundation_changed')
        for target, old in before['policies'].items():
            need(policy_atoms(old) <= policy_atoms(current['policies'].get(target, {})), 'unrelated_iam_loss')
            need(old.get('auditConfigs', []) == current['policies'].get(target, {}).get('auditConfigs', []), 'audit_policy_changed')
        missing = any((r, packed(c), m) not in policy_atoms(current['policies'].get(t, {})) for t, r, m, c in expected)
        complete = not missing and set(APIS) <= set(current['services']) and set(CUSTOM) == set(current['custom']) and current['pool'] and current['provider'] and DEPLOYER in current['accounts']
        if complete:
            return current
        last = current
        if attempt < 2:
            sleep(2)
    raise Stop('verification_not_observed')


def wait_created(run, action, sleep):
    """At most 7 reads (60s each) plus 60s polling pauses per new object.

    A new deployer has an additional initial 60-second propagation pause.
    """
    stage = action['stage']
    target = action['target']
    if stage == 'create_deployer':
        # Garden's prior IAM principal propagation needed a full 60 seconds.
        # Successful describe alone does not prove binding enforcement readiness.
        sleep(60)
        args = ['iam', 'service-accounts', 'describe', DEPLOYER]
        predicate = lambda v: v.get('email') == DEPLOYER and v.get('projectId') == PROJECT and v.get('uniqueId') and not v.get('disabled')
    elif stage == 'create_custom_role':
        short = target.split('/')[-1]
        args = ['iam', 'roles', 'describe', short]
        predicate = lambda v: v.get('name') == target and v.get('stage') == 'GA' and not v.get('deleted') and set(v.get('includedPermissions', [])) == set(CUSTOM[short])
    elif stage == 'create_disabled_pool':
        args = ['iam', 'workload-identity-pools', 'describe', POOL, '--location=global']
        predicate = lambda v: v.get('name') == POOL_NAME and v.get('state') == 'ACTIVE' and v.get('disabled') is True
    else:
        need(stage == 'create_disabled_provider', 'unexpected_creation')
        args = ['iam', 'workload-identity-pools', 'providers', 'describe', PROVIDER, '--location=global', '--workload-identity-pool=' + POOL]
        predicate = lambda v: v.get('name') == PROVIDER_NAME and v.get('state') == 'ACTIVE' and v.get('disabled') is True
    for attempt in range(7):
        try:
            value = run(args, stage + '_propagation')
            if predicate(value):
                return
        except Stop as e:
            if e.code != 'NOT_FOUND':
                raise
        if attempt < 6:
            sleep(10)
    raise Stop(stage + '_propagation_not_observed')


def wait_enabled(run, action, sleep):
    args = [a for a in action['args'] if a != '--no-disabled']
    args = ['describe' if a in ('update', 'update-oidc') else a for a in args]
    for attempt in range(7):
        value = run(args, action['stage'] + '_propagation')
        if value.get('name') == action['target'] and value.get('state') == 'ACTIVE' and not value.get('disabled', False):
            return
        if attempt < 6:
            sleep(10)
    raise Stop(action['stage'] + '_propagation_not_observed')


def execute(run, state, confirm=input, emit=print, now=lambda: time.time() * 1000, sleep=time.sleep):
    try:
        need(now() < EXPIRY, 'original_deadline_expired')
        run.read_phase = 'initial_plan'
        emit('PREFLIGHT: two IAM catalog scans are required, one for the initial plan and one after owner confirmation. Each is bounded at 10 minutes with progress every 30 seconds. Their combined 20-minute bound is not an estimate or a limit for the entire setup.')
        before = collect(run)
        state.data['federation_may_be_active'] = bool(before['pool'] and not before['pool'].get('disabled', False) and before['provider'] and not before['provider'].get('disabled', False))
        plan = make_plan(before)
        token = digest(plan)
        state.data.update(stage='owner_confirmation', phase='owner_confirmation', plan_hash=token)
        state.save()
        emit(render_plan(plan, token))
        emit('No cloud writes yet. Review every grant and change above. No release is included.')
        phrase = f'APPROVE {token[:12]}'
        started = now()
        need(confirm('Type exactly ' + phrase + ': ') == phrase, 'owner_confirmation_declined')
        need(now() < EXPIRY and now() - started <= 300000, 'owner_confirmation_expired')
        # Fresh read binds authorization to the same live metadata and diff.
        state.data['phase'] = 'confirmation_read'
        state.save()
        run.read_phase = 'confirmation_read'
        fresh = collect(run)
        need(digest(make_plan(fresh)) == token, 'plan_changed_confirm_again')
        run.approved = True
        state.data.update(stage='applying', phase='applying')
        state.save()
        expected = validate(before)
        ordinary = [a for a in plan['actions'] if not a['stage'].endswith('_last')]
        enables = [a for a in plan['actions'] if a['stage'].endswith('_last')]
        for action in ordinary:
            need(now() < EXPIRY, 'original_deadline_expired')
            stage, target = action['stage'], action['target']
            previous_policy = run(policy_command(target, 'get-iam-policy'), 'binding_before') if action['binding'] else None
            # Save the uncertainty marker before dispatch, after any read-only
            # precondition. This counter is per invocation and deliberately
            # conservative: a failed launch may not have reached the provider.
            state.data.update(stage=stage, possibly_applied={'stage': stage, 'target': target},
                              mutation_attempts_this_attempt=state.data['mutation_attempts_this_attempt'] + 1)
            state.save()
            run(action['args'], stage, write=True)
            if action['create']:
                state.data['created_targets'].append(target)
            state.data['completed_steps'].append({'stage': stage, 'target': target})
            state.data['possibly_applied'] = None
            state.save()
            if action['create']:
                wait_created(run, action, sleep)
            if previous_policy is not None:
                after = run(policy_command(target, 'get-iam-policy'), 'binding_after')
                need(policy_atoms(previous_policy) <= policy_atoms(after) and
                     tuple(action['binding']) in policy_atoms(after), 'binding_verification')
                need(previous_policy.get('auditConfigs', []) == after.get('auditConfigs', []), 'audit_policy_changed')
        state.data['phase'] = 'verification'
        state.save()
        verified = verify_expected(run, before, expected, sleep)
        for action in enables:
            need(now() < EXPIRY, 'original_deadline_expired')
            # If another actor enabled federation prematurely, do not continue.
            need(verified['pool'].get('disabled', False) or verified['provider'].get('disabled', False), 'federation_enabled_early')
            state.data.update(stage=action['stage'], phase='enabling', possibly_applied={'stage': action['stage'], 'target': action['target']}, federation_may_be_active=True,
                              mutation_attempts_this_attempt=state.data['mutation_attempts_this_attempt'] + 1)
            state.save()
            run(action['args'], action['stage'], write=True)
            state.data['completed_steps'].append({'stage': action['stage'], 'target': action['target']})
            state.data['possibly_applied'] = None
            state.save()
            wait_enabled(run, action, sleep)
            state.data['phase'] = 'verification'
            state.save()
            verified = verify_expected(run, before, expected, sleep)
        need(verified['pool'].get('disabled', False) is False and verified['provider'].get('disabled', False) is False, 'federation_enable_not_observed')
        state.data.update(stage='setup_verified', phase='verified', setup_verified=True)
        state.save()
        emit('SETUP_VERIFIED release_ready=false. This verified setup metadata only; no deployment or credential exchange was tested.')
        return 0
    except (Stop, EOFError, KeyboardInterrupt, KeyError, TypeError, ValueError, OSError) as e:
        stage, code = (e.stage, e.code) if isinstance(e, Stop) else ('owner_interrupted' if isinstance(e, (EOFError, KeyboardInterrupt)) else 'metadata_or_local_state_error', 'UNKNOWN')
        local_code = e.local_code if isinstance(e, Stop) else 'UNKNOWN'
        exit_code = e.exit_code if isinstance(e, Stop) else None
        state.data.update(stage=stage, provider_code=code, local_code=local_code, exit_code=exit_code)
        state.save()
        emit(f"SETUP_STOP stage={stage} phase={state.data['phase']} provider_code={code} local_code={local_code} exit_code={exit_code} mutation_attempts_this_attempt={state.data['mutation_attempts_this_attempt']} federation_may_be_active={state.data['federation_may_be_active']}. No automatic rollback or mutation retry. Review the redacted state; resume requires fresh reads and confirmation.")
        if state.data['mutation_attempts_this_attempt'] == 0:
            emit('THIS_ATTEMPT_NO_MUTATIONS: no helper mutation was attempted in this invocation. Earlier attempts and existing cloud state are not established by this result.')
        if local_code == 'CLI_FORMAT':
            emit('CLI_FORMAT_INVALID: the SDK rejected an output format. Do not repeat this helper unchanged; its format must be corrected and tested offline.')
        return 2
    finally:
        run.approved = False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--plan', action='store_true')
    mode.add_argument('--setup', action='store_true')
    parser.add_argument('--project')
    parser.add_argument('--project-number')
    parser.add_argument('--original-expiry', type=int)
    parser.add_argument('--state-dir')
    parser.add_argument('--approved-release-sha')
    parser.add_argument('--approved-release-run-number')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(argv)
    if not args.setup:
        print(json.dumps({'mode': 'offline-plan', 'cloud_calls': 0, 'project': PROJECT, 'number': NUMBER,
            'original_expiry': EXPIRY, 'deadline': DEADLINE, 'deployer': DEPLOYER,
            'pool': POOL_NAME, 'provider': PROVIDER_NAME, 'issuer': 'https://token.actions.githubusercontent.com',
            'audience': 'default provider resource audience', 'attribute_mapping': MAPPING,
            'attribute_condition': ATTRIBUTE_CONDITION + " && assertion.workflow_sha == '<reviewed release commit>' && assertion.run_number == '<reviewed next run>'", 'project_roles': PROJECT_ROLES, 'custom_roles': CUSTOM,
            'new_binding_conditions': {'time': TIME_CONDITION, 'source': SOURCE_CONDITION, 'gate': GATE_CONDITION},
            'only_enable_missing_apis': APIS, 'disclosures': DISCLOSURES,
            'next': 'Freshly authorized owner runs --setup; reads all metadata, reviews exact diff, types its hash, then setup and verification run in this session.'}, indent=2))
        return 0
    try:
        need(args.project == PROJECT and args.project_number == NUMBER and args.original_expiry == EXPIRY and
             args.state_dir and sys.stdin.isatty(), 'explicit_fixed_scope_and_interactive_owner_required')
        need(time.time() * 1000 < EXPIRY, 'original_deadline_expired')
        release_condition(args.approved_release_sha, args.approved_release_run_number)
        runner = Gcloud(args.approved_release_sha, args.approved_release_run_number)
        state = State(args.state_dir, args.resume)
        return execute(runner, state)
    except (Stop, OSError, ValueError) as e:
        stage = e.stage if isinstance(e, Stop) else 'local_state_unavailable'
        print(f'SETUP_STOP stage={stage} provider_code=UNKNOWN')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
