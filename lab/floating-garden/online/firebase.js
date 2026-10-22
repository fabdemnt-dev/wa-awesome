import { EMULATOR_CONFIG, EMULATOR_PORTS, localTestAllowed } from './config.js?v=20261002-online-1';

export async function createFirebaseTransport(location = globalThis.location) {
  if (!localTestAllowed(location)) throw new Error('本番接続は無効です。ローカル検証環境だけで利用できます');
  // The gate runs before even loading the SDK. A demo project is initialized directly.
  const [appSdk, authSdk, firestoreSdk, functionsSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js'),
  ]);
  const name = 'floating-garden-online-local';
  const app = appSdk.getApps().find((item) => item.name === name) || appSdk.initializeApp(EMULATOR_CONFIG, name);
  const auth = authSdk.getAuth(app);
  const db = firestoreSdk.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const functions = functionsSdk.getFunctions(app, 'asia-northeast1');
  authSdk.connectAuthEmulator(auth, `http://127.0.0.1:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
  firestoreSdk.connectFirestoreEmulator(db, '127.0.0.1', EMULATOR_PORTS.firestore);
  functionsSdk.connectFunctionsEmulator(functions, '127.0.0.1', EMULATOR_PORTS.functions);
  let authFlight = null;
  const names = { create: 'floatingGardenCreateRoom', join: 'floatingGardenJoinRoom', start: 'floatingGardenStartMatch', getSnapshot: 'floatingGardenGetSnapshot', submit: 'floatingGardenSubmitAction' };
  const api = Object.fromEntries(Object.entries(names).map(([method, callable]) => [method, async (payload) => (await functionsSdk.httpsCallable(functions, callable, { timeout: 15000 })(payload)).data]));
  return {
    api,
    ensureUser() {
      authFlight ||= (async () => { await auth.authStateReady(); if (auth.currentUser) return auth.currentUser; return (await authSdk.signInAnonymously(auth)).user; })().finally(() => { authFlight = null; });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('認証の応答を待っています。接続を確認してください'), { code: 'deadline-exceeded' })), 12000);
        authFlight.then((user) => { clearTimeout(timer); resolve(user); }, (error) => { clearTimeout(timer); reject(error); });
      });
    },
    subscribe(roomId, next, error) {
      return firestoreSdk.onSnapshot(firestoreSdk.doc(db, 'floatingGardenRooms', roomId), { includeMetadataChanges: true }, (snapshot) => next({ room: snapshot.exists() ? snapshot.data() : null, fromCache: snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites }), error);
    },
  };
}
