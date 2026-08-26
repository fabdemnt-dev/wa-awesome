const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const bcrypt = require('bcryptjs');

initializeApp();
const db = getFirestore();

const callableOptions = {
  region: 'asia-northeast1',
  cors: ['https://fabdemnt-dev.github.io'],
};

function fail(code, message) {
  throw new HttpsError(code, message);
}

function requireAuthenticated(request) {
  if (!request.auth?.uid) {
    fail('unauthenticated', '編集するにはアプリへの接続が必要です。ページを再読み込みして、もう一度お試しください。');
  }
  return request.auth.uid;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label, maxLength) {
  if (typeof value !== 'string') fail('invalid-argument', `${label}を入力してください。`);
  const text = value.trim();
  if (!text || text.length > maxLength) fail('invalid-argument', `${label}は1〜${maxLength}文字で入力してください。`);
  return text;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    fail('invalid-argument', `入力内容は${maxLength}文字以内にしてください。`);
  }
  return value.trim() || null;
}

function requireWords(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    fail('invalid-argument', `${label}は1〜1000個のことばで入力してください。`);
  }
  return value.map((word) => requireText(word, label, 200));
}

function sanitizeWordSet(input) {
  if (!isPlainObject(input)) fail('invalid-argument', 'ワードセットの内容が正しくありません。');

  const type = input.type;
  if (type !== 'poem' && type !== 'haiku') {
    fail('invalid-argument', 'ワードセットの種類が正しくありません。');
  }

  const wordSet = {
    type,
    name: requireText(input.name, 'セットのなまえ', 20),
    hasPassword: input.hasPassword === true,
    // 旧データに項目がない場合は、従来どおりコピー可能として扱う。
    copyAllowed: input.copyAllowed !== false,
    icon: optionalText(input.icon, 16),
  };

  if (type === 'poem') {
    wordSet.words = requireWords(input.words, 'ことば');
  } else {
    wordSet.words5 = requireWords(input.words5, '五音のことば');
    wordSet.words7 = requireWords(input.words7, '七音のことば');
  }

  return wordSet;
}

// 旧クライアントが公開ドキュメントへ保存していた簡易ハッシュとの互換用。
// 次回の正しいパスワード入力時にbcryptハッシュへ移行し、公開フィールドから除去する。
function legacySimpleHash(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}

async function verifyCurrentPassword(wordSetId, existing, password) {
  if (typeof password !== 'string' || password.length === 0) {
    fail('permission-denied', 'このセットを編集・削除するにはパスワードが必要です。');
  }

  const secret = await db.collection('wordsetSecrets').doc(wordSetId).get();
  // 新形式のbcryptハッシュを確認する。
  if (secret.exists) {
    const passwordHash = secret.get('passwordHash');
    if (typeof passwordHash === 'string') {
      // 旧簡易ハッシュをbcrypt.compareへ渡すと例外になり、互換照合に進めない。
      if (passwordHash.startsWith('$2') && await bcrypt.compare(password, passwordHash)) return true;
      // 移行途中のデータでは、秘密コレクション内にも旧簡易ハッシュが残る場合がある。
      if (legacySimpleHash(password) === passwordHash) return true;
    }
  }
  // 旧データでは公開ドキュメント側に簡易ハッシュが残っている場合がある。
  // 移行途中で両方が存在しても、旧ハッシュで正しく認証できるようにする。
  if (typeof existing.passwordHash === 'string' && legacySimpleHash(password) === existing.passwordHash) {
    return true;
  }

  fail('permission-denied', 'パスワードが一致しません。作成時と同じ文字列を入力してください。');
}

