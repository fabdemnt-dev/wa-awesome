#!/usr/bin/env python3
"""Credential-free owner-helper contract for the official Google Cloud SDK 587.

python3 -I tests/floating-garden-ci-owner-sdk.test.py
python3 -I tests/floating-garden-ci-owner-sdk.test.py --sdk-root /trusted/google-cloud-sdk

The SDK is never installed or downloaded by this test. The SDK mode executes
actual command parsers, command bodies, generated HTTP request serialization,
response decoding and JSON display against an in-memory HTTP transport. Real
network, subprocesses, credential loading and component installation are blocked.
Local auth-list receives synthetic account identities (never credentials).
"""
import contextlib
import copy
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SDK_VERSION = '587.0.0'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


renewal = module('garden_owner_sdk_renewal_fixture', ROOT / 'tests/floating-garden-ci-trust-renewal.test.py')
m, b, f = renewal.m, renewal.b, renewal.f
NEW_SHA = 'a' * 40  # Synthetic fixture only; never a released or approved commit.


def blocked_socket_class(forbid):
    """Keep socket's class interface for optional SDK TLS adapter imports."""
    class OfflineSocket(socket.socket):
        def __new__(cls, *args, **kwargs):
            forbid()

        def connect(self, *args, **kwargs):
            forbid()

        def connect_ex(self, *args, **kwargs):
            forbid()

    return OfflineSocket


def fixture():
    result = renewal.Fake()
    result.version = {'Google Cloud SDK': SDK_VERSION}
    result.accounts[b.APPSPOT] = f.account(b.APPSPOT)
    result.policies[b.APPSPOT] = {'version': 3, 'bindings': []}
    result.ancestors += [{'type': 'folder', 'id': '123'}, {'type': 'organization', 'id': '456'}]
    result.ancestor_policy = {'version': 3, 'etag': 'c3ludGhldGlj', 'bindings': [
        f.binding('organizations/456/roles/synthetic', 'serviceAccount:' + f.BUILD, b.condition())]}
    return result


def omit_api_defaults(value):
    """Only documented protobuf omissions; never remove nonempty evidence."""
    if isinstance(value, list):
        return [omit_api_defaults(x) for x in value]
    if isinstance(value, dict):
        return {k: omit_api_defaults(x) for k, x in value.items() if x is not False and x != []
                and not (k == 'customRolesSupportLevel' and x == 'SUPPORTED')}
    return value


def captured_reads():
    """Drive the inherited collector rather than maintain a parallel argv list."""
    source = fixture()
    m.collect(source, NEW_SHA)
    source(['version'], 'gcloud_version')
    # Renewal deliberately does not scan permissions; qualify this shared read
    # too, without claiming the original setup mutation surface is SDK587-ready.
    b.permission_support(source)
    assert not source.writes
    return source


class ManifestTests(unittest.TestCase):
    def test_socket_guard_preserves_class_interface_without_constructing(self):
        class Denied(BaseException):
            pass
        def forbid():
            raise Denied()
        guarded = blocked_socket_class(forbid)
        self.assertTrue(issubclass(guarded, socket.socket))
        self.assertIs(guarded.makefile, socket.socket.makefile)
        for operation in (guarded, lambda: guarded.connect(None, ('127.0.0.1', 1)),
                          lambda: guarded.connect_ex(None, ('127.0.0.1', 1))):
            with self.assertRaises(Denied):
                operation()

    def test_real_collector_reaches_all_optional_read_branches(self):
        source = captured_reads()
        stages = {stage for _, stage, _ in source.calls}
        self.assertEqual(stages, {
            'gcloud_version', 'gcloud_config', 'owner_identity', 'project_identity',
            'enabled_apis', 'function_metadata', 'function_policy', 'source_bucket_owner',
            'hmac_1_metadata', 'hmac_latest_metadata', 'source_bucket_policy',
            'project_policy', 'secret_policy', 'project_ancestors', 'ancestor_policy',
            'account_inventory', 'account_metadata', 'account_policy', 'deployer_keys',
            'custom_role_inventory', 'custom_permission_support', 'role_metadata',
            'pool_inventory', 'pool_policy', 'provider_inventory', 'provider_metadata'})
        args = [args for args, _, _ in source.calls]
        self.assertIn(['resource-manager', 'folders', 'get-iam-policy', '123'], args)
        self.assertIn(['organizations', 'get-iam-policy', '456'], args)
        self.assertIn(['iam', 'roles', 'describe', 'synthetic', '--organization=456'], args)
        self.assertIn(['iam', 'service-accounts', 'describe', b.APPSPOT], args)


