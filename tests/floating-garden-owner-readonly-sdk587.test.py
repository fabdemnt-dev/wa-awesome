#!/usr/bin/env python3
"""Offline SDK587 owner-read parser/request/display qualification, no live auth.

All HTTP and metadata are synthetic. Token command tests only the command seam,
not credential loading, refresh, validity, or transport authorization.
"""
import contextlib, io, json, logging, os, runpy, socket, subprocess, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs, unquote

sys.dont_write_bytecode = True
import argparse
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sdk-root', required=True, help='Already installed trusted official Google Cloud SDK587 root; never downloaded or installed here')
SDK = Path(parser.parse_args().sdk_root).resolve(strict=True)
P, N, R = 'wa-awesome-garden-stg', '120030709276', 'asia-northeast1'
SECRET = 'FLOATING_GARDEN_INVITE_HMAC_KEY'
OWNER = 'owner@example.invalid'
RUNTIME = 'garden-trial-runtime@' + P + '.iam.gserviceaccount.com'
assert (SDK/'VERSION').read_text().strip() == '587.0.0'
class Unsafe(BaseException): pass
blocked = []
def forbid(*a, **k):
    import traceback
    blocked.append(''.join(traceback.format_stack(limit=8)))
    raise Unsafe('Forbidden live boundary')
def audit(event, args):
    if (event.startswith('socket.') and event != 'socket.gethostname') or event in ('subprocess.Popen','os.system','os.posix_spawn','os.spawn','os.exec'):
        forbid()
    if event in ('open','sqlite3.connect') and isinstance(args[0], (str, bytes)):
        if Path(os.fsdecode(args[0])).name in ('credentials.db','access_tokens.db','application_default_credentials.json'):
            forbid()
sys.addaudithook(audit)
socket.has_ipv6 = False

