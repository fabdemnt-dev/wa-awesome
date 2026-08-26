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

function latestUidForName(participants, name) {
  return [...participants.entries()].filter(([, participantName]) => participantName === name).at(-1)?.[0];
}

function requireHostUid(room, uid, participants) {
  const currentHostUid = typeof room.currentHostUid === 'string' && room.currentHostUid;
  const currentHostName = room.currentHost;
  const hostUid = currentHostName
    ? latestUidForName(participants, currentHostName)
    : currentHostUid;
  if (!hostUid || hostUid !== uid || !participants.has(hostUid)) {
    fail('permission-denied', '親だけが配札できます。');
  }
  const hostName = participants.get(hostUid);
  if (!Array.isArray(room.players) || !room.players.includes(hostName)) {
    fail('permission-denied', 'プレイヤーの親だけが配札できます。');
  }
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
    const uid = latestUidForName(participants, name);
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

function requireSelectedIds(value, label) {
  if (!Array.isArray(value) || value.length > 20 || value.some((id) => typeof id !== 'string' || !id)) {
    fail('invalid-argument', `${label}の指定が正しくありません。`);
  }
  return [...new Set(value)];
}

exports.redrawHaikuHand = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const selectedIds5 = requireSelectedIds(request.data?.selectedIds5 || [], '五音札');
  const selectedIds7 = requireSelectedIds(request.data?.selectedIds7 || [], '七音札');
  if (selectedIds5.length === 0 && selectedIds7.length === 0) {
    fail('invalid-argument', '引き直す札を選んでください。');
  }
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);
    if (!roomSnapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = roomSnapshot.data() || {};
    if (room.schemaVersion !== 2 || room.status !== 'playing') {
      fail('failed-precondition', '新形式の句会中のルームだけ引き直しできます。');
    }
    const participants = participantsByUid(room);
    if (!Array.isArray(room.players) || !room.players.includes(participants.get(uid))) {
      fail('permission-denied', 'プレイヤーだけが引き直しできます。');
    }
    const handRef = roomRef.collection('hands').doc(uid);
    const handSnapshot = await transaction.get(handRef);
    if (!handSnapshot.exists) fail('failed-precondition', '手札が見つかりません。');
    const hand = handSnapshot.data() || {};
    if (hand.round !== (room.roundCount || 1)) fail('failed-precondition', '手札の節が一致しません。');
    if (hand.redrawUsed === true) fail('failed-precondition', '引き直しは1節につき1回までです。');
    if (room.phrases?.[uid]) fail('failed-precondition', '句を披露した後は引き直せません。');
    const hand5 = Array.isArray(hand.hand5) ? hand.hand5 : [];
    const hand7 = Array.isArray(hand.hand7) ? hand.hand7 : [];
    const selected5 = hand5.filter((word) => selectedIds5.includes(word?.id));
    const selected7 = hand7.filter((word) => selectedIds7.includes(word?.id));
    if (selected5.length !== selectedIds5.length || selected7.length !== selectedIds7.length) {
      fail('invalid-argument', '自分の手札にない札は引き直せません。');
    }
    const deck5 = Array.isArray(room.deck5) ? room.deck5 : [];
    const deck7 = Array.isArray(room.deck7) ? room.deck7 : [];
    if (deck5.length < selected5.length || deck7.length < selected7.length) {
      fail('failed-precondition', '山札が不足しています。');
    }
    const newDeck5 = shuffle(deck5);
    const newDeck7 = shuffle(deck7);
    const drawn5 = newDeck5.splice(0, selected5.length);
    const drawn7 = newDeck7.splice(0, selected7.length);
    const kept5 = hand5.filter((word) => !selectedIds5.includes(word?.id));
    const kept7 = hand7.filter((word) => !selectedIds7.includes(word?.id));
    transaction.update(handRef, {
      hand5: [...kept5, ...drawn5],
      hand7: [...kept7, ...drawn7],
      redrawUsed: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(roomRef, { deck5: newDeck5, deck7: newDeck7 });
  });
  return { ok: true };
});

function requireParticipant(room, uid) {
  const participants = participantsByUid(room);
  const name = participants.get(uid);
  if (!name) fail('permission-denied', '参加者だけが操作できます。');
  return { participants, name };
}

