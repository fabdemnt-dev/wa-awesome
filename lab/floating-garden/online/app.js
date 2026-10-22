import { createOnlineController } from './controller.js?v=20261002-online-1';
import { mountOnline } from './mount.js?v=20261002-online-1';
import { localTestAllowed } from './config.js?v=20261002-online-1';
import { escape } from './view.js?v=20261002-online-1';

const root = document.querySelector('#online-app');
if (root) {
  if (!localTestAllowed(location)) root.innerHTML = '<section class="panel"><h2>ローカル検証版です</h2><p>オンライン版の本番公開はまだ行っていません。このページから本番サービスへの接続は行いません。</p></section>';
  else {
    try {
      const { createFirebaseTransport } = await import('./firebase.js?v=20261002-online-1');
      const transport = await createFirebaseTransport(location);
      let storage = null;
      try { storage = localStorage; } catch { /* Controller explains why durable confirmation is unavailable. */ }
      mountOnline(root, { controller: createOnlineController({ ...transport, storage, isOnline: () => navigator.onLine !== false }) });
    } catch (error) { root.innerHTML = `<section class="panel"><h2>検証用の接続を開始できません</h2><p>${escape(error.message)}</p><p>ローカルのAuth・Firestore・Functionsエミュレーターを起動して、ページを再読み込みしてください。</p></section>`; }
  }
}