async function passwordHashForSave({ id, existing, wordSet, currentPassword, newPassword }) {
  const wasProtected = existing?.hasPassword === true;

  if (wasProtected) {
    await verifyCurrentPassword(id, existing, currentPassword);
  }

  if (!wordSet.hasPassword) return null;

  if (typeof newPassword === 'string' && newPassword.length > 0) {
    if (newPassword.length < 8 || newPassword.length > 128) {
      fail('invalid-argument', 'パスワードは8〜128文字で入力してください。');
    }
    return bcrypt.hash(newPassword, 12);
  }

  if (!wasProtected) {
    fail('invalid-argument', 'パスワード付きセットには8文字以上のパスワードが必要です。');
  }

  const existingSecret = await db.collection('wordsetSecrets').doc(id).get();
  if (existingSecret.exists && typeof existingSecret.get('passwordHash') === 'string') {
    const existingHash = existingSecret.get('passwordHash');
    // bcryptハッシュはそのまま維持し、旧簡易ハッシュは検証済みの入力値でbcryptへ移行する。
    if (existingHash.startsWith('$2')) return existingHash;
    return bcrypt.hash(currentPassword, 12);
  }

  // 旧公開ハッシュからの移行時は、検証済みの入力値をbcryptへ移し替える。
  return bcrypt.hash(currentPassword, 12);
}

function snapshotForHistory(wordSet) {
  if (wordSet.type === 'poem') return { name: wordSet.name, words: wordSet.words };
  return { name: wordSet.name, words5: wordSet.words5, words7: wordSet.words7 };
}

exports.verifyWordSetPassword = onCall(callableOptions, async (request) => {
  requireAuthenticated(request);
  const input = request.data || {};
  const id = requireText(input.id, 'ワードセットID', 150);
  const snapshot = await db.collection('wordsets').doc(id).get();
  if (!snapshot.exists) fail('not-found', 'ワードセットが見つかりません。');
  const wordSet = snapshot.data();
  if (wordSet.hasPassword !== true) return { verified: true };
  await verifyCurrentPassword(id, wordSet, input.currentPassword);
  return { verified: true };
});

exports.saveWordSet = onCall(callableOptions, async (request) => {
  requireAuthenticated(request);

  const input = request.data || {};
  const id = optionalText(input.id, 150);
  const editorName = optionalText(input.editorName, 20) || '匿名';
  const wordSet = sanitizeWordSet(input.wordSet);
  const ref = id ? db.collection('wordsets').doc(id) : db.collection('wordsets').doc();
  const existingSnapshot = id ? await ref.get() : null;

  if (id && !existingSnapshot.exists) fail('not-found', '編集するワードセットが見つかりません。');
  const existing = existingSnapshot?.data() || null;
  if (existing && existing.type !== wordSet.type) fail('invalid-argument', 'ワードセットの種類は変更できません。');

  const passwordHash = await passwordHashForSave({
    id: ref.id,
    existing,
    wordSet,
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
  });

  const priorCreators = Array.isArray(existing?.creators)
    ? existing.creators.filter((name) => typeof name === 'string')
    : [];
  const creators = priorCreators.includes(editorName) ? priorCreators : [...priorCreators, editorName];
  const publicWordSet = {
    ...wordSet,
    creators,
    createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
  };

  const batch = db.batch();
  batch.set(ref, publicWordSet);
  const secretRef = db.collection('wordsetSecrets').doc(ref.id);
  if (passwordHash) {
    batch.set(secretRef, { passwordHash, updatedAt: FieldValue.serverTimestamp() });
  } else {
    batch.delete(secretRef);
  }
  batch.set(ref.collection('history').doc(), {
    action: existing ? 'edited' : 'created',
    editor: editorName,
    snapshot: snapshotForHistory(wordSet),
    timestamp: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return { id: ref.id, hasPassword: wordSet.hasPassword };
});

exports.deleteWordSet = onCall(callableOptions, async (request) => {
  requireAuthenticated(request);

  const input = request.data || {};
  const id = requireText(input.id, 'ワードセットID', 150);
  const editorName = optionalText(input.editorName, 20) || '不明';
  const ref = db.collection('wordsets').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) fail('not-found', '削除するワードセットが見つかりません。');

  const wordSet = snapshot.data();
  if (wordSet.hasPassword === true) {
    await verifyCurrentPassword(id, wordSet, input.currentPassword);
  }

  const batch = db.batch();
  batch.set(ref.collection('history').doc(), {
    action: 'deleted',
    editor: editorName,
    snapshot: snapshotForHistory(wordSet),
    timestamp: FieldValue.serverTimestamp(),
  });
  batch.delete(ref);
  batch.delete(db.collection('wordsetSecrets').doc(id));
  await batch.commit();

  return { id, deleted: true };
});