function requirePlayingParticipant(room, uid) {
  const result = requireParticipant(room, uid);
  if (!Array.isArray(room.players) || !room.players.includes(result.name)) {
    fail('permission-denied', 'プレイヤーだけが操作できます。');
  }
  return result;
}

function requireRole(value) {
  if (value !== 'player' && value !== 'spectator') fail('invalid-argument', '役割が正しくありません。');
  return value;
}

function requireSupplementWords(value, label) {
  if (!Array.isArray(value) || value.length > 100) fail('invalid-argument', `${label}が正しくありません。`);
  return value.map((item) => {
    if (!isPlainObject(item)) fail('invalid-argument', `${label}が正しくありません。`);
    return { id: requireText(item.id, '素材ID', 200), text: requireText(item.text, '素材', 200), author: optionalText(item.author, 200) || '🎴お題ぶくろ' };
  });
}

exports.changeHaikuRole = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const role = requireRole(request.data?.role);
  const supplied5 = requireSupplementWords(request.data?.supplement5 || [], '五音補充素材');
  const supplied7 = requireSupplementWords(request.data?.supplement7 || [], '七音補充素材');
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    if (room.schemaVersion !== 2) fail('failed-precondition', '新形式のルームだけ役割変更Callableを利用できます。');
    const participants = participantsByUid(room);
    const name = participants.get(uid);
    if (!name) fail('permission-denied', '参加者だけが役割変更できます。');
    const currentHost = room.currentHost || '';
    if (room.status === 'playing' && role === 'spectator' && name === currentHost) {
      fail('failed-precondition', '親はラウンド中に見学者へ切り替えられません。');
    }
    const players = (room.players || []).filter((item) => item !== name);
    const spectators = (room.spectators || []).filter((item) => item !== name);
    const nextPlayers = role === 'player' ? [...players, name] : players;
    const nextSpectators = role === 'spectator' ? [...spectators, name] : spectators;
    const participantUids = Object.fromEntries([...participants.entries()].filter(([participantUid, participantName]) => participantName !== name || participantUid === uid));
    participantUids[uid] = name;
    const update = { players: nextPlayers, spectators: nextSpectators, participantUids };
    if (!room.currentHost && role === 'player') {
      update.currentHost = name;
      update.currentHostUid = uid;
    }
    if (room.status === 'playing' && role === 'player') {
      const settings = room.settings || { hand5: 5, hand7: 3 };
      const deck5 = Array.isArray(room.deck5) ? [...room.deck5] : [];
      const deck7 = Array.isArray(room.deck7) ? [...room.deck7] : [];
      const pool5 = Array.isArray(room.supplementPool5) && room.supplementPool5.length ? room.supplementPool5 : supplied5;
      const pool7 = Array.isArray(room.supplementPool7) && room.supplementPool7.length ? room.supplementPool7 : supplied7;
      if (deck5.length < settings.hand5) deck5.push(...supplied5);
      if (deck7.length < settings.hand7) deck7.push(...supplied7);
      if (deck5.length < settings.hand5 || deck7.length < settings.hand7) fail('failed-precondition', '途中参加者へ配る山札が不足しています。');
      const hand5 = deck5.splice(0, settings.hand5);
      const hand7 = deck7.splice(0, settings.hand7);
      transaction.set(roomRef.collection('hands').doc(uid), { hand5, hand7, redrawUsed: false, round: room.roundCount || 1, updatedAt: FieldValue.serverTimestamp() });
      update.deck5 = deck5;
      update.deck7 = deck7;
      update.supplementPool5 = pool5;
      update.supplementPool7 = pool7;
    }
    transaction.update(roomRef, update);
  });
  return { ok: true };
});

function requireSettingInteger(value, label, fallback, max = 20) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > max) fail('invalid-argument', `${label}は1〜${max}の整数で指定してください。`);
  return number;
}