with tempfile.TemporaryDirectory(prefix='garden-owner-readonly-sdk587-') as tmp:
    config = Path(tmp)/'config'; config.mkdir(mode=0o700)
    os.environ.clear()
    os.environ.update(HOME=tmp, PATH='/usr/bin:/bin', COLUMNS='80', LINES='24', CLOUDSDK_CONFIG=str(config),
        CLOUDSDK_AUTH_DISABLE_CREDENTIALS='true', CLOUDSDK_CORE_CHECK_GCE_METADATA='false',
        CLOUDSDK_CORE_DISABLE_PROMPTS='false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING='true',
        CLOUDSDK_CORE_LOG_HTTP='false', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING='true',
        CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true', CLOUDSDK_PYTHON_SITEPACKAGES='0')
    # Neither project nor account is set in the environment/config.
    runpy.run_path(str(SDK/'lib/gcloud.py'), run_name='sdk_bootstrap')
    sys.modules.pop('argparse', None)
    from googlecloudsdk import gcloud_main
    from googlecloudsdk.calliope import display
    from googlecloudsdk.core import log, properties, transports as unauth
    from googlecloudsdk.core.configurations import named_configs
    from googlecloudsdk.core.credentials import store, creds, gce, gce_cache, gce_read, transports
    from googlecloudsdk.core.updater import update_manager
    from googlecloudsdk.command_lib import info_holder
    from googlecloudsdk.command_lib.auth import auth_util
    from googlecloudsdk.api_lib.util import apis
    from apitools.base.py import base_api
    import google.auth, google.auth._default, httplib2
    update_manager.UpdateManager.EnsureInstalledAndRestart = forbid
    update_manager.UpdateManager.Install = forbid
    base_api.BaseApiClient._SetCredentials = forbid
    for name in ('AvailableAccounts','AllAccounts','GetAccessToken','GetAccessTokenIfEnabled',
                 'GetFreshAccessToken','GetFreshAccessTokenIfEnabled','LoadFreshCredential','LoadIfEnabled',
                 'Load','Refresh','RefreshIfExpireWithinWindow','RefreshIfAlmostExpire'):
        setattr(store, name, forbid)
    creds.GetCredentialStore = forbid
    google.auth.default = forbid; google.auth._default.default = forbid
    apis.GetGapicClientInstance = forbid
    subprocess.Popen = forbid; subprocess.run = forbid
    info_holder.ToolsInfo._GetVersion = lambda *a: 'OFFLINE SDK TEST'
    # Deliberate guard probes stop before OS/network/credential access.
    import sqlite3
    guard_probes=0
    for operation in (socket.socket,lambda:socket.getaddrinfo('localhost',1),
                      lambda:subprocess.run(['never-execute']),
                      lambda:store.Load(),lambda:open(str(config/'credentials.db')),
                      lambda:sqlite3.connect(str(config/'access_tokens.db'))):
        prior=len(blocked)
        try: operation()
        except Unsafe: pass
        else: raise AssertionError('Guard failed')
        assert len(blocked)==prior+1
        blocked.pop(); guard_probes+=1
    token_loads, metadata_reads, requests, command_log = [], [], [], []

    # No real credential is created: static-provider identity uses a dummy
    # universe-only object. GCE metadata parser and provider callbacks are real.
    def metadata_read(uri, timeout=None):
        metadata_reads.append(uri)
        fixtures = {
            gce_read.GOOGLE_GCE_METADATA_DEFAULT_ACCOUNT_URI: OWNER,
            gce_read.GOOGLE_GCE_METADATA_ACCOUNTS_URI + '/': OWNER + '/\ndefault/\n',
            gce_read.GOOGLE_GCE_METADATA_UNIVERSE_DOMAIN_URI: 'googleapis.com',
            gce_read.GOOGLE_GCE_METADATA_PROJECT_URI: 'synthetic-wrong-default',
        }
        if uri not in fixtures: raise Unsafe('Unapproved metadata path')
        return fixtures[uri]
    with patch.object(gce_cache, 'GetOnGCE', return_value=True):
        metadata = gce._GCEMetadata()
    def synthetic_acquire(account=None):
        assert account == OWNER
        return SimpleNamespace(universe_domain='googleapis.com')
    def synthetic_token(**kwargs):
        # Effective identity is the global --account property; the command's
        # optional positional account is absent for this exact argv.
        assert properties.VALUES.core.account.Get() == OWNER
        assert kwargs['account'] in (None, OWNER)
        assert kwargs['scopes'] is None and kwargs['impersonation_lifetime'] is None
        token_loads.append('synthetic-only')
        return SimpleNamespace(token='SYNTHETIC-NOT-A-CREDENTIAL')

    class HTTP:
        connections = {}
        def __init__(self, mode='normal'): self.calls=[]; self.mode=mode
        def request(self, uri, method='GET', body=None, headers=None, **kw):
            u=urlsplit(uri); path=unquote(u.path); q=parse_qs(u.query)
            payload=json.loads(body) if body else None
            assert u.scheme == 'https'
            self.calls.append((method,u.netloc,path,q,payload))
            h=u.netloc
            if h=='cloudresourcemanager.googleapis.com' and path=='/v1/projects/'+P and method=='GET':
                value={'projectId':P,'projectNumber':N,'lifecycleState':'ACTIVE'}
            elif h=='cloudresourcemanager.googleapis.com' and path=='/v1/projects/'+P+':getIamPolicy' and method=='POST':
                assert payload=={'options':{'requestedPolicyVersion':3}}; value={'version':3,'bindings':[]}
            elif h=='iam.googleapis.com' and path=='/v1/projects/-/serviceAccounts/'+RUNTIME and method=='GET':
                value={'name':'projects/'+P+'/serviceAccounts/'+RUNTIME,'email':RUNTIME,'uniqueId':'1234567890'}
            elif h=='iam.googleapis.com' and path=='/v1/projects/-/serviceAccounts/'+RUNTIME+':getIamPolicy' and method=='POST':
                assert q.get('options.requestedPolicyVersion')==['3']; value={'version':3,'bindings':[]}
            elif h=='secretmanager.googleapis.com' and path=='/v1/projects/'+P+'/secrets/'+SECRET and method=='GET':
                value={'name':'projects/'+P+'/secrets/'+SECRET,'replication':{'automatic':{}}}
            elif h=='secretmanager.googleapis.com' and path=='/v1/projects/'+P+'/secrets/'+SECRET+':getIamPolicy' and method=='GET':
                assert q.get('options.requestedPolicyVersion')==['3']; value={'version':3,'bindings':[]}
            elif h=='secretmanager.googleapis.com' and path in ['/v1/projects/'+P+'/secrets/'+SECRET+'/versions/'+v for v in ('1','latest')] and method=='GET':
                value={'name':'projects/'+P+'/secrets/'+SECRET+'/versions/1','state':'ENABLED'}
            elif h=='artifactregistry.googleapis.com' and path=='/v1/projects/'+P+'/locations/'+R+'/repositories' and method=='GET': value={'repositories':[]}
            elif h=='serviceusage.googleapis.com' and path=='/v1/projects/'+P+'/services' and method=='GET':
                assert q.get('filter')==['state:ENABLED']; value={'services':[]}
            elif h=='cloudfunctions.googleapis.com' and path=='/v2/projects/'+P+'/locations/'+R+'/functions' and method=='GET':
                assert q.get('pageSize')==['100']
                page=q.get('pageToken',[None])[0]; assert page in (None,'synthetic-page-2')
                if page and self.mode=='late-denial':
                    return httplib2.Response({'status':'403','content-type':'application/json'}),json.dumps({'error':{'code':403,'status':'PERMISSION_DENIED','message':'synthetic'}}).encode()
                value={'functions':[{'name':f'projects/{P}/locations/{R}/functions/synthetic'+('2' if page else '1'),'environment':'GEN_2','state':'ACTIVE'}]}
                if not page: value['nextPageToken']='synthetic-page-2'
                elif self.mode=='unreachable': value['unreachable']=[R]
            else: raise Unsafe('Unapproved HTTP method/path')
            return httplib2.Response({'status':'200','content-type':'application/json'}),json.dumps(value).encode()

    common=['--project='+P,'--billing-project='+P,'--verbosity=error','--format=json']
    def run(args, owner=False, mode='normal', warning=False, raw=False):
        argv=args+[x for x in common if not (raw and x.startswith('--format='))]
        if owner: argv+=['--account='+OWNER]
        if warning: argv=[x for x in argv if not x.startswith('--verbosity=')]+['--verbosity=warning']
        cli=gcloud_main.CreateCLI([]); named_configs.FLAG_OVERRIDE_STACK.PushFromArgs(argv); properties.VALUES.PushInvocationValues()
        http=HTTP(mode); output=io.StringIO(); errors=io.StringIO()
        try:
            parsed=cli.top_element._parser.parse_args(argv)
            if parsed.CONCEPT_ARGS is not None: parsed.CONCEPT_ARGS.ParseConcepts()
            assert properties.VALUES.core.project.Get()==P
            assert properties.VALUES.billing.quota_project.Get()==P
            assert not properties.VALUES.core.disable_prompts.GetBool()
            if owner: assert properties.VALUES.core.account.Get()==OWNER
            command=parsed._GetCommand(); instance=command._common_type(cli=cli,context={})
            log.SetVerbosity(logging.WARNING if warning else logging.ERROR)
            with patch.object(transports,'GetApitoolsTransport',return_value=http), patch.object(unauth,'GetApitoolsTransport',return_value=http), patch.object(log,'out',output), patch.object(log.status,'Print'), patch.object(log._log_manager.stderr_handler,'stream',errors), patch.object(sys,'stdin',io.StringIO('n\n'*100)), contextlib.redirect_stderr(errors):
                result=instance.Run(parsed)
                display.Displayer(instance,parsed,result,display_info=command.ai.display_info).Display()
            command_log.append({'argv':argv,'synthetic_http':len(http.calls)})
            return (output.getvalue().strip() if raw else json.loads(output.getvalue())),errors.getvalue(),http.calls
        finally:
            requests.extend(http.calls)
            properties.VALUES.PopInvocationValues(); named_configs.FLAG_OVERRIDE_STACK.Pop()

    empty_store=SimpleNamespace(GetAccountsWithUniverseDomain=lambda:{})
    with patch.object(gce,'Metadata',return_value=metadata), patch.object(gce_read,'ReadNoProxy',side_effect=metadata_read), patch.object(creds,'GetCredentialStore',return_value=empty_store), patch.object(store,'AcquireFromGCE',side_effect=synthetic_acquire), patch.object(auth_util,'LoadCredentialsWithScopes',side_effect=synthetic_token):
        provider=store.GceCredentialProvider(); provider.Register()
        try:
            version,_,_=run(['version']); assert version['Google Cloud SDK']=='587.0.0'
            configuration,_,_=run(['config','list','--all'])
            assert configuration['core']['account'] is None
            assert configuration['core']['project']==P
            assert configuration['auth'].get('credential_file_override') is None
            assert not any(configuration['proxy'].values())
            # Config --all preserves set hidden credential overrides, endpoints
            # and proxy values; absent/unset hidden keys are not equivalent to
            # an unsafe value. Values below are inert synthetic strings only.
            config_cases=[
                ('CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','auth','credential_file_override','/synthetic-do-not-open'),
                ('CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT','auth','impersonate_service_account','synthetic@example.invalid'),
                ('CLOUDSDK_AUTH_ACCESS_TOKEN_FILE','auth','access_token_file','/synthetic-do-not-open'),
                ('CLOUDSDK_AUTH_LOGIN_CONFIG_FILE','auth','login_config_file','/synthetic-do-not-open'),
                ('CLOUDSDK_PROXY_ADDRESS','proxy','address','synthetic.invalid'),
                ('CLOUDSDK_API_ENDPOINT_OVERRIDES_CLOUDFUNCTIONS','api_endpoint_overrides','cloudfunctions','https://synthetic.invalid/'),
            ]
            for key,section,prop,value in config_cases:
                os.environ[key]=value
                try:
                    rendered,_,calls=run(['config','list','--all'])
                    assert rendered[section][prop]==value and not calls
                finally: del os.environ[key]
            # Explicit project/billing flags supersede wrong configured defaults.
            os.environ['CLOUDSDK_CORE_PROJECT']='synthetic-wrong-default'
            try:
                rendered,_,_=run(['config','list','--all'])
                assert rendered['core']['project']==P
            finally: del os.environ['CLOUDSDK_CORE_PROJECT']
            # Preserve metadata discovery rather than overriding core.account.
            os.environ['CLOUDSDK_CORE_CHECK_GCE_METADATA']='true'
            metadata_config,_,_=run(['config','list','--all'])
            assert metadata_config['core']['account']==OWNER
            assert metadata_config['core']['project']==P
            identities,_,_=run(['auth','list','--filter=status:ACTIVE'])
            assert identities==[{'account':OWNER,'status':'ACTIVE'}],identities
            pinned_config,_,_=run(['config','list','--all'],owner=True)
            pinned_identities,_,_=run(['auth','list','--filter=status:ACTIVE'],owner=True)
            assert pinned_config['core']['account']==OWNER and pinned_identities==identities
            assert not any('/token' in x or '/identity' in x for x in metadata_reads)
            assert gce_read.GOOGLE_GCE_METADATA_DEFAULT_ACCOUNT_URI in metadata_reads
            assert gce_read.GOOGLE_GCE_METADATA_PROJECT_URI not in metadata_reads
            token,_,_=run(['auth','print-access-token'],owner=True,raw=True)
            assert token=='SYNTHETIC-NOT-A-CREDENTIAL' and len(token_loads)==1
            commands=[['projects','describe',P],['projects','get-iam-policy',P],
                ['iam','service-accounts','describe',RUNTIME],['iam','service-accounts','get-iam-policy',RUNTIME],
                ['secrets','describe',SECRET],['secrets','get-iam-policy',SECRET],
                ['secrets','versions','describe','1','--secret='+SECRET],['secrets','versions','describe','latest','--secret='+SECRET],
                ['artifacts','repositories','list','--location='+R],['services','list','--enabled']]
            for args in commands:
                _,_,calls=run(args,owner=True); assert calls
            inventory=['functions','list','--v2','--regions='+R,'--limit=1000']
            values,errors,calls=run(inventory,owner=True,warning=True)
            assert len(values)==2 and len(calls)==2 and not errors
            assert calls[1][3]['pageToken']==['synthetic-page-2']
            values,errors,calls=run(inventory,owner=True,warning=True,mode='unreachable')
            assert len(values)==2 and len(calls)==2
            assert 'The following regions were fully or partially unreachable' in errors
            values,errors,_=run(inventory,owner=True,mode='unreachable')
            assert len(values)==2 and not errors  # --verbosity=error hides incompleteness!
            try: run(inventory,owner=True,warning=True,mode='late-denial')
            except Exception as exc: assert '403' in str(exc)
            else: raise AssertionError('Late page denial accepted')
        finally: provider.UnRegister()
    assert not blocked,blocked
    assert not list(config.rglob('*credentials*')) and not list(config.rglob('*access_tokens*'))
    print(json.dumps({'sdk':'587.0.0','offline':True,'real_parser_command_request_display':True,
        'commands':command_log,'synthetic_http_requests':len(requests),'synthetic_metadata_reads':len(metadata_reads),
        'unset_config_and_explicit_project_billing_pin':True,'synthetic_metadata_owner_discovery':True,
        'config_override_rendering_cases':len(config_cases),
        'verified_boundary_guard_probes':guard_probes,
        'token_command_synthetic_loader_only':True,'function_two_page_and_late_denial':True,
        'functions_unreachable_requires_warning_verbosity':True,
        'function_list_tests_optional_not_entry_qualification':True,
        'real_network':0,'real_credentials':0,'subprocesses':0,'deploy_qualification':False,
        'authenticated_route_qualified':False},indent=2))
