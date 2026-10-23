#!/usr/bin/env python3
"""Credential-free SDK 568.0.0 deploy request regression.

Run: python3 -I tests/floating-garden-ci-gcloud-sdk.test.py --sdk-root PATH
CI additionally supplies --argv-fixture PATH: five production-generated argv
arrays (without the executable), using /ABSOLUTE_PACKET_FUNCTIONS_DIR and
/ABSOLUTE_EXPLICIT_IGNORE_FILE for the two local filesystem inputs.
For a real generated packet, pass {"argv": [...], "expectedFiles": {relativePath:
sha256}, "captureZip": absoluteOutputPath} instead. Its argv retains the exact
existing source/ignore paths. captureZip is optional and saves the first signed
PUT bytes for the production archive validator; it must be a new file beneath
the fixture's directory.

The real SDK parser, command, API clients, JSON serialization, ZIP creation,
signed upload, operation polling and post-read execute in-process. Only the
HTTP transport is an in-memory fake. No SDK request builders are replaced.
Network, subprocess, credentials, installation, and unrecognized HTTP requests
are independently prohibited. Fixtures contain no credentials or secret data.
"""

import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import socket
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
PROJECT = 'wa-awesome-garden-stg'
NUMBER = '120030709276'
REGION = 'asia-northeast1'
RUNTIME = f'garden-trial-runtime@{PROJECT}.iam.gserviceaccount.com'
BUILD = f'projects/{PROJECT}/serviceAccounts/{NUMBER}-compute@developer.gserviceaccount.com'
BUCKET = f'gcf-v2-sources-{NUMBER}-{REGION}'
FUNCTIONS = ('floatingGardenCreateRoom', 'floatingGardenJoinRoom',
             'floatingGardenStartMatch', 'floatingGardenGetSnapshot',
             'floatingGardenSubmitAction')
PARENT = f'projects/{PROJECT}/locations/{REGION}'
MASK = ('build_config.service_account,build_config.source,'
        'service_config.service_account_email')
SOURCE_TOKEN = '/ABSOLUTE_PACKET_FUNCTIONS_DIR'
IGNORE_TOKEN = '/ABSOLUTE_EXPLICIT_IGNORE_FILE'
SIGNED_URL = 'https://offline-upload.invalid/source.zip?signature=synthetic'
# API-contract fixtures, not observations of live Google bucket names/copying.
# generateUploadUrl supplies the upload location; completed function metadata
# supplies separately resolved, service-managed provenance. The SDK does not
# perform that backend copy, and this test cannot prove its live permissions.
UPLOAD_SOURCE = {'bucket': 'offline-generated-upload-bucket',
                 'object': 'offline-upload.zip', 'generation': '124'}
RESOLVED_SOURCE = {'bucket': BUCKET, 'object': 'offline-resolved-source.zip', 'generation': '125'}


class UnsafeAction(BaseException):
    """Escape ordinary Exception handlers; the audit guard stays active on retry."""