async function updateGameSettings(request, prefix, fields) {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const roomRef = db.collection('rooms').doc(`${prefix}_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    if (room.schemaVersion !== 2) fail('failed-precondition', '新形式のルームだけ設定Callableを利用できます。');
    const participants = participantsByUid(room);
    requireHostUid(room, uid, participants);
    if (room.status !== 'lobby') fail('failed-precondition', '開始後は設定を変更できません。');
    const currentSettings = isPlainObject(room.settings) ? room.settings : {};
    const settings = { ...currentSettings };
    for (const [key, spec] of Object.entries(fields)) settings[key] = requireSettingInteger(request.data?.[key], spec.label, spec.fallback, spec.max);
    if (prefix === 'haiku') settings.carryOver = request.data?.carryOver !== false;
    transaction.update(roomRef, { settings });
  });
  return { ok: true };
}

exports.updateHaikuSettings = onCall(callableOptions, (request) => updateGameSettings(request, 'haiku', {
  hand5: { label: '五音手札枚数', fallback: 5, max: 20 },
  hand7: { label: '七音手札枚数', fallback: 3, max: 20 },
}));

exports.updatePoemSettings = onCall(callableOptions, (request) => updateGameSettings(request, 'poem', {
  handCount: { label: '手札枚数', fallback: 5, max: 20 },
}));

function requireMaterialItems(value, label) {
  if (!Array.isArray(value) || value.length > 100) fail('invalid-argument', `${label}が正しくありません。`);
  return value.map((item) => {
    if (!isPlainObject(item)) fail('invalid-argument', `${label}が正しくありません。`);
    return { id: requireText(item.id, '素材ID', 200), text: requireText(item.text, '素材', 200), author: requireText(item.author, '作者名', 200) };
  });
}

function requireLobbyPlayer(room, uid) {
  const participants = participantsByUid(room);
  const name = participants.get(uid);
  if (!name || !Array.isArray(room.players) || !room.players.includes(name)) fail('permission-denied', 'プレイヤーだけが操作できます。');
  if (room.status !== 'lobby') fail('failed-precondition', '句会開始後は素材を変更できません。');
  return { participants, name };
}

exports.submitHaikuWords = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const words5 = requireMaterialItems(request.data?.words5 || [], '五音素材');
  const words7 = requireMaterialItems(request.data?.words7 || [], '七音素材');
  if (!words5.length && !words7.length) fail('invalid-argument', '少なくとも1つ素材を入力してください。');
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { name } = requireLobbyPlayer(room, uid);
    if (room.schemaVersion !== 2) fail('failed-precondition', '新形式のルームだけ素材Callableを利用できます。');
    if ([...words5, ...words7].some((item) => item.author !== name)) fail('permission-denied', '自分の名前以外の素材は投稿できません。');
    const update = {};
    if (words5.length) update.words5 = FieldValue.arrayUnion(...words5);
    if (words7.length) update.words7 = FieldValue.arrayUnion(...words7);
    transaction.update(roomRef, update);
  });
  return { ok: true };
});

exports.removeHaikuWord = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const type = request.data?.type === '5' ? '5' : request.data?.type === '7' ? '7' : fail('invalid-argument', '音数が正しくありません。');
  const wordId = requireText(request.data?.wordId, '素材ID', 200);
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { name } = requireLobbyPlayer(room, uid);
    if (room.schemaVersion !== 2) fail('failed-precondition', '新形式のルームだけ素材Callableを利用できます。');
    const field = type === '5' ? 'words5' : 'words7';
    const target = (room[field] || []).find((item) => item?.id === wordId && item?.author === name);
    if (!target) fail('permission-denied', '自分が投稿した素材だけ取り消せます。');
    transaction.update(roomRef, { [field]: FieldValue.arrayRemove(target) });
  });
  return { ok: true };
});

exports.submitPoemWords = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const words = requireMaterialItems(request.data?.words || [], '素材');
  if (!words.length) fail('invalid-argument', '少なくとも1つ素材を入力してください。');
  const roomRef = db.collection('rooms').doc(`poem_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { name } = requireLobbyPlayer(room, uid);
    if (room.schemaVersion !== 2) fail('failed-precondition', '新形式のルームだけ素材Callableを利用できます。');
    if (words.some((item) => item.author !== name)) fail('permission-denied', '自分の名前以外の素材は投稿できません。');
    transaction.update(roomRef, { words: FieldValue.arrayUnion(...words) });
  });
  return { ok: true };
});

