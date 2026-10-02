import { createOnlineController, ONLINE_SAVE_KEY } from '../online/controller.js?v=20261002-online-1';
import { mountOnline } from '../online/mount.js?v=20261002-online-1';
import { escape } from '../online/view.js?v=20261002-online-1';
import { resolveTrialEnvironment } from './config.js';
import { createTrialFirebaseTransport } from './firebase.js';

// Dedicated namespacing keeps trial recovery separate even when inspecting a copied
// build. The immutable PR365 controller still owns every durable request and retry.
export function trialRecoveryKey(projectId) { return `floating-garden-trial:${projectId}:${ONLINE_SAVE_KEY}`; }
export function createTrialStorage(storage, projectId) {
  return storage && { getItem: (key) => storage.getItem(key === ONLINE_SAVE_KEY ? trialRecoveryKey(projectId) : key), setItem: (key, value) => storage.setItem(key === ONLINE_SAVE_KEY ? trialRecoveryKey(projectId) : key, value) };
}
export async function bootstrapTrial(root, statusRoot, runtime, {
  location = globalThis.location, now = () => Date.now(), transportFactory = createTrialFirebaseTransport,
  makeController = createOnlineController, mount = mountOnline,
} = {}) {
  const config = resolveTrialEnvironment(runtime, location, now());
  const document = root.ownerDocument, page = document.defaultView;
  let controller = null, mounted = null, transport = null, uid = null, blocked = false, accessDenied = false;
  function showStatus() {
    if (!statusRoot) return;
    statusRoot.innerHTML = `<section class="panel trial-status"><h2>7日以内・2人限定の専用試験</h2><p>${blocked ? '試験の利用期間または配信元を確認できないため停止しました。確認待ちの操作は消さずに保存しています。' : accessDenied ? 'この操作はサーバーに拒否されました。参加登録の有効期限・このUIDの登録・部屋の参加者を管理者に確認してください。' : '匿名認証だけでは参加できません。管理者が登録した2人のみ、サーバーが部屋の利用を許可します。'}</p>${uid ? `<label for="trial-own-uid">このブラウザーの匿名UID（参加登録の確認用）</label><input id="trial-own-uid" value="${escape(uid)}" readonly autocomplete="off" spellcheck="false"><p>UIDは登録担当者にだけ渡してください。認証トークンの共有は不要です。データ消去や別ブラウザーへの変更では元の席に戻れません。</p>` : '<p>匿名UIDを確認しています…</p>'}<p>試験終了: ${escape(new Date(config.endsAtMillis).toLocaleString('ja-JP'))} · 上限20部屋</p></section>`;
  }
  const stop = () => {
    if (blocked) return;
    blocked = true; controller?.suspend(); showStatus();
    // The existing view intentionally keeps pending recovery data visible. Freeze
    // its entire interaction surface, including a stale click queued before expiry.
    root.inert = true; root.setAttribute('aria-disabled', 'true');
  };
  try {
    showStatus();
    transport = await transportFactory(config, location, { now, onIdentity(value) { uid = value; showStatus(); }, onBlocked: stop, onAccessDenied() { accessDenied = true; showStatus(); } });
    if (blocked || !transport.isActive()) { stop(); transport.dispose(); return null; }
    let rawStorage = null;
    try { rawStorage = page.localStorage; } catch { /* Shared controller blocks unsafe confirmations. */ }
    controller = makeController({ ...transport, storage: createTrialStorage(rawStorage, config.projectId), isOnline: () => !blocked && transport.isActive() && page.navigator.onLine !== false });
    // A successful anonymous sign-in is not evidence of tester enrollment.
    const getState = controller.getState;
    controller.getState = () => {
      const state = getState();
      if (!state.room && state.connection === 'ready') state.connection = '匿名認証済み · 参加資格は操作ごとにサーバーが確認します';
      return state;
    };
    mounted = mount(root, { controller });
    const onStorage = (event) => { if (event.key === trialRecoveryKey(config.projectId)) controller.storageChanged(); };
    page.addEventListener('storage', onStorage);
    return { controller, transport, ready: mounted.ready, unmount() { page.removeEventListener('storage', onStorage); mounted.unmount(); transport.dispose(); } };
  } catch (error) { transport?.dispose(); mounted?.unmount(); throw error; }
}