def baseline(name, variant=0):
    value = {
        'name': f'{PARENT}/functions/{name}', 'environment': 'GEN_2',
        'state': 'ACTIVE', 'description': 'Synthetic existing Firebase function',
        'labels': {'deployment-tool': 'cli-firebase', 'deployment-callable': 'true',
                   'firebase-functions-codebase': 'floating-garden-trial',
                   'firebase-functions-hash': 'a' * 40},
        'buildConfig': {
            'runtime': 'nodejs22', 'entryPoint': name,
            'serviceAccount': BUILD,
            'environmentVariables': {'GOOGLE_NODE_RUN_SCRIPTS': ''},
            'automaticUpdatePolicy': {},
            'source': {'storageSource': {'bucket': BUCKET, 'object': f'{name}/old.zip',
                                         'generation': '123'}},
            'sourceProvenance': {'resolvedStorageSource': {
                'bucket': BUCKET, 'object': f'{name}/old.zip', 'generation': '123'}},
            'dockerRepository': f'projects/{PROJECT}/locations/{REGION}/repositories/gcf-artifacts',
            'dockerRegistry': 'ARTIFACT_REGISTRY',
        },
        'serviceConfig': {
            'serviceAccountEmail': RUNTIME, 'availableMemory': '256Mi',
            'availableCpu': '1', 'timeoutSeconds': 30, 'maxInstanceCount': 1,
            'minInstanceCount': 0, 'maxInstanceRequestConcurrency': 1,
            'ingressSettings': 'ALLOW_ALL', 'allTrafficOnLatestRevision': True,
            'environmentVariables': {'GCLOUD_PROJECT': PROJECT,
                                     'FIREBASE_CONFIG': json.dumps({'projectId': PROJECT, 'storageBucket': PROJECT + '.appspot.com'}),
                                     'FUNCTION_TARGET': name, 'LOG_EXECUTION_ID': 'true',
                                     'EVENTARC_CLOUD_EVENT_SOURCE': f'{PARENT}/services/{name}'},
            'uri': f'https://{name.lower()}-synthetic.a.run.app',
            'service': f'{PARENT}/services/{name.lower()}', 'revision': 'synthetic-00001',
        },
    }
    if name in FUNCTIONS[:2]:
        value['serviceConfig']['secretEnvironmentVariables'] = [{
            'key': 'FLOATING_GARDEN_INVITE_HMAC_KEY', 'projectId': NUMBER,
            'secret': 'FLOATING_GARDEN_INVITE_HMAC_KEY', 'version': '1'}]
    if variant == 1:
        value['buildConfig'].pop('automaticUpdatePolicy')
        value['serviceConfig'].pop('minInstanceCount')
        value['serviceConfig'].pop('allTrafficOnLatestRevision')
    elif variant == 2:
        value['buildConfig'].pop('automaticUpdatePolicy')
        value['buildConfig']['onDeployUpdatePolicy'] = {'runtimeVersion': 'synthetic-runtime-version'}
        value['serviceConfig']['allTrafficOnLatestRevision'] = False
    elif variant == 3:
        value['buildConfig'].pop('dockerRepository')
        value['buildConfig'].pop('dockerRegistry')
        value['serviceConfig'].pop('availableCpu')
        value['serviceConfig'].pop('maxInstanceRequestConcurrency')
    elif variant == 4:
        value['serviceConfig']['secretVolumes'] = [{
            'mountPath': '/synthetic-secret', 'projectId': NUMBER,
            'secret': 'synthetic-existing-volume',
            'versions': [{'version': '1', 'path': 'value'}]}]
    return value


def expected_argv(name, build=BUILD, source=SOURCE_TOKEN, ignore=IGNORE_TOKEN):
    return ['functions', 'deploy', name, '--gen2', f'--region={REGION}',
            f'--project={PROJECT}', f'--billing-project={PROJECT}',
            f'--source={source}', f'--ignore-file={ignore}',
            f'--run-service-account={RUNTIME}', f'--build-service-account={build}',
            '--quiet', '--format=json', '--verbosity=error']


