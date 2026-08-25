import { app } from './firebase-config.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';

const auth = getAuth(app);
const functions = getFunctions(app, 'asia-northeast1');

let signedInUser = null;
let signInPromise = null;

export function ensureSignedIn() {
  if (signedInUser) return Promise.resolve(signedInUser);
  if (signInPromise) return signInPromise;

  signInPromise = new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        signedInUser = user;
        try {
          await user.getIdToken(true);
          unsubscribe();
          resolve(user);
        } catch (error) {
          unsubscribe();
          reject(error);
        }
        return;
      }

      try {
        const credential = await signInAnonymously(auth);
        signedInUser = credential.user;
        await credential.user.getIdToken(true);
        unsubscribe();
        resolve(credential.user);
      } catch (error) {
        unsubscribe();
        reject(error);
      }
    });
  }).catch((error) => {
    signInPromise = null;
    throw error;
  });

  return signInPromise;
}

async function call(name, data) {
  await ensureSignedIn();
  const callable = httpsCallable(functions, name);
  const result = await callable(data);
  return result.data;
}

export function saveWordSetSecurely(data) {
  return call('saveWordSet', data);
}

export function deleteWordSetSecurely(data) {
  return call('deleteWordSet', data);
}

export function userFacingError(error) {
  switch (error?.code) {
    case 'functions/permission-denied':
      return error.message || 'パスワードが一致しないため、変更できませんでした。';
    case 'functions/unauthenticated':
    case 'functions/failed-precondition':
      return '接続の準備に失敗しました。ページを再読み込みして、もう一度お試しください。';
    case 'functions/unavailable':
      return '保護機能に接続できません。Firebaseの設定が完了しているか確認してください。';
    default:
      return error?.message || '保存に失敗しました。';
  }
}
