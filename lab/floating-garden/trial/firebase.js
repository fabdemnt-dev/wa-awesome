import { resolveTrialEnvironment, assertTrialAccess } from './config.js';

export const CALLABLE_TIMEOUT_MILLIS = 15000;
const AUTH_TIMEOUT_MILLIS = 12000;
const CALLABLE_NAMES = Object.freeze({ create: 'floatingGardenCreateRoom', join: 'floatingGardenJoinRoom', start: 'floatingGardenStartMatch', getSnapshot: 'floatingGardenGetSnapshot', submit: 'floatingGardenSubmitAction' });
const failure = (message, reason, code = 'unavailable') => Object.assign(new Error(message), { code, details: { reason } });
// This loader is never called until the complete config, origin, and time gate passes.
export async function loadTrialFirebaseSdk() {
  const [appSdk, appCheckSdk, authSdk, firestoreSdk, functionsSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js'),
  ]);
  return { appSdk, appCheckSdk, authSdk, firestoreSdk, functionsSdk };
}

/** SDK injection is for offline unit tests only; entry always uses the pinned loader. */
export async function createTrialFirebaseTransport(runtime, location = globalThis.location, {
  loadSdk = loadTrialFirebaseSdk, now = () => Date.now(), environment = globalThis,
  setTimer = setTimeout, clearTimer = clearTimeout, onIdentity = () => {}, onBlocked = () => {}, onAccessDenied = () => {},
} = {}) {
  const config = resolveTrialEnvironment(runtime, location, now());
  if (Object.hasOwn(environment, 'FIREBASE_APPCHECK_DEBUG_TOKEN')) throw failure('App Checkのデバッグ設定があるため接続を開始できません', 'debug-provider-blocked');
  let stopped = false, app = null, appCheck = null, db = null, expiryTimer = null, authFlight = null, identity = null;
  const subscriptions = new Set();
  let sdk;
  const deadline = (promise, milliseconds, reason) => new Promise((resolve, reject) => {
    const timer = setTimer(() => reject(failure('通信の結果を確認できません。保存した操作を消さずに再接続してください', reason, 'deadline-exceeded')), milliseconds);
    Promise.resolve(promise).then((value) => { clearTimer(timer); resolve(value); }, (error) => { clearTimer(timer); reject(error); });
  });
  function preserveUnconfirmedAccess(error) {
    const code = String(error?.code || '').replace(/^functions\//, '');
    const reason = error?.details?.reason;
    // Firebase Auth/App Check middleware rejects before our handler and supplies
    // no trial reason. Neither that refusal nor an authorization change proves a
    // previously sent request was not committed. Keep its original durable ID.
    if (['unauthenticated', 'permission-denied'].includes(code) || (typeof reason === 'string' && reason.startsWith('trial-'))) {
      onAccessDenied(reason || code);
      return failure('認証・参加登録または試験設定を確認できません。確認待ちの操作は保存しています', reason || `trial-${code}`);
    }
    return error;
  }
  function dispose() {
    if (stopped) return;
    stopped = true; clearTimer(expiryTimer);
    for (const stop of [...subscriptions]) stop();
    if (appCheck) sdk.appCheckSdk.setTokenAutoRefreshEnabled(appCheck, false);
    if (db) Promise.resolve(sdk.firestoreSdk.disableNetwork(db)).catch(() => {});
    if (app) Promise.resolve(sdk.appSdk.deleteApp(app)).catch(() => {});
    // Deliberately do not sign out or clear Auth/recovery storage.
  }
  function assertActive() {
    try {
      if (stopped) throw new Error('stopped');
      assertTrialAccess(config, location, now());
    } catch {
      dispose();
      onBlocked();
      // NOT a definitive refusal: an older in-flight command might have committed.
      throw failure('試験の利用期間または配信元を確認できません。確認待ちの操作は保存したまま停止しています', 'trial-access-ended');
    }
  }
  try {
    sdk = await loadSdk();
    assertActive();
    const { appSdk, appCheckSdk, authSdk, firestoreSdk, functionsSdk } = sdk;
    const appName = `floating-garden-trial-${config.projectId}`;
    if (appSdk.getApps().some((item) => item.name === appName)) throw failure('試験接続がすでに存在します。ページを再読み込みしてください', 'duplicate-app-blocked');
    app = appSdk.initializeApp(config.firebase, appName);
    appCheck = appCheckSdk.initializeAppCheck(app, { provider: new appCheckSdk.ReCaptchaEnterpriseProvider(config.appCheck.siteKey), isTokenAutoRefreshEnabled: true });
    // Verify attestation before anonymous Auth or any game connection. Never fallback.
    const attestation = await deadline(appCheckSdk.getToken(appCheck, false), AUTH_TIMEOUT_MILLIS, 'app-check-timeout');
    assertActive();
    if (!attestation || typeof attestation.token !== 'string' || !attestation.token) throw failure('App Checkを確認できませんでした', 'app-check-required');
    const auth = authSdk.getAuth(app);
    db = firestoreSdk.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
    const functions = functionsSdk.getFunctions(app, config.region);
    const persistenceReady = deadline(authSdk.setPersistence(auth, authSdk.browserLocalPersistence), AUTH_TIMEOUT_MILLIS, 'auth-persistence-timeout');
    await persistenceReady; assertActive();
    expiryTimer = setTimer(() => { dispose(); onBlocked(); }, Math.max(0, config.endsAtMillis - now()));
    const api = Object.fromEntries(Object.entries(CALLABLE_NAMES).map(([method, name]) => {
      const callable = functionsSdk.httpsCallable(functions, name, { timeout: CALLABLE_TIMEOUT_MILLIS });
      return [method, async (payload) => {
        assertActive();
        if (!identity || auth.currentUser?.uid !== identity.uid || auth.currentUser?.isAnonymous !== true) throw failure('参加時の匿名認証を確認できません', 'identity-mismatch');
        try {
          const result = await deadline(callable(payload), CALLABLE_TIMEOUT_MILLIS, 'callable-timeout');
          assertActive();
          return result.data;
        } catch (error) { throw preserveUnconfirmedAccess(error); }
      }];
    }));
    return {
      config, api,
      isActive() { try { assertActive(); return true; } catch { return false; } },
      ensureUser() {
        try { assertActive(); } catch (error) { return Promise.reject(error); }
        if (!authFlight) {
          // Keep the underlying sign-in single-flight even when one caller's
          // wait times out. A new caller must not create a second anonymous UID.
          authFlight = (async () => {
            await auth.authStateReady(); assertActive();
            if (identity && !auth.currentUser) throw failure('参加時の匿名認証が失われています。元の認証を確認してください', 'identity-missing');
            const user = auth.currentUser || (await authSdk.signInAnonymously(auth)).user;
            assertActive();
            if (!user?.uid || user.isAnonymous !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(user.uid)) throw failure('この試験には同じブラウザーの匿名認証が必要です', 'non-anonymous-identity');
            if (identity && identity.uid !== user.uid) throw failure('参加時と異なる認証です', 'identity-mismatch');
            identity = Object.freeze({ uid: user.uid });
            onIdentity(identity.uid); // UID only; tokens and user objects are never rendered.
            return identity;
          })().catch((error) => { throw preserveUnconfirmedAccess(error); }).finally(() => { authFlight = null; });
        }
        return deadline(authFlight, AUTH_TIMEOUT_MILLIS, 'auth-timeout');
      },
      subscribe(roomId, next, error) {
        assertActive();
        if (!identity || auth.currentUser?.uid !== identity.uid || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) throw failure('部屋と認証を確認できません', 'invalid-subscription', 'permission-denied');
        let live = true, unsubscribe = () => {};
        const stop = () => { if (!live) return; live = false; subscriptions.delete(stop); unsubscribe(); };
        unsubscribe = firestoreSdk.onSnapshot(firestoreSdk.doc(db, 'floatingGardenRooms', roomId), { includeMetadataChanges: true }, (snapshot) => {
          if (!live) return;
          try { assertActive(); } catch (problem) { stop(); error?.(problem); return; }
          next({ room: snapshot.exists() ? snapshot.data() : null, fromCache: snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites });
        }, (problem) => { if (!live) return; stop(); error?.(problem); });
        subscriptions.add(stop);
        return stop;
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