def load_argv(path):
    fixture = json.loads(Path(path).read_text()) if path else [expected_argv(n) for n in FUNCTIONS]
    hashes = fixture.get('expectedFiles') if isinstance(fixture, dict) else None
    capture_zip = fixture.get('captureZip') if isinstance(fixture, dict) else None
    if capture_zip:
        capture_zip = Path(capture_zip)
        assert capture_zip.is_absolute() and not capture_zip.exists()
        assert capture_zip.parent.resolve().is_relative_to(Path(path).resolve().parent)
    argv = fixture['argv'] if isinstance(fixture, dict) else fixture
    assert isinstance(argv, list) and len(argv) == len(FUNCTIONS), 'Five argv arrays required'
    for name, args in zip(FUNCTIONS, argv):
        assert isinstance(args, list) and all(isinstance(a, str) for a in args)
        def flag(prefix):
            matches = [a[len(prefix):] for a in args if a.startswith(prefix)]
            assert len(matches) == 1, prefix
            return matches[0]
        build, source, ignore = (flag('--build-service-account='), flag('--source='), flag('--ignore-file='))
        assert re.fullmatch(r'projects/(' + PROJECT + '|' + NUMBER + r')/serviceAccounts/[^/]+', build)
        assert args == expected_argv(name, build, source, ignore), f'Production argv changed for {name}: review SDK request contract'
        if hashes is None:
            assert source == SOURCE_TOKEN and ignore == IGNORE_TOKEN
        else:
            assert Path(source).is_absolute() and Path(source).is_dir()
            assert Path(ignore).is_absolute() and Path(ignore).is_file()
    if hashes is not None:
        assert isinstance(hashes, dict) and hashes
        assert all(isinstance(k, str) and not k.startswith('/') and '..' not in k.split('/') and
                   re.fullmatch('[0-9a-f]{64}', v) for k, v in hashes.items())
        assert len({next(a for a in args if a.startswith('--source=')) for args in argv}) == 1
        assert len({next(a for a in args if a.startswith('--ignore-file=')) for args in argv}) == 1
    return argv, hashes, capture_zip


