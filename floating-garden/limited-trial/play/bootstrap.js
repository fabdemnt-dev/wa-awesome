import { parseEntryMode } from '../online/entry-mode.js';
import { THREE_HUMAN_MODES_READY, FOUR_HUMAN_MODES_READY } from '../online/runtime-modes.js?v=20261022-human4-1';
import { createOnlineController, ONLINE_SAVE_KEY, ONLINE_PARKED_KEY } from '../online/controller.js?v=20261023-shared-objectives-1';
import { mountOnline } from '../online/mount.js?v=20261023-shared-objectives-1';
import { escape } from '../online/view.js?v=20261023-shared-objectives-1';
import { resolvePublicEnvironment, PRODUCTION_PROJECT_ID } from './config.js';
import { PUBLIC_POLICY } from './public-policy.js';
import { createTrialFirebaseTransport } from './firebase.js';

// Never read, migrate, overwrite, or remove legacy/staging recovery or sessions.
export function publicRecoveryKey(projectId, epochId) {
  if (projectId !== PRODUCTION_PROJECT_ID || epochId !== PUBLIC_POLICY.epochId) throw new Error('本番の復帰情報の保存先が一致しません');
  return `floating-garden-public:${projectId}:${epochId}:${ONLINE_SAVE_KEY}`;
}
export function createPublicStorage(storage, projectId, epochId) {
  const scopedKey = publicRecoveryKey(projectId, epochId);
  const mapKey = (key) => { if (key === ONLINE_SAVE_KEY) return scopedKey; if (key === ONLINE_PARKED_KEY) return `${scopedKey}:${ONLINE_PARKED_KEY}`; throw new Error('未対応の復帰情報キーです'); };
  return storage && Object.freeze({ getItem: (key) => storage.getItem(mapKey(key)), setItem: (key, value) => storage.setItem(mapKey(key), value) });
}
export async function bootstrapTrial(root, statusRoot, runtime, {
  location = globalThis.location, now = () => Date.now(), transportFactory = createTrialFirebaseTransport,
  makeController = createOnlineController, mount = mountOnline,
} = {}) {
  const entryMode = parseEntryMode(new URL(typeof location === 'string' ? location : location.href).hash);
  const config = resolvePublicEnvironment(runtime, location, now());
  const document = root.ownerDocument, page = document.defaultView;
  let controller = null, mounted = null, transport = null, blocked = false, disposed = false, connectFlight = null;
  let notice = '接続ボタンを押すと、このブラウザーの匿名認証で接続します。部屋を作って相手を招待するか、招待コードで参加できます。';
  const showStatus = () => {
    if (statusRoot) statusRoot.innerHTML = `<section class="panel trial-status"><h2>浮遊庭園の限定オンライン試験</h2><p>${escape(notice)}</p><p>試験用の新規枠は20部屋、部屋の期限は作成から24時間です。試験終了後は接続を停止するため、期限内でも継続できない場合があります。</p><p>同じ席に戻るには同じブラウザーを使ってください。保存情報を消すと復帰できなくなる場合があります。URLの非掲載はアクセス制限ではなく、認証条件を満たす第三者もAPIを利用できる場合があります。</p></section>`;
  };
  const stop = () => {
    blocked = true; controller?.suspend();
    notice = '接続を確認できないため停止しました。確認待ちの操作は消さずに保存しています。'; showStatus();
    root.inert = true; root.setAttribute('aria-disabled', 'true');
  };
  const onStorage = (event) => { if ([publicRecoveryKey(config.projectId, config.epochId), `${publicRecoveryKey(config.projectId, config.epochId)}:${ONLINE_PARKED_KEY}`].includes(event.key)) controller?.storageChanged(); };
  const connect = () => {
    if (disposed || blocked) return Promise.resolve(null);
    if (connectFlight) return connectFlight;
    root.innerHTML = '<section class="panel"><p>安全な接続を確認しています…</p></section>';
    connectFlight = (async () => {
      try {
        transport = await transportFactory(config, location, { now, onBlocked: stop, onAccessDenied(reason) {
          notice = /quota|capacity|drain|admission|room-limit/.test(reason || '') ? '新しい部屋の受付は停止しています。既存の招待・対局・復帰は部屋の期限まで利用できます。確認待ちの操作は保存しています。' : 'サーバーがこの操作を許可しませんでした。認証・部屋の期限・参加者を確認してください。確認待ちの操作は保存しています。'; showStatus();
        } });
        if (disposed || blocked || !transport.isActive()) { transport.dispose(); if (!disposed) stop(); return null; }
        let rawStorage = null;
        try { rawStorage = page.localStorage; } catch { /* Controller blocks unsafe confirmations. */ }
        controller = makeController({ ...transport, threeHumanModesReady: THREE_HUMAN_MODES_READY, fourHumanModesReady: FOUR_HUMAN_MODES_READY, storage: createPublicStorage(rawStorage, config.projectId, config.epochId), isOnline: () => !blocked && !disposed && transport.isActive() && page.navigator.onLine !== false });
        mounted = mount(root, { controller, initialMode: entryMode });
        page.addEventListener('storage', onStorage);
        notice = '接続しました。部屋の受付・参加資格・期限は操作ごとにサーバーが確認します。'; showStatus();
        await mounted.ready;
        return controller;
      } catch (error) {
        transport?.dispose(); mounted?.unmount();
        stop(); notice = `${error.message || '接続できませんでした'}。保存情報を消さず、ページを再読み込みして接続してください。`; showStatus();
        return null;
      }
    })();
    return connectFlight;
  };
  const onClick = (event) => { if (event.target?.closest?.('[data-public-connect]')) void connect(); };
  showStatus();
  root.innerHTML = '<section class="panel"><h2>庭園に接続</h2><p>接続するまで匿名アカウントの作成やゲーム通信は行いません。</p><button type="button" data-public-connect>接続する</button></section>';
  root.addEventListener('click', onClick);
  return { connect, get controller() { return controller; }, get transport() { return transport; }, unmount() { disposed = true; root.removeEventListener('click', onClick); page.removeEventListener('storage', onStorage); mounted?.unmount(); transport?.dispose(); } };
}