exports.removePoemWord = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const wordId = requireText(request.data?.wordId, '素材ID', 200);
  const roomRef = db.collection('rooms').doc(`poem_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { name } = requireLobbyPlayer(room, uid);
    if (room.schemaVersion !== 2) fail('failed-precondition', '新形式のルームだけ素材Callableを利用できます。');
    const target = (room.words || []).find((item) => item?.id === wordId && item?.author === name);
    if (!target) fail('permission-denied', '自分が投稿した素材だけ取り消せます。');
    transaction.update(roomRef, { words: FieldValue.arrayRemove(target) });
  });
  return { ok: true };
});

function requirePhraseDetails(value) {
  if (!Array.isArray(value) || value.length !== 3) fail('invalid-argument', '句の素材が正しくありません。');
  return value.map((item) => {
    if (!isPlainObject(item)) fail('invalid-argument', '句の素材が正しくありません。');
    return {
      id: requireText(item.id, '素材ID', 200),
      text: requireText(item.text, '素材', 200),
      author: requireText(item.author, '素材作者', 200),
    };
  });
}

exports.submitHaikuPhrase = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const phrase = requireText(request.data?.phrase, '句', 600);
  const phraseDetails = requirePhraseDetails(request.data?.phraseDetails);
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { name } = requirePlayingParticipant(room, uid);
    if (room.schemaVersion !== 2 || room.status !== 'playing') fail('failed-precondition', '新形式の句会中だけ投稿できます。');
    const handSnapshot = await transaction.get(roomRef.collection('hands').doc(uid));
    const hand = handSnapshot.data() || {};
    const ownedIds = new Set([
      ...(Array.isArray(hand.hand5) ? hand.hand5 : []),
      ...(Array.isArray(hand.hand7) ? hand.hand7 : []),
    ].map((item) => item?.id));
    if (!handSnapshot.exists || hand.round !== (room.roundCount || 1) || phraseDetails.some((item) => !ownedIds.has(item.id))) {
      fail('permission-denied', '自分の手札にない素材は句に使えません。');
    }
    if (room.phrases?.[uid] !== undefined) fail('failed-precondition', '句は1節につき1つまでです。');
    transaction.update(roomRef, {
      [`phrases.${uid}`]: phrase,
      [`phraseDetails.${uid}`]: phraseDetails,
      [`revealedPhrases.${uid}`]: false,
      [`selfPraise.${uid}`]: false,
    });
  });
  return { ok: true };
});

exports.revealHaikuPhrase = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const targetUid = requireText(request.data?.targetUid, '対象UID', 200);
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { participants, name } = requirePlayingParticipant(room, uid);
    if (room.schemaVersion !== 2 || room.status !== 'playing') fail('failed-precondition', '新形式の句会中だけ披露できます。');
    if (!participants.has(targetUid) || room.phrases?.[targetUid] === undefined) fail('not-found', '対象の句が見つかりません。');
    const hostUid = latestUidForName(participants, room.currentHost);
    if (uid !== targetUid && uid !== hostUid) fail('permission-denied', '自分または親の句だけ披露できます。');
    transaction.update(roomRef, { [`revealedPhrases.${targetUid}`]: true });
  });
  return { ok: true };
});

exports.selfPraiseHaikuPhrase = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    requirePlayingParticipant(room, uid);
    if (room.schemaVersion !== 2 || room.status !== 'playing' || room.phrases?.[uid] === undefined) {
      fail('failed-precondition', '披露する句がありません。');
    }
    transaction.update(roomRef, { [`selfPraise.${uid}`]: true });
  });
  return { ok: true };
});

const haikuVoteKeys = new Set(['okashi', 'aware', 'wabisabi', 'ayashi', 'kuruoshi', 'medurashi', 'yugen', 'tae', 'kanpu']);

exports.submitHaikuVote = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const targetUid = requireText(request.data?.targetUid, '対象UID', 200);
  const evalKey = requireText(request.data?.evalKey, '御印', 30);
  if (!haikuVoteKeys.has(evalKey)) fail('invalid-argument', '御印が正しくありません。');
  const roomRef = db.collection('rooms').doc(`haiku_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { participants, name } = requireParticipant(room, uid);
    if (room.schemaVersion !== 2 || room.status !== 'playing') fail('failed-precondition', '新形式の句会中だけ投票できます。');
    if (!participants.has(targetUid) || room.phrases?.[targetUid] === undefined || room.revealedPhrases?.[targetUid] !== true) {
      fail('failed-precondition', '披露済みの句だけ投票できます。');
    }
    const hostUid = latestUidForName(participants, room.currentHost);
    const isHost = uid === hostUid;
    const isSpectator = Array.isArray(room.spectators) && room.spectators.includes(name);
    const allowed = isSpectator ? evalKey === 'kanpu' : isHost ? evalKey !== 'kanpu' : ['okashi', 'aware', 'wabisabi'].includes(evalKey);
    if (!allowed) fail('permission-denied', 'この御印は選べません。');
    const voterVotes = room.votes?.[uid] || {};
    if (!isHost && Object.values(voterVotes).some((value) => value != null)) {
      fail('failed-precondition', '御印は1節につき1つまでです。');
    }
    const current = voterVotes[targetUid];
    const next = isHost ? [...(Array.isArray(current) ? current : current ? [current] : []), evalKey] : evalKey;
    transaction.update(roomRef, { [`votes.${uid}.${targetUid}`]: next });
  });
  return { ok: true };
});

