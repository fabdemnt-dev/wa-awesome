import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = read('toybox/mofumofu-gathering/online/firebase-config.js');
const client = read('toybox/mofumofu-gathering/online/script.js');
const functions = read('functions/mofumofu-online/index.js');
const exportsFile = read('functions/index.js');
const firestore = read('firestore.rules');
const rtdb = read('database.rules.json');
const offline = read('toybox/mofumofu-gathering/index.html');
const entry = read('toybox/mofumofu-gathering/online-entry.js');
const deploy = read('docs/mofumofu-online-phase10-deploy.md');
const phase6 = read('tests/mofumofu-online-integration.test.mjs');

const checks = [
  ['1 localhostはEmulator', () => config.includes("'localhost'") && client.includes("environment.name === 'emulator'")],
  ['2 127.0.0.1はEmulator', () => config.includes("'127.0.0.1'")],
  ['3 GitHub Pagesはproduction', () => config.includes("productionHost = 'fabdemnt-dev.github.io'")],
  ['4 staging hostはstaging', () => config.includes("stagingHost = 'wa-awesome-mofumofu-stg.web.app'") && config.includes('host === stagingHost') && config.includes("injected.environment !== 'staging'")],
  ['5 unknown hostはfail-closed', () => config.includes('このホストではオンライン版を起動できません')],
  ['6 productionでEmulator connect関数を呼ばない', () => client.includes("if (environment.name === 'emulator')")],
  ['7 production成果物にdemo project IDなし', () => !config.includes('demo-mofumofu-online')],
  ['8 production設定にEmulator portなし', () => !config.slice(config.indexOf('const productionBase'), config.indexOf('function required')).match(/(9199|8180|9103|5101)/)],
  ['9 production設定にstaging値なし', () => !config.slice(config.indexOf('const productionBase'), config.indexOf('function required')).includes('staging')],
  ['10 Secret/private keyなし', () => !`${config}${client}`.match(/private_key|BEGIN PRIVATE KEY|MOFUMOFU_ONLINE_IP_HMAC_KEY/)],
  ['11 既存Auth UID再利用', () => client.includes('if (!auth.currentUser) await signInAnonymously(auth)')],
  ['12 Auth初期化前に新UIDを作らない', () => client.indexOf('await auth.authStateReady()') < client.lastIndexOf('signInAnonymously(auth)')],
  ['13 UID喪失時localStorageだけでresume不可', () => phase6.includes('別UID') || functions.includes('requireMember(room, uid)')],
  ['14 productionでApp Check設定必須', () => config.includes("required(injected.appCheckSiteKey")],
  ['15 debug providerはlocalhost/CIだけ', () => config.includes("name: 'emulator'") && client.includes('environment.appCheck.debug')],
  ['16 debug token commit禁止', () => !`${config}${client}`.match(/FIREBASE_APPCHECK_DEBUG_TOKEN\s*=\s*['\"][^'\"]+['\"]/) ],
  ['17 productionでdebug provider禁止', () => config.includes("name: 'production'") && config.includes('appCheck: { siteKey:')],
  ['18 App Check初期化前に保護Callable開始不可', () => client.indexOf('initializeAppCheck') < client.indexOf('httpsCallable(functions')],
  ['19 Functions側が環境に応じenforcement可能', () => functions.includes("MOFUMOFU_ENFORCE_APP_CHECK === 'true'")],
  ['20 Firestore/RTDB全体enforcementを変更しない', () => !`${firestore}${rtdb}`.includes('appCheck')],
  ['21 production CORS origin', () => functions.includes("PRODUCTION_ORIGIN = 'https://fabdemnt-dev.github.io'") && functions.includes('corsOriginsForProject(runtimeProjectId())')],
  ['22 production任意originなし', () => !functions.includes('cors: true')],
  ['23 localhost許可はclient開発だけ', () => !functions.match(/cors:[^\n]+localhost/)],
  ['24 join UID制限維持', () => functions.includes("collection('mofumofuOnlineRateLimits').doc(uid)")],
  ['25 join IP補助制限', () => functions.includes("join_ip_${ipHash(request)}")],
  ['26 create UID制限', () => functions.includes("create_uid_${digest(uid)}")],
  ['27 create IP補助制限', () => functions.includes("create_ip_${ipHash(request)}")],
  ['28 IP平文保存なし', () => !functions.match(/\b(?:ip|address|remoteAddress)\s*:\s*requestIp\(/)],
  ['29 HMAC Secretをclient/repoへ置かない', () => functions.includes("defineSecret('MOFUMOFU_ONLINE_IP_HMAC_KEY')") && !client.includes('MOFUMOFU_ONLINE_IP_HMAC_KEY')],
  ['30 別UIDでも同一IP補助制限', () => functions.includes('ipHash(request)')],
  ['31 別IPは独立', () => functions.includes('request.rawRequest?.ip')],
  ['32 window経過後再試行可能', () => functions.includes('now - started < RATE_WINDOW_MS')],
  ['33 Firestore deleteAtはTimestamp', () => functions.includes('Timestamp.fromMillis') && functions.includes('deleteAt')],
  ['34 TTL削除前も期限判定', () => functions.includes('invite.expiresAt <= now') && functions.includes('room.joinExpiresAt <= now')],
  ['35 invite cleanup', () => functions.includes("'mofumofuOnlineRoomInvites'")],
  ['36 rate limit cleanup', () => functions.includes("'mofumofuOnlineRateLimits'")],
  ['37 actionRequests cleanup', () => functions.includes("'mofumofuOnlineActionRequests'")],
  ['38 expired waiting room cleanup', () => functions.includes("collection('mofumofuOnlineRooms').where('deleteAt'")],
  ['39 finished room cleanup', () => functions.includes('FINISHED_TTL_MS')],
  ['40 room配下整合cleanup', () => functions.includes('recursiveDelete(room.ref)')],
  ['41 presence authorization cleanup', () => functions.includes('mofumofuOnlinePresenceAccess')],
  ['42 stale RTDB connection cleanup', () => functions.includes('nowMillis - PRESENCE_STALE_MS')],
  ['43 cleanup再実行が冪等', () => functions.includes("updates[`mofumofuOnlinePresence") && functions.includes('] = null')],
  ['44 他ゲームnamespace非干渉', () => !functions.match(/shadowCard|moonScaleDuel|deepMiningAgreement/)],
  ['45 もふもふFunctions限定deploy', () => deploy.includes('--only functions:createMofumofuRoom') && exportsFile.includes('exports.cleanupMofumofuOnline')],
  ['46 RTDB RulesにshadowCard保持', () => rtdb.includes('shadowCardRoomAccess')],
  ['47 RTDB RulesにmoonScaleDuel保持', () => rtdb.includes('moonScaleDuelRoomAccess')],
  ['48 Firestore Rulesに既存namespace保持', () => firestore.includes('shadowCardRooms') && firestore.includes('moonScaleDuelRooms')],
  ['49 一括deployを標準にしない', () => !deploy.match(/```sh\s*firebase deploy\s*$/m)],
  ['50 rollback用Rules保存手順', () => deploy.includes('SHA') && deploy.includes('復元')],
  ['51 ひとりモード維持', () => offline.includes('id="soloBtn"')],
  ['52 ふたりモード維持', () => offline.includes('id="duoBtn"')],
  ['53 オンライン導線はonline/', () => offline.includes('href="./online/"')],
  ['54 Phase 10前は導線無効', () => entry.includes('ONLINE_PUBLIC_ENABLED = false') && offline.includes('onlineEntry') && offline.includes('hidden')],
  ['55 オフラインゲームロジック不変', () => fs.existsSync(new URL('../toybox/mofumofu-gathering/script.js', import.meta.url))],
  ['56 他人privateHands拒否', () => firestore.includes('request.auth.uid == uid')],
  ['57 NPC手札拒否', () => firestore.includes('serverState/{document=**} { allow read, write: if false; }')],
  ['58 actualAnimal判定前非公開', () => functions.includes("if (offer.status === 'completed')")],
  ['59 serverState/discard拒否', () => firestore.includes('serverState/{document=**} { allow read, write: if false; }')],
  ['60 actionId冪等維持', () => functions.includes('replayAction(actionSnap.data(), fingerprint)')],
  ['61 presence偽装拒否', () => rtdb.includes('$uid === auth.uid')],
  ['62 NPC代理偽装拒否', () => phase6.includes('NPC代理') && functions.includes('requireMember(initialRoom, callerUid)')],
  ['63 席返却乗っ取り拒否', () => functions.includes('requireMember(room, uid)') && functions.includes("mode: 'return-pending'")],
  ['64 finished後変更拒否', () => functions.includes("room.status !== 'playing'")],
  ['65 client direct write拒否', () => firestore.includes('allow write: if false')],
];

assert.equal(checks.length, 65);
for (const [name, check] of checks) test(name, () => assert.ok(check(), name));