def verify_sdk(sdk_root):
    import runpy
    sdk_root = Path(sdk_root).resolve()
    assert (sdk_root / 'VERSION').read_text().strip() == SDK_VERSION

    class UnsafeAction(BaseException):
        pass

    blocked = []
    def forbid(*args, **kwargs):
        blocked.append('credentials/network/process/install')
        raise UnsafeAction('Real credentials, network, process, or installation forbidden')

    def audit(event, args):
        if ((event.startswith('socket.') and event != 'socket.gethostname') or
                event in ('subprocess.Popen', 'os.system', 'os.posix_spawn', 'os.spawn', 'os.exec')):
            forbid()
        if event == 'open' and isinstance(args[0], (str, bytes)):
            name = os.fsdecode(args[0])
            if Path(name).name in ('credentials.db', 'access_tokens.db', 'application_default_credentials.json'):
                forbid()

    sys.addaudithook(audit)
    socket.has_ipv6 = False  # Suppress urllib3's unrelated import-time socket probe.
    with tempfile.TemporaryDirectory(prefix='garden-owner-sdk587-') as tmp:
        config = Path(tmp) / 'config'; config.mkdir(mode=0o700)
        os.environ.clear()
        os.environ.update(HOME=tmp, PATH='/usr/bin:/bin', COLUMNS='80', LINES='24',
            CLOUDSDK_CONFIG=str(config), CLOUDSDK_AUTH_DISABLE_CREDENTIALS='true',
            CLOUDSDK_CORE_ACCOUNT='owner@example.invalid', CLOUDSDK_CORE_CHECK_GCE_METADATA='false',
            CLOUDSDK_CORE_DISABLE_PROMPTS='false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING='true',
            CLOUDSDK_CORE_LOG_HTTP='false', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING='true',
            CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true', CLOUDSDK_CORE_PROJECT=b.PROJECT,
            CLOUDSDK_STORAGE_PREFERRED_API='json', CLOUDSDK_STORAGE_USE_GRPC_IF_AVAILABLE='false',
            CLOUDSDK_FUNCTIONS_GEN2='true', CLOUDSDK_PYTHON_SITEPACKAGES='0')
        runpy.run_path(str(sdk_root / 'lib/gcloud.py'), run_name='gcloud_bootstrap')
        sys.modules.pop('argparse', None)
        import argparse as sdk_argparse
        assert Path(sdk_argparse.__file__).resolve() == sdk_root / 'lib/third_party/argparse/__init__.py'
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
        for name in ('AvailableAccounts', 'AllAccounts', 'AllAccountsWithUniverseDomains',
                     'GetAccessToken', 'GetAccessTokenIfEnabled', 'GetFreshAccessToken',
                     'GetFreshAccessTokenIfEnabled', 'LoadFreshCredential', 'LoadIfEnabled',
                     'Load', 'Refresh', 'RefreshIfExpireWithinWindow', 'RefreshIfAlmostExpire'):
            setattr(credential_store, name, forbid)
        google.auth.default = forbid
        google.auth._default.default = forbid
        apis.GetGapicClientInstance = forbid
        info_holder.ToolsInfo._GetVersion = lambda self, command: 'OFFLINE SDK TEST'
        subprocess.Popen = forbid
        subprocess.run = forbid
        original_socket = socket.socket
        socket.socket = blocked_socket_class(forbid)
        socket.create_connection = forbid
        assert issubclass(socket.socket, original_socket)
        assert socket.socket.makefile is original_socket.makefile
        # Check both guards independently: constructor/connect overrides keep
        # SDK imports compatible, while the audit hook also blocks retained
        # original aliases, the raw C socket constructor, DNS and connect events.
        import _socket
        guard_probes = 0
        for operation in (socket.socket, original_socket, _socket.socket,
                          lambda: socket.create_connection(('127.0.0.1', 1)),
                          lambda: socket.socket.connect(None, ('127.0.0.1', 1)),
                          lambda: socket.socket.connect_ex(None, ('127.0.0.1', 1)),
                          lambda: socket.getaddrinfo('localhost', 1),
                          lambda: sys.audit('socket.connect', None, ('127.0.0.1', 1))):
            before = len(blocked)
            try:
                operation()
            except UnsafeAction:
                pass
            else:
                raise AssertionError('Offline socket guard allowed an operation')
            assert len(blocked) == before + 1
            blocked.pop()  # Remove only this explicitly expected guard probe.
            guard_probes += 1
        from googlecloudsdk.api_lib.storage import api_factory
        # Ubuntu CI may provide pyOpenSSL. Import the actual optional adapter
        # when available, rather than skipping or replacing its implementation.
        pyopenssl_imported = importlib.util.find_spec('OpenSSL') is not None
        if pyopenssl_imported:
            from urllib3.contrib import pyopenssl
            assert pyopenssl.socket_cls is socket.socket
            assert pyopenssl.WrappedSocket.makefile is original_socket.makefile

        class HTTP:
            def __init__(self, args, stage, value, partial=False, late_error=False, omit_defaults=False, error_code=None):
                self.args, self.stage = args, stage
                self.value = copy.deepcopy(value)
                self.partial, self.late_error, self.omit_defaults = partial, late_error, omit_defaults
                self.error_code = error_code
                self.calls, self.connections = [], {}

            def request(self, uri, method='GET', body=None, headers=None, **kwargs):
                parsed = urlsplit(uri)
                query, path = parse_qs(parsed.query), unquote(parsed.path)
                payload = json.loads(body) if body else None
                self.calls.append((method, parsed.netloc, path, query, payload))
                args, stage, value = self.args, self.stage, self.value
                host, expected, envelope = None, None, None
                verb = 'GET'
                if stage == 'project_identity':
                    host, expected = 'cloudresourcemanager', '/v1/projects/' + b.PROJECT
                elif stage == 'enabled_apis':
                    host, expected, envelope = 'serviceusage', '/v1/projects/' + b.PROJECT + '/services', 'services'
                    assert query.get('filter') == ['state:ENABLED']
                elif stage == 'function_metadata':
                    host, expected, envelope = 'cloudfunctions', f'/v2/projects/{b.PROJECT}/locations/{b.REGION}/functions', 'functions'
                    assert query.get('pageSize') == ['100']
                elif stage == 'function_policy':
                    host, expected = 'cloudfunctions', f'/v2/projects/{b.PROJECT}/locations/{b.REGION}/functions/{args[2]}'
                    if len(self.calls) == 1:
                        value = next(x for x in fixture().functions if x['name'].endswith('/' + args[2]))
                    else:
                        assert len(self.calls) == 2
                        expected += ':getIamPolicy'
                        # Stock SDK587 does not request IAM policy version3
                        # for Functions; test its real empty-policy path.
                        assert 'options.requestedPolicyVersion' not in query
                elif stage in ('source_bucket_owner', 'source_bucket_policy'):
                    host, expected = 'storage', '/storage/v1/b/' + b.BUCKET
                    if stage.endswith('policy'):
                        expected += '/iam'
                        assert query.get('optionsRequestedPolicyVersion') == ['3']
                        assert query.get('fields') == ['bindings,etag']
                elif stage.startswith('hmac_'):
                    host, expected = 'secretmanager', f'/v1/projects/{b.PROJECT}/secrets/{b.SECRET}/versions/{args[3]}'
                elif stage == 'project_policy':
                    host, expected, verb = 'cloudresourcemanager', '/v1/projects/' + b.PROJECT + ':getIamPolicy', 'POST'
                    assert payload == {'options': {'requestedPolicyVersion': 3}}
                elif stage == 'secret_policy':
                    host, expected = 'secretmanager', f'/v1/projects/{b.PROJECT}/secrets/{b.SECRET}:getIamPolicy'
                    assert query.get('options.requestedPolicyVersion') == ['3']
                elif stage == 'project_ancestors':
                    host, expected, verb = 'cloudresourcemanager', '/v1/projects/' + b.PROJECT + ':getAncestry', 'POST'
                    value = {'ancestor': [{'resourceId': x} for x in value]}
                elif stage == 'ancestor_policy':
                    host, verb = 'cloudresourcemanager', 'POST'
                    kind = 'folders' if args[0] == 'resource-manager' else 'organizations'
                    expected = ('/v2/' if kind == 'folders' else '/v1/') + kind + '/' + args[-1] + ':getIamPolicy'
                    assert payload == {'options': {'requestedPolicyVersion': 3}}
                elif stage in ('account_inventory', 'account_metadata', 'account_policy', 'deployer_keys'):
                    host = 'iam'
                    expected = '/v1/projects/' + (b.PROJECT if stage == 'account_inventory' else '-') + '/serviceAccounts'
                    if stage == 'account_inventory': envelope = 'accounts'
                    else:
                        expected += '/' + (b.DEPLOYER if stage == 'deployer_keys' else args[3])
                        if stage == 'account_policy':
                            expected += ':getIamPolicy'; verb = 'POST'
                            assert query.get('options.requestedPolicyVersion') == ['3']
                        if stage == 'deployer_keys':
                            expected += '/keys'; envelope = 'keys'
                            assert query.get('keyTypes') == ['USER_MANAGED']
                elif stage in ('custom_role_inventory', 'role_metadata'):
                    host = 'iam'
                    if stage == 'custom_role_inventory':
                        expected, envelope = '/v1/projects/' + b.PROJECT + '/roles', 'roles'
                        assert query.get('showDeleted') == ['True'], self.calls[-1]
                    else:
                        name = args[3]
                        if name.startswith('roles/'): expected = '/v1/' + name
                        elif '--organization=456' in args: expected = '/v1/organizations/456/roles/' + name
                        else: expected = '/v1/projects/' + b.PROJECT + '/roles/' + name
                elif stage == 'custom_permission_support':
                    host, expected, verb, envelope = 'iam', '/v1/permissions:queryTestablePermissions', 'POST', 'permissions'
                    assert payload['fullResourceName'] == '//cloudresourcemanager.googleapis.com/projects/' + b.PROJECT
                    assert payload['pageSize'] == 100
                elif stage in ('pool_inventory', 'pool_policy', 'provider_inventory', 'provider_metadata'):
                    host = 'iam'
                    expected = f'/v1/projects/{b.PROJECT}/locations/global/workloadIdentityPools'
                    if stage == 'pool_inventory': envelope = 'workloadIdentityPools'
                    else:
                        expected += '/' + b.POOL
                        if stage == 'pool_policy':
                            expected += ':getIamPolicy'; verb = 'POST'
                            assert payload == {}
                        else:
                            expected += '/providers'
                            if stage == 'provider_inventory': envelope = 'workloadIdentityPoolProviders'
                            else: expected += '/' + b.PROVIDER
                    if stage.endswith('inventory'): assert query.get('showDeleted') == ['True'], self.calls[-1]
                else:
                    raise UnsafeAction('Unexpected HTTP for stage ' + stage)
                assert parsed.scheme == 'https' and parsed.netloc == host + '.googleapis.com', self.calls[-1]
                assert method == verb and path == expected, (stage, self.calls[-1], expected)
                error_code = self.error_code
                if stage == 'role_metadata' and '_withcond_' in args[3]:
                    # IAM v1's synthetic role names cannot resolve as actual
                    # roles. Exercise a real SDK 404 instead of a fake role.
                    error_code = 404
                if error_code:
                    return httplib2.Response({'status': str(error_code), 'content-type': 'application/json'}), json.dumps(
                        {'error': {'code': error_code, 'status': 'ABORTED' if error_code == 409 else 'NOT_FOUND',
                                   'message': 'synthetic metadata failure'}}).encode()
                # No real transport is used. POST endpoints are explicitly
                # allowlisted read methods; every write verb/path fails above.
                if envelope:
                    token = payload.get('pageToken') if stage == 'custom_permission_support' else query.get('pageToken', [None])[0]
                    assert token in (None, 'synthetic-page-2'), self.calls[-1]
                    if token and self.late_error:
                        return httplib2.Response({'status': '403', 'content-type': 'application/json'}), json.dumps(
                            {'error': {'code': 403, 'status': 'PERMISSION_DENIED', 'message': 'synthetic late page denial'}}).encode()
                    if value:
                        split = max(1, len(value) // 2)
                        result = {envelope: value[split:] if token else value[:split]}
                        if not token: result['nextPageToken'] = 'synthetic-page-2'
                    else: result = {envelope: []}
                    if stage == 'function_metadata' and self.partial and token:
                        result['unreachable'] = [b.REGION]
                else: result = value
                if self.omit_defaults:
                    result = omit_api_defaults(result)
                return httplib2.Response({'status': '200', 'content-type': 'application/json'}), json.dumps(result).encode()

        seen, requests, executed, attempts = {}, [], set(), []
        paged_stages = set()

        def run_command(args, stage, value, **http_options):
            """Capture exact production-wrapper argv; run the SDK in-process."""
            captured = []
            def capture(argv, **kwargs):
                assert argv[0] == 'gcloud' and '--quiet' not in argv and '--help' not in argv
                assert kwargs['env']['CLOUDSDK_FUNCTIONS_GEN2'] == 'true'
                assert kwargs['env']['CLOUDSDK_STORAGE_PREFERRED_API'] == 'json'
                assert os.read(kwargs['stdin'], 2) == b'n\n'
                captured.append(argv[1:])
                return subprocess.CompletedProcess(argv, 0, b'{}', b'')
            with patch.object(subprocess, 'run', side_effect=capture):
                (b.Gcloud(emit=lambda _: None) if stage == 'custom_permission_support' else m.ReadOnlyGcloud())(args, stage)
            assert len(captured) == 1
            argv = captured[0]
            api_factory.clear_thread_local_instances()  # Each real wrapper call starts a fresh SDK process.
            cli = gcloud_main.CreateCLI([])
            named_configs.FLAG_OVERRIDE_STACK.PushFromArgs(argv)
            properties.VALUES.PushInvocationValues()
            http = HTTP(args, stage, value, **http_options)
            attempts.append(http)
            output, errors = io.StringIO(), io.StringIO()
            previous = log.GetVerbosity()
            try:
                parsed = cli.top_element._parser.parse_args(argv)
                if parsed.CONCEPT_ARGS is not None: parsed.CONCEPT_ARGS.ParseConcepts()
                assert properties.VALUES.core.disable_prompts.GetBool() is False
                command = parsed._GetCommand()
                instance = command._common_type(cli=cli, context={})
                log.SetVerbosity(logging.WARNING if stage == 'function_metadata' else logging.ERROR)
                with patch.object(transports, 'GetApitoolsTransport', return_value=http), \
                     patch.object(unauthenticated_transports, 'GetApitoolsTransport', return_value=http), \
                     patch.object(credential_store, 'AllAccountsWithUniverseDomains', return_value=[
                         credential_store.AcctInfoWithUniverseDomain('owner@example.invalid', 'ACTIVE', 'googleapis.com')]), \
                     patch.object(log, 'out', output), patch.object(log.status, 'Print'), \
                     patch.object(log._log_manager.stderr_handler, 'stream', errors), \
                     patch.object(sys, 'stdin', io.StringIO('n\n' * 100)), contextlib.redirect_stderr(errors):
                    resource = instance.Run(parsed)
                    display.Displayer(instance, parsed, resource, display_info=command.ai.display_info).Display()
                data = json.loads(output.getvalue())
                if stage == 'function_metadata': b.validate_function_inventory_diagnostics(errors.getvalue().encode())
                if stage not in ('gcloud_config', 'owner_identity', 'gcloud_version'):
                    assert http.calls, stage
                else: assert not http.calls, stage
                if stage in ('enabled_apis', 'function_metadata', 'account_inventory',
                             'custom_role_inventory', 'pool_inventory', 'provider_inventory',
                             'custom_permission_support') and value:
                    assert len(http.calls) == 2, (stage, http.calls)
                    if stage == 'custom_permission_support':
                        assert http.calls[0][-1].get('pageToken') is None
                        assert http.calls[1][-1]['pageToken'] == 'synthetic-page-2'
                    else:
                        assert 'pageToken' not in http.calls[0][3]
                        assert http.calls[1][3]['pageToken'] == ['synthetic-page-2']
                    paged_stages.add(stage)
                seen.setdefault(stage, set()).add(tuple(argv))
                executed.add((tuple(args), stage))
                requests.extend(http.calls)
                return data, http
            finally:
                log.SetVerbosity(previous)
                properties.VALUES.PopInvocationValues()
                named_configs.FLAG_OVERRIDE_STACK.Pop()

        class SDKRunner:
            def __init__(self, omit_defaults=False, overrides=None):
                self.source = fixture()
                self.release_sha, self.release_run_number = self.source.release_sha, self.source.release_run_number
                self.omit_defaults = omit_defaults
                self.overrides = overrides or {}
            def __call__(self, args, stage, write=False):
                assert not write
                value = self.source(args, stage)
                if stage in self.overrides:
                    value = self.overrides[stage]
                data, _ = run_command(args, stage, value, omit_defaults=self.omit_defaults)
                return data

        for omit in (False, True):
            runner = SDKRunner(omit)
            snapshot = m.collect(runner, NEW_SHA)
            assert m.validate_snapshot(snapshot, NEW_SHA) == 'original'
            expected = m.collect(fixture(), NEW_SHA)
            assert omit_api_defaults(snapshot) == omit_api_defaults(expected), 'Complete rendered snapshot mismatch'
            assert m.collect(SDKRunner(omit), NEW_SHA) == snapshot, 'Exact repeated SDK read mismatch'
            audit_output = []
            assert m.audit(SDKRunner(omit), NEW_SHA, emit=audit_output.append,
                           now=lambda: b.EXPIRY - 86400000) == 0, audit_output
            audit_result = json.loads(audit_output[0])
            assert audit_result['result'] == 'TRUST_AUDIT_VERIFIED'
            assert audit_result['snapshot_sha256'] == b.digest(snapshot)
            assert audit_result['complete_matching_reads'] == 2
            assert audit_result['cloud_writes'] == 0 and audit_result['release_ready'] is False
            assert 'owner@example.invalid' not in '\n'.join(audit_output)
            assert snapshot['bucket'] == {'name': b.BUCKET, 'projectNumber': b.NUMBER}
            assert set(snapshot['ancestors']) == {'folder/123', 'organization/456'}
            assert len(snapshot['functions']) == 5
            assert snapshot['ancestors']['folder/123']['bindings'][0]['condition'] == b.condition()
            assert snapshot['policies']['project']['version'] == 3
            assert snapshot['deployer_keys'] == []
            permission = b.permission_support(runner)
            b.validate_permission_support({'permission_support': permission})
            version, _ = run_command(['version'], 'gcloud_version', {'Google Cloud SDK': SDK_VERSION})
            assert version['Google Cloud SDK'] == SDK_VERSION

        args = b.function_inventory_args()
        for option, expected_stage in (({'partial': True}, 'function_inventory_incomplete'), ({'late_error': True}, None)):
            try:
                run_command(args, 'function_metadata', fixture().functions, **option)
            except b.Stop as error:
                assert error.stage == expected_stage
            except Exception as error:
                assert expected_stage is None and not isinstance(error, AssertionError), error
            else: raise AssertionError('Incomplete function inventory must fail')
            assert len(attempts[-1].calls) == 2
            assert attempts[-1].calls[-1][3]['pageToken'] == ['synthetic-page-2']

        expected_reads = {(tuple(args), stage) for args, stage, write in captured_reads().calls if not write}
        assert executed == expected_reads, (expected_reads - executed, executed - expected_reads)
        assert paged_stages == {'enabled_apis', 'function_metadata', 'account_inventory',
            'custom_role_inventory', 'pool_inventory', 'provider_inventory', 'custom_permission_support'}
        # Exercise condition rendering at the supported resource-policy seams.
        synthetic_policy = {'version': 3, 'etag': 'c3ludGhldGlj', 'bindings': [
            f.binding('roles/viewer', 'user:unrelated@example.invalid', b.condition())]}
        for args, stage, _ in captured_reads().calls:
            if stage in ('source_bucket_policy', 'secret_policy', 'account_policy'):
                rendered, _ = run_command(args, stage, synthetic_policy)
                assert rendered['bindings'] == synthetic_policy['bindings']
        # Functions/pool do not request v3. Even a v1 downgraded conditional
        # binding retains its target member and must never pass as empty/allowed.
        negative_cases = 0
        for role in ('roles/viewer_withcond_synthetic', 'roles/viewer'):
            for member in (b.MEMBER, b.PRINCIPAL):
                downgraded = {'bindings': [f.binding(role, member)]}
                for stage, args in (
                        ('function_policy', ['functions', 'get-iam-policy', b.FUNCTIONS[0], '--region=' + b.REGION]),
                        ('pool_policy', b.policy_command('pool', 'get-iam-policy'))):
                    rendered, _ = run_command(args, stage, downgraded)
                    altered = copy.deepcopy(snapshot)
                    if stage == 'function_policy': altered['function_policies'][b.FUNCTIONS[0]] = rendered
                    else: altered['policies']['pool'] = rendered
                    try: m.validate_snapshot(altered, NEW_SHA)
                    except b.Stop as error: assert error.stage == 'broader_existing_target_binding'
                    else: raise AssertionError('Downgraded or conditionless target binding must fail closed')
                    negative_cases += 1
        # All required expiry-bearing policies use v3 above. Omission of an
        # actual required condition must still fail after SDK rendering.
        for target, stage in (('project', 'project_policy'), ('secret', 'secret_policy'),
                              (b.DEPLOYER, 'account_policy'), (b.RUNTIME, 'account_policy'),
                              (f.BUILD, 'account_policy')):
            policy = copy.deepcopy(snapshot['policies'][target])
            binding = next(x for x in policy['bindings'] if x.get('condition'))
            del binding['condition']
            rendered, _ = run_command(b.policy_command(target, 'get-iam-policy'), stage, policy)
            altered = copy.deepcopy(snapshot); altered['policies'][target] = rendered
            try: m.validate_snapshot(altered, NEW_SHA)
            except b.Stop as error: assert error.stage == 'broader_existing_target_binding'
            else: raise AssertionError('Missing required expiry must fail closed')
            negative_cases += 1
        for member in ('serviceAccount:' + b.RUNTIME, 'serviceAccount:' + f.BUILD):
            downgraded = {'bindings': [f.binding('roles/viewer_withcond_synthetic', member)]}
            try: m.collect(SDKRunner(overrides={'function_policy': downgraded}), NEW_SHA)
            except Exception as error:
                assert not isinstance(error, AssertionError) and '404' in str(error), error
            else: raise AssertionError('Hashed conditional role must not resolve as an ordinary role')
            assert attempts[-1].stage == 'role_metadata' and '_withcond_' in attempts[-1].args[3]
            assert len(attempts[-1].calls) == 1
            negative_cases += 1
        provider_args = next(args for args, stage, _ in captured_reads().calls if stage == 'provider_metadata')
        try: run_command(provider_args, 'provider_metadata', fixture().provider, error_code=409)
        except Exception as error:
            assert not isinstance(error, AssertionError) and '409' in str(error), error
        else: raise AssertionError('HTTP409 must stop without a successful snapshot')
        assert len(attempts[-1].calls) == 1
        negative_cases += 1
        assert len(seen) == 26, sorted(seen)
        assert not blocked, blocked
        assert not list(config.rglob('*credentials*'))
        print(json.dumps({'sdk': SDK_VERSION, 'offline': True, 'read_stages': len(seen),
            'argv_variants': sum(map(len, seen.values())), 'synthetic_http_requests': len(requests),
            'all_inherited_reads': True, 'real_command_request_display_pipeline': True,
            'observed_paginated_stages': sorted(paged_stages),
            'function_pagination_and_late_unreachable': True, 'late_page_denial_rejected': True,
            'complete_rendered_snapshot_equality_and_audit': True,
            'adversarial_policy_and_api_error_cases': negative_cases,
            'expiry_policy_v3_services': ['project', 'folder', 'organization', 'secret', 'serviceAccount', 'storageBucket'],
            'functions_and_pool_policy_v3_requested': False,
            'ancestor_policy_version_3': True, 'iam_storage_shapes_and_default_omission': True,
            'socket_class_interface_preserved': True, 'blocked_socket_guard_probes': guard_probes,
            'optional_pyopenssl_imported': pyopenssl_imported,
            'live_credential_or_cloud_calls': 0, 'subprocesses': 0}))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--sdk-root':
        verify_sdk(sys.argv[2])
    else:
        unittest.main()