function requirePoemRoomParticipant(room, uid) {
  const participants = participantsByUid(room);
  const name = participants.get(uid);
  if (!name) fail('permission-denied', '参加者だけが操作できます。');
  return { participants, name };
}

function requirePoemPlayer(room, uid) {
  const result = requirePoemRoomParticipant(room, uid);
  if (!Array.isArray(room.players) || !room.players.includes(result.name)) {
    fail('permission-denied', 'プレイヤーだけが操作できます。');
  }
  return result;
}

exports.submitPoemSecure = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const text = requireText(request.data?.text, '作品', 4000);
  const usedHands = Array.isArray(request.data?.usedHands) ? request.data.usedHands : [];
  if (usedHands.length > 20 || usedHands.some((item) => !isPlainObject(item) || !requireText(item.id, '素材ID', 200))) {
    fail('invalid-argument', '使用素材が正しくありません。');
  }
  const roomRef = db.collection('rooms').doc(`poem_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    requirePoemPlayer(room, uid);
    if (room.schemaVersion !== 2 || room.status !== 'playing') fail('failed-precondition', '新形式のポエム作成中だけ投稿できます。');
    if (room.poems?.[uid] !== undefined) fail('failed-precondition', '作品は1幕につき1つまでです。');
    const owned = new Set((Array.isArray(room.hands?.[uid]) ? room.hands[uid] : []).map((item) => item?.id));
    if (usedHands.some((item) => !owned.has(item.id))) fail('permission-denied', '自分の手札にない素材は使えません。');
    transaction.update(roomRef, { [`poems.${uid}`]: { text, hands: usedHands, revealed: false, likes: 0, emos: 0 } });
  });
  return { ok: true };
});

exports.revealPoemSecure = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const targetUid = requireText(request.data?.targetUid, '対象UID', 200);
  const roomRef = db.collection('rooms').doc(`poem_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    const { participants } = requirePoemPlayer(room, uid);
    if (room.schemaVersion !== 2 || room.status !== 'playing' || room.poems?.[targetUid] === undefined) fail('failed-precondition', '披露する作品がありません。');
    const hostUid = latestUidForName(participants, room.currentHost);
    if (uid !== targetUid && uid !== hostUid) fail('permission-denied', '自分または親の作品だけ披露できます。');
    transaction.update(roomRef, { [`poems.${targetUid}.revealed`]: true });
  });
  return { ok: true };
});

exports.reactPoemSecure = onCall(callableOptions, async (request) => {
  const uid = requireAuthenticated(request);
  const roomId = requireText(request.data?.roomId, 'ルームID', 150);
  const targetUid = requireText(request.data?.targetUid, '対象UID', 200);
  const type = requireText(request.data?.type, 'リアクション', 10);
  if (type !== 'like' && type !== 'emo') fail('invalid-argument', 'リアクションが正しくありません。');
  const roomRef = db.collection('rooms').doc(`poem_${roomId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) fail('not-found', 'ルームが見つかりません。');
    const room = snapshot.data() || {};
    requirePoemRoomParticipant(room, uid);
    if (room.schemaVersion !== 2 || room.status !== 'playing' || room.poems?.[targetUid] === undefined || room.poems?.[targetUid]?.revealed !== true) {
      fail('failed-precondition', '披露済みの作品だけリアクションできます。');
    }
    transaction.update(roomRef, { [`poems.${targetUid}.${type === 'like' ? 'likes' : 'emos'}`]: FieldValue.increment(1) });
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
