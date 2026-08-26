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

function shuffle(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function participantsByUid(room) {
  if (!isPlainObject(room.participantUids)) {
    fail('failed-precondition', 'UID対応済みのルームではありません。');
  }
  const entries = Object.entries(room.participantUids)
    .filter(([uid, name]) => typeof uid === 'string' && uid && typeof name === 'string' && name.trim());
  if (entries.length === 0) fail('failed-precondition', '参加者UIDが見つかりません。');
  return new Map(entries);
}

function requireHostUid(room, uid, participants) {
  const hostUid = typeof room.currentHostUid === 'string' && room.currentHostUid
    ? room.currentHostUid
    : [...participants.entries()].find(([, name]) => name === room.currentHost)?.[0];
  if (!hostUid || hostUid !== uid) fail('permission-denied', '親だけが配札できます。');
  return hostUid;
}

function handCount(room, field, fallback) {
  const value = Number(room.settings?.[field]);
  if (!Number.isInteger(value) || value < 1 || value > 20) return fallback;
  return value;
}

function validatePlayerUids(room, participants) {
  if (!Array.isArray(room.players) || room.players.length === 0) {
    fail('failed-precondition', 'プレイヤーがいません。');
  }
  const uids = room.players.map((name) => {
    const uid = [...participants.entries()].find(([, participantName]) => participantName === name)?.[0];
    if (!uid) fail('failed-precondition', 'プレイヤーのUIDが見つかりません。');
    return uid;
  });
  if (new Set(uids).size !== uids.length) fail('failed-precondition', '参加者が重複しています。');
  return uids;
}

function validateDealRequest(room, uid) {
  const participants = participantsByUid(room);
  requireHostUid(room, uid, participants);
  if (room.schemaVersion !== 2) fail('failed-precondition', '新形式のルームではありません。');
  if (room.status !== 'lobby') fail('failed-precondition', 'ロビー状態のルームだけ配札できます。');
  const playerUids = validatePlayerUids(room, participants);
  const hand5 = handCount(room, 'hand5', 5);
  const hand7 = handCount(room, 'hand7', 3);
  if (!Array.isArray(room.words5) || !Array.isArray(room.words7)) {
    fail('failed-precondition', '配札用の素材がありません。');
  }
  if (room.words5.length < playerUids.length * hand5 * 2 || room.words7.length < playerUids.length * hand7 * 2) {
    fail('failed-precondition', '引き直し用を含む素材が不足しています。');
  }
  return { participants, playerUids, hand5, hand7 };
};

exports.dealHaikuHands = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { participants, playerUids, hand5, hand7 } = validateDealRequest(room, uid);
    const words5 = shuffle(room.words5);
    const words7 = shuffle(room.words7);
    const handRefs = playerUids.map((playerUid) => roomRef.collection('hands').doc(playerUid));
    const hands = playerUids.map((playerUid, index) => ({
      uid: playerUid,
      name: participants.get(playerUid),
      hand5: words5.splice(0, hand5),
      hand7: words7.splice(0, hand7),
      round: room.roundCount || 1,
    }));

    // Functionが素材から手札を生成し、個人手札をルーム文書へ書き込まない。
    handRefs.forEach((ref, index) => {
      transaction.set(ref, {
        hand5: hands[index].hand5,
        hand7: hands[index].hand7,
        redrawUsed: false,
        round: hands[index].round,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    transaction.update(roomRef, {
      schemaVersion: 2,
      status: 'playing',
      deck5: words5,
      deck7: words7,
      hands5: FieldValue.delete(),
      hands7: FieldValue.delete(),
      phrases: {},
      phraseDetails: {},
      votes: {},
      revealedPhrases: {},
      selfPraise: {},
      redraws: {},
    });
  });

  return { ok: true };
});

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