def verify(sdk_root, fixture_path=None):
    sdk_root = Path(sdk_root).resolve()
    assert (sdk_root / 'VERSION').read_text().strip() == '568.0.0', 'SDK version must be exactly pinned'
    argv_fixture, expected_hashes, capture_zip = load_argv(fixture_path)
    captured_zip = False
    blocked = []

    def forbid(*args, **kwargs):
        blocked.append('forbidden credential/process/network/installation action')
        raise UnsafeAction(blocked[-1])

    def audit(event, args):
        if (event.startswith('socket.') and event != 'socket.gethostname') or event in (
                'subprocess.Popen', 'os.system', 'os.posix_spawn', 'os.spawn', 'os.exec'):
            blocked.append(event)
            raise UnsafeAction(event)

    sys.addaudithook(audit)
    socket.has_ipv6 = False  # Avoid urllib3's unrelated import-time loopback probe.
    with tempfile.TemporaryDirectory(prefix='garden-real-sdk-') as tmp:
        root = Path(tmp)
        config = root / 'config'
        config.mkdir(mode=0o700)
        os.environ.clear()
        os.environ.update(HOME=str(root), PATH='/usr/bin:/bin', COLUMNS='80', LINES='24',
            CLOUDSDK_CONFIG=str(config), CLOUDSDK_AUTH_DISABLE_CREDENTIALS='true',
            CLOUDSDK_CORE_CHECK_GCE_METADATA='false', CLOUDSDK_CORE_DISABLE_PROMPTS='true',
            CLOUDSDK_CORE_DISABLE_FILE_LOGGING='true', CLOUDSDK_CORE_LOG_HTTP='false',
            CLOUDSDK_CORE_DISABLE_USAGE_REPORTING='true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true',
            CLOUDSDK_CORE_PROJECT=PROJECT, CLOUDSDK_PYTHON_SITEPACKAGES='0')
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

        source = root / 'packet' / 'functions'
        source.mkdir(parents=True)
        tiny_source = source
        files = {'index.js': b"exports.synthetic = () => 'offline';\n",
                 'package.json': b'{"name":"offline-fixture","main":"index.js","engines":{"node":"22"}}\n',
                 'generated/engine.js': b'exports.engine = true;\n'}
        decoys = {'node_modules/do-not-upload.js': b'excluded', '.git/config': b'excluded',
                  '.env': b'synthetic-excluded', 'private.json': b'excluded'}
        for name, data in {**files, **decoys}.items():
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        ignore = root / 'explicit-upload.ignore'
        ignore.write_text('node_modules/\n.git/\n.env\nprivate.json\n')
        if expected_hashes is None:
            expected_hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
        else:
            source = Path(next(a.split('=', 1)[1] for a in argv_fixture[0] if a.startswith('--source=')))
            ignore = Path(next(a.split('=', 1)[1] for a in argv_fixture[0] if a.startswith('--ignore-file=')))
        original_source_files = sorted(p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file())

        class OfflineHTTP:
            """The sole injected seam: the SDK's httplib2-compatible transport."""
            connections = {}

            def __init__(self, name, variant=0, failure=None, interrupt=False, missing=False):
                self.original = baseline(name, variant)
                self.build = next(a.split('=', 1)[1] for a in argv_fixture[FUNCTIONS.index(name)]
                                  if a.startswith('--build-service-account='))
                self.original['buildConfig']['serviceAccount'] = self.build
                self.current = copy.deepcopy(self.original)
                self.calls = []
                self.failure = failure
                self.interrupt = interrupt
                self.missing = missing
                self.uploaded = None
                self.patch_body = None
                self.mask = None
                self.function_reads = 0
                self.applied = False

            def response(self, status, value):
                body = json.dumps(value).encode()
                return httplib2.Response({'status': str(status), 'content-type': 'application/json',
                                         'content-length': str(len(body))}), body

            def request(self, uri, method='GET', body=None, headers=None, **kwargs):
                nonlocal captured_zip
                url = urlsplit(uri)
                query = parse_qs(url.query)
                path = url.path
                payload = None if not body or method == 'PUT' else json.loads(body)
                call = {'method': method, 'host': url.netloc, 'path': path,
                        'query': query, 'body': payload, 'headers': dict(headers or {})}
                self.calls.append(call)
                assert not any(k.lower() == 'authorization' for k in (headers or {})), 'No authentication allowed'
                function_path = '/v2/' + self.current['name']
                if url.netloc == 'cloudfunctions.googleapis.com' and path == function_path and method == 'GET':
                    self.function_reads += 1
                    stage = 'postread' if self.patch_body is not None else 'preread'
                elif url.netloc == 'cloudfunctions.googleapis.com' and path == '/v2/' + PARENT + '/runtimes' and method == 'GET':
                    stage = 'runtimes'
                elif url.netloc == 'cloudfunctions.googleapis.com' and path == '/v2/' + PARENT + '/functions:generateUploadUrl' and method == 'POST':
                    stage = 'generate'
                    assert payload == {}, payload
                elif uri == SIGNED_URL and method == 'PUT':
                    stage = 'upload'
                    assert (headers or {}).get('content-type') == 'application/zip'
                    assert isinstance(body, bytes)
                    with zipfile.ZipFile(io.BytesIO(body)) as archive:
                        assert len(archive.namelist()) == len(set(archive.namelist())), 'Duplicate ZIP entries forbidden'
                        self.uploaded = {entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
                                         for entry in archive.infolist() if not entry.is_dir()}
                    assert self.uploaded == expected_hashes, ('Real ZIP must contain exactly the allowed packet bytes',
                        sorted(set(self.uploaded) - set(expected_hashes)), sorted(set(expected_hashes) - set(self.uploaded)))
                elif url.netloc == 'serviceusage.googleapis.com' and method == 'GET' and path.startswith('/v1/projects/' + PROJECT + '/services/'):
                    stage = 'service'
                    assert path.rsplit('/', 1)[1] in ('run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com')
                elif url.netloc == 'cloudresourcemanager.googleapis.com' and method == 'GET' and path == '/v1/projects/' + PROJECT:
                    stage = 'project'
                elif url.netloc == 'cloudfunctions.googleapis.com' and method == 'PATCH' and path == function_path:
                    stage = 'patch'
                    assert self.uploaded == expected_hashes, 'PATCH cannot precede successful source upload'
                    self.patch_body = payload
                    self.mask = query.get('updateMask', [])
                    self.assert_patch()
                elif url.netloc == 'cloudfunctions.googleapis.com' and method == 'GET' and path == '/v2/' + PARENT + '/operations/offline-operation':
                    stage = 'operation'
                else:
                    raise UnsafeAction('Unapproved HTTP request: ' + method + ' ' + uri)
                call['stage'] = stage
                if stage == self.failure:
                    if self.interrupt:
                        raise KeyboardInterrupt('synthetic interruption at ' + stage)
                    return self.response(400, {'error': {'code': 400, 'status': 'INVALID_ARGUMENT',
                                                       'message': 'synthetic failure at ' + stage}})
                if stage == 'preread' and self.missing:
                    return self.response(404, {'error': {'code': 404, 'status': 'NOT_FOUND', 'message': 'synthetic missing'}})
                if stage == 'postread' and self.failure == 'postread-missing':
                    return self.response(404, {'error': {'code': 404, 'status': 'NOT_FOUND', 'message': 'synthetic postread missing'}})
                if stage in ('preread', 'postread'):
                    return self.response(200, self.current)
                if stage == 'runtimes':
                    return self.response(200, {'runtimes': [{'name': 'nodejs22', 'environment': 'GEN_2', 'stage': 'GA'}]})
                if stage == 'generate':
                    return self.response(200, {'uploadUrl': SIGNED_URL, 'storageSource': UPLOAD_SOURCE})
                if stage == 'upload':
                    if capture_zip and not captured_zip:
                        with capture_zip.open('xb') as target:
                            target.write(body)
                        captured_zip = True
                    return self.response(200, {})
                if stage == 'service':
                    return self.response(200, {'name': path.removeprefix('/v1/'), 'state': 'ENABLED'})
                if stage == 'project':
                    return self.response(200, {'projectId': PROJECT, 'projectNumber': NUMBER, 'lifecycleState': 'ACTIVE'})
                if stage == 'patch':
                    # A synthetic server applies only the REAL serialized updateMask.
                    self.current['buildConfig']['source'] = copy.deepcopy(payload['buildConfig']['source'])
                    self.current['buildConfig']['serviceAccount'] = payload['buildConfig']['serviceAccount']
                    self.current['serviceConfig']['serviceAccountEmail'] = payload['serviceConfig']['serviceAccountEmail']
                    self.applied = True
                    if self.failure == 'patch-applied-interrupt':
                        raise KeyboardInterrupt('synthetic interruption after remote application')
                    if self.failure == 'patch-applied-transient' and sum(c.get('stage') == 'patch' for c in self.calls) == 1:
                        return self.response(500, {'error': {'code': 500, 'status': 'INTERNAL',
                                                          'message': 'synthetic ambiguous server error'}})
                if stage == 'operation':
                    # Synthetic backend output, not SDK work or an assertion
                    # that a real build/copy is authorized or has completed.
                    self.current['buildConfig']['sourceProvenance'] = {
                        'resolvedStorageSource': copy.deepcopy(RESOLVED_SOURCE)}
                return self.response(200, {'name': PARENT + '/operations/offline-operation', 'done': True,
                                          'metadata': {'@type': 'type.googleapis.com/google.cloud.functions.v2.OperationMetadata'}})

            def assert_patch(self):
                assert self.mask == [MASK], self.mask
                body = self.patch_body
                assert set(body) == {'name', 'buildConfig', 'serviceConfig'}, body
                assert body['name'] == self.original['name']
                assert body['buildConfig']['serviceAccount'] == self.build
                assert body['serviceConfig']['serviceAccountEmail'] == RUNTIME
                assert body['buildConfig']['source'] == {'storageSource': UPLOAD_SOURCE}
                assert 'sourceProvenance' not in body['buildConfig']
                assert body['buildConfig']['environmentVariables'] == self.original['buildConfig']['environmentVariables']
                assert body['serviceConfig']['environmentVariables'] == self.original['serviceConfig']['environmentVariables']
                assert body['serviceConfig'].get('secretEnvironmentVariables', []) == self.original['serviceConfig'].get('secretEnvironmentVariables', [])
                assert body['serviceConfig'].get('secretVolumes', []) == self.original['serviceConfig'].get('secretVolumes', [])
                assert body['buildConfig'].get('dockerRepository') == self.original['buildConfig'].get('dockerRepository')
                for key in ('runtime', 'entryPoint', 'automaticUpdatePolicy', 'onDeployUpdatePolicy', 'dockerRegistry'):
                    assert key not in body['buildConfig'], (key, body)
                for key in ('allTrafficOnLatestRevision', 'availableMemory', 'availableCpu', 'timeoutSeconds',
                            'maxInstanceCount', 'minInstanceCount', 'maxInstanceRequestConcurrency', 'ingressSettings'):
                    assert key not in body['serviceConfig'], (key, body)

        def run(argv, http):
            # A production invocation is a new CLI; resource concepts retain
            # parse results, so do not reuse its parser between invocations.
            cli = gcloud_main.CreateCLI([])
            argv = [a.replace(SOURCE_TOKEN, str(source)).replace(IGNORE_TOKEN, str(ignore)) for a in argv]
            named_configs.FLAG_OVERRIDE_STACK.PushFromArgs(argv)
            properties.VALUES.PushInvocationValues()
            try:
                parsed = cli.top_element._parser.parse_args(argv)
                if parsed.CONCEPT_ARGS is not None:
                    parsed.CONCEPT_ARGS.ParseConcepts()
                assert parsed.runtime is None and parsed.entry_point is None
                assert not parsed.IsSpecified('runtime_update_policy')
                assert properties.VALUES.core.disable_prompts.GetBool() is True
                command = parsed._GetCommand()
                instance = command._common_type(cli=cli, context={})
                output = io.StringIO()
                with patch.object(transports, 'GetApitoolsTransport', return_value=http), \
                     patch.object(unauthenticated_transports, 'GetApitoolsTransport', return_value=http), \
                     patch.object(log, 'out', output), \
                     patch.object(log.status, 'Print'), contextlib.redirect_stderr(io.StringIO()):
                    result = instance.Run(parsed)
                    display.Displayer(instance, parsed, result, display_info=command.ai.display_info).Display()
                return json.loads(output.getvalue()) if output.getvalue().strip() else None
            finally:
                properties.VALUES.PopInvocationValues()
                named_configs.FLAG_OVERRIDE_STACK.Pop()

        cases = 0
        happy_cases = [(name, args, 0) for name, args in zip(FUNCTIONS, argv_fixture)]
        happy_cases += [(FUNCTIONS[0], argv_fixture[0], i) for i in range(1, 5)]
        for name, args, variant in happy_cases:
            http = OfflineHTTP(name, variant=variant)
            result = run(args, http)
            assert http.applied and http.function_reads == 2
            expected = copy.deepcopy(http.original)
            expected['buildConfig']['source'] = {'storageSource': copy.deepcopy(UPLOAD_SOURCE)}
            expected['buildConfig']['sourceProvenance'] = {'resolvedStorageSource': copy.deepcopy(RESOLVED_SOURCE)}
            assert http.current == expected, 'Only requested source and expected backend provenance may change'
            assert result == http.current, 'Real SDK output must preserve the post-read resource'
            assert result['buildConfig']['sourceProvenance']['resolvedStorageSource'] == RESOLVED_SOURCE
            assert result['buildConfig']['source']['storageSource']['bucket'] != RESOLVED_SOURCE['bucket']
            stages = [c['stage'] for c in http.calls]
            assert stages.index('generate') < stages.index('upload') < stages.index('patch') < stages.index('postread')
            assert stages.count('patch') == stages.count('generate') == stages.count('upload') == 1
            assert {c['path'].rsplit('/', 1)[1] for c in http.calls if c['stage'] == 'service'} == {
                'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com'}
            cases += 1
        for stage in ('preread', 'runtimes', 'generate', 'upload', 'patch', 'operation', 'postread'):
            for interrupted in (False, True):
                http = OfflineHTTP(FUNCTIONS[0], failure=stage, interrupt=interrupted)
                try:
                    run(argv_fixture[0], http)
                except KeyboardInterrupt:
                    assert interrupted
                except Exception:
                    assert not interrupted
                else:
                    raise AssertionError('Failure/interruption must not be reported as success: ' + stage)
                stages = [c['stage'] for c in http.calls]
                expected_attempts = 4 if stage == 'postread' else 1
                assert stages[-1] == stage and stages.count(stage) == expected_attempts, stages
                assert http.applied is (stage in ('operation', 'postread'))
                assert stages.count('patch') == (1 if stage in ('patch', 'operation', 'postread') else 0)
                cases += 1
        http = OfflineHTTP(FUNCTIONS[0], missing=True)
        try:
            run(argv_fixture[0], http)
        except Exception as error:
            assert 'runtime' in str(error).lower(), str(error)
        else:
            raise AssertionError('Missing function must fail closed without --runtime')
        assert [c['stage'] for c in http.calls] == ['preread', 'runtimes']
        assert not http.applied
        cases += 1
        # A missing post-read can return None without an SDK exception. This
        # is not proof of success: the caller must reject empty/null output.
        http = OfflineHTTP(FUNCTIONS[0], failure='postread-missing')
        missing_result = run(argv_fixture[0], http)
        assert missing_result in (None, []), missing_result
        assert http.applied and http.function_reads == 2
        assert sum(c['stage'] == 'patch' for c in http.calls) == 1
        cases += 1
        http = OfflineHTTP(FUNCTIONS[0], failure='patch-applied-interrupt')
        try:
            run(argv_fixture[0], http)
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError('Interrupted PATCH cannot claim success even when it was applied')
        assert http.applied and http.function_reads == 1
        assert [c['stage'] for c in http.calls][-1] == 'patch'
        assert sum(c['stage'] == 'patch' for c in http.calls) == 1
        cases += 1
        # Keep the official SDK retry behavior visible. A transient HTTP 500
        # may repeat the same PATCH even if the first attempt was applied.
        http = OfflineHTTP(FUNCTIONS[0], failure='patch-applied-transient')
        assert run(argv_fixture[0], http) == http.current
        patches = [c for c in http.calls if c['stage'] == 'patch']
        assert len(patches) == 2 and patches[0] == patches[1]
        assert sum(c['stage'] == 'upload' for c in http.calls) == 1
        cases += 1
        # Regression: gcloud's archive walker passes '.' to its real ignore
        # predicate. The Firebase-style **/.* pattern therefore drops root
        # files before individual filenames are considered.
        from googlecloudsdk.command_lib.functions import source_util
        bad_ignore = root / 'old-broken-upload.ignore'
        bad_ignore.write_text('node_modules/\n**/node_modules/\n**/.*\n*-debug.log\nprivate.json\n')
        with zipfile.ZipFile(source_util.CreateSourcesZipFile(str(root), str(tiny_source), str(bad_ignore))) as archive:
            assert 'index.js' not in archive.namelist() and 'package.json' not in archive.namelist()
            assert 'generated/engine.js' in archive.namelist()
        if capture_zip:
            assert captured_zip and capture_zip.is_file()
        assert blocked == [], blocked
        assert sorted(p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()) == original_source_files
        assert not list(config.rglob('*credentials*')), 'Test must not create credential stores'
        print(f'SDK_DEPLOY_REQUESTS_VERIFIED version=568.0.0 cases={cases} productionArgv={str(bool(fixture_path)).lower()} '
              'realParser=true realCommand=true realHttpSerialization=true realZip=true signedUpload=true '
              'exactThreeFieldMask=true preservedExistingConfig=true distinctUploadProvenance=true missingFunctionFailsClosed=true '
              'failureAndInterrupt=true ambiguousPatchAndPostread=true officialSdkRetries=true '
              'oldIgnoreRootLossReproduced=true iamWrites=0 creates=0 serviceEnables=0 networkRequests=0 credentialAccess=0')


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) not in (2, 4) or args[0] != '--sdk-root' or (len(args) == 4 and args[2] != '--argv-fixture'):
        raise SystemExit('Usage: python3 -I tests/floating-garden-ci-gcloud-sdk.test.py --sdk-root PATH [--argv-fixture PATH]')
    verify(args[1], args[3] if len(args) == 4 else None)
