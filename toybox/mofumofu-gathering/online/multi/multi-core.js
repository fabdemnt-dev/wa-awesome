// もふもふ大集合！ 人間3〜6人オンライン版 Phase E: クライアントの純粋核。
//
// DOM・Firebaseへ依存しない。script.js はこのモジュールが決めた表示内容だけを描画し、
// ゲームの進行判断（手番・判定・勝敗）は Firestore の公開room（サーバー正本）だけを見る。
//
// 既存2人＋こはる版（../script.js・../connection-control.js）とは共有しない別系統。
// 保存key・presenceルート・招待コード運用・表示も3〜6人版専用に持つ。
//
// 秘密の扱い:
//   - 他人の手札内容・pendingOfferの実カード・leftoversの内容はこのファイルでも一切扱わない。
//   - 山札の表示枚数は「人数から公開契約で決まる枚数」（HAND_SIZE/LEFTOVERS表）だけで、中身は見ない。

/* ------------------------------------------------------------------ 公開gate */

// 3〜6人版の一般導線gate。Phase Eではまだ一般公開しないため false 固定。
// false の間はゲームページのモード選択で「3〜6人」を選べない（直接URLは開発・検証用に開いている）。
export const MULTI_ONLINE_PUBLIC_ENABLED = false;

// 既存2人＋こはる版のgateは online-entry.js の ONLINE_PUBLIC_ENABLED=true のまま（このファイルでは触らない）。
export const TWO_PLAYER_PAGE_PATH = './online/';
export const MULTI_PAGE_PATH = './online/multi/';

// ゲームページのオンライン選択に出すモード一覧。gate=false では multi だけ選べない。
export function onlineModeOptions() {
  return [
    { id: 'two-player', label: '2人＋こはる', description: 'いま遊べるオンライン版', href: TWO_PLAYER_PAGE_PATH, enabled: true },
    {
      id: 'multi',
      label: '3〜6人',
      description: MULTI_ONLINE_PUBLIC_ENABLED ? 'みんなで遊べる3〜6人版' : 'じゅんびちゅう',
      href: MULTI_PAGE_PATH,
      enabled: MULTI_ONLINE_PUBLIC_ENABLED,
    },
  ];
}

/* ---------------------------------------------------------------- 公開契約 */

// functions/mofumofu-multi/rules.js と同じ公開値（人数から決まる枚数だけ。中身は秘密）。
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 6;
export const MAX_OTHERS = MAX_PLAYERS - 1;
export const SEAT_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
export const HAND_SIZE_BY_PLAYER_COUNT = { 3: 10, 4: 8, 5: 6, 6: 5 };
export const LEFTOVERS_BY_PLAYER_COUNT = { 3: 2, 4: 0, 5: 2, 6: 2 };

export const ROOM_STATUS = { WAITING: 'waiting', PLAYING: 'playing', FINISHED: 'finished' };
export const PLAYER_STATUS = { ACTIVE: 'active', LEFT: 'left' };
export const TURN_STATE = {
  WAITING: 'waiting',
  AWAITING_OFFER: 'awaitingOffer',
  AWAITING_JUDGMENT: 'awaitingJudgment',
  FINISHED: 'finished',
};
export const FINISH_REASON = { GATHERING: 'gathering', HAND_EMPTY: 'hand-empty', TOO_FEW_ACTIVE: 'too-few-active' };
export const GATHERING_REASON = {
  FOUR_OF_A_KIND: 'four-of-a-kind',
  ALL_EIGHT_TYPES: 'all-eight-types',
  FOUR_AND_EIGHT: 'four-and-eight',
};
export const JUDGMENTS = { TRUTH: 'truth', LIE: 'lie' };

export const ANIMALS = ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'];
export const ANIMAL_LABELS = {
  cat: 'ねこ', rabbit: 'うさぎ', bear: 'くま', chick: 'ひよこ',
  fox: 'きつね', penguin: 'ぺんぎん', panda: 'ぱんだ', polar: 'しろくま',
};
export const ANIMAL_EMOJI = {
  cat: '🐱', rabbit: '🐰', bear: '🐻', chick: '🐥',
  fox: '🦊', penguin: '🐧', panda: '🐼', polar: '🐻‍❄️',
};
// 現在一般公開版と同じ正式カード画像（新しい画像は作らない）。
export const CARD_IMAGES = {
  cat: 'cat.png', rabbit: 'rabbit.png', bear: 'bear.png', chick: 'chick.png',
  fox: 'fox.png', penguin: 'penguin.png', panda: 'panda.png', polar: 'polar-bear.png',
};
// 3〜6人版ページは online/multi/ にあるため、正式assetは既存版と同じ場所を4階層上から参照する。
export const ASSET_BASE = '../../../../assets/mofumofu-gathering/';
export const LOGO_PATH = `${ASSET_BASE}mofumofu-logo.png`;
export function cardImagePath(animalType) { return `${ASSET_BASE}${CARD_IMAGES[animalType] || ''}`; }

export const INVITE_LENGTH = 8;
export const INVITE_CODE_RE = /^[A-Za-z0-9]{8}$/;
export const COPY_LABEL = 'コピー';
export const COPY_DONE_LABEL = 'コピーしました！';
export const COPY_FAILED_LABEL = 'コピーできませんでした';
export const ROOM_ID_COPY_LABEL = '部屋IDをコピー';
export const MIN_TAP_TARGET_PX = 44;

// 既存2人＋こはる版と同じ周期・境界（Phase Dの契約と同値）。独自の値は作らない。
export const HEARTBEAT_INTERVAL_MS = 15 * 1000;
export const PRESENCE_STALE_MS = 2 * 60 * 1000;
export const ACCESS_REFRESH_MS = 4 * 60 * 1000;

/* -------------------------------------------------- 保存領域（既存版と分離） */

// 既存2人＋こはる版は mofumofuRoomId / mofumofuSeatId / mofumofuInvite:<roomId> を使う。
// 3〜6人版は必ず mofumofuMulti〜 を使い、既存keyと共有しない。
export const STORAGE_KEYS = Object.freeze({
  roomId: 'mofumofuMultiRoomId',
  seatId: 'mofumofuMultiSeatId',
  invitePrefix: 'mofumofuMultiInvite:',
});
export function inviteKey(roomId) { return `${STORAGE_KEYS.invitePrefix}${roomId}`; }

export function saveRoom(storage, { roomId, seatId }) {
  if (!roomId || !seatId) return false;
  storage.setItem(STORAGE_KEYS.roomId, roomId);
  storage.setItem(STORAGE_KEYS.seatId, seatId);
  return true;
}
export function loadRoom(storage) {
  try {
    const roomId = storage.getItem(STORAGE_KEYS.roomId);
    const seatId = storage.getItem(STORAGE_KEYS.seatId);
    if (!roomId || !seatId) return null;
    return { roomId, seatId };
  } catch { return null; }
}
// resume失敗（room-not-found / not-member / room-expired 等）で保存を解除する。
export function clearSavedRoom(storage) {
  try {
    storage.removeItem(STORAGE_KEYS.roomId);
    storage.removeItem(STORAGE_KEYS.seatId);
  } catch { /* 保存領域が使えなくても入口復帰は続ける */ }
}
export function normalizeInviteCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}
export function isInviteCode(value) { return INVITE_CODE_RE.test(normalizeInviteCode(value)); }
// 平文inviteは「そのタブ・そのroom」のsessionStorageにだけ置く（URL・console・localStorageへ出さない）。
export function rememberInvite(storage, roomId, code) {
  const normalized = normalizeInviteCode(code);
  if (!roomId || !isInviteCode(normalized)) return false;
  try { storage.setItem(inviteKey(roomId), normalized); return true; } catch { return false; }
}
export function restoreInvite(storage, roomId) {
  if (!roomId) return '';
  try {
    const code = normalizeInviteCode(storage.getItem(inviteKey(roomId)));
    return isInviteCode(code) ? code : '';
  } catch { return ''; }
}
export function forgetInvite(storage, roomId) {
  if (!roomId) return;
  try { storage.removeItem(inviteKey(roomId)); } catch { /* 消せなくても致命ではない */ }
}

/* ------------------------------------------------------------ 表示テキスト */

export const TEXT = {
  statusInitial: '接続準備中です…',
  connecting: '接続中',
  syncing: '再接続中／同期中…',
  entryTitle: 'もふもふ大集合！',
  entryBadge: 'オンライン 3〜6人',
  entryCatch: 'ほんと？ うそ？ もふもふのひみつ！',
  create: '部屋をつくる',
  join: '参加',
  inviteFieldLabel: '招待コード',
  inviteHelp: '部屋をつくった人から8文字の招待コードを教えてもらい、入力してください。',
  helpButton: 'あそびかた',
  lobbyEyebrow: '部屋ができました',
  roomIdPrefix: '部屋ID：',
  inviteHeading: '招待コード',
  inviteNote: 'この8文字の招待コードを教えてね。',
  start: 'ゲーム開始',
  waitingForHost: 'ホストがゲームを開始するまで待ってね。',
  full: '満員です',
  selfLabel: 'あなた',
  otherLabelPrefix: 'あいて',
  emptySeatLabel: '参加まち',
  chipOnline: '● 接続中',
  chipReconnecting: '○ 再接続待ち',
  reconnectSelf: '接続の復帰を待っています',
  turnFinished: 'ゲーム終了',
  step1: '① カードをえらぶ',
  step2: '② 動物を宣言',
  step3: '③ 渡す相手をえらぶ',
  judgeHeading: 'この宣言は……？',
  truth: '○ ほんと？',
  lie: '× うそ！',
  judgeHand: 'あなたの手札',
  gatheringTitle: 'もふもふ大集合！',
  loserVerdict: 'もふもふ大集合！／負け',
  winVerdict: '勝ち！',
  tiedWinners: '同率優勝！',
  handEmptyNote: 'だれかの手札が0枚になったため終了しました。表向きカードの合計が最も少ない人の勝ちです。',
  tooFewActiveNote: '参加できる人が少なくなったため終了しました。',
  gatheringDeckNote: '山札は使いません。',
  noLeaveButton: 'このゲームはまだ途中で抜けられません。',
};

/* ------------------------------------------------------------ セッション失敗 */

// Phase D契約の reason をそのまま使い、無い場合も code から同じ4種類へ寄せる。
export const SESSION_REASONS = Object.freeze({
  ROOM_NOT_FOUND: 'room-not-found',
  NOT_MEMBER: 'not-member',
  ROOM_EXPIRED: 'room-expired',
  ROOM_STATUS: 'room-status',
});
export const SESSION_REASON_VALUES = Object.freeze(Object.values(SESSION_REASONS));
const SESSION_NOTICES = Object.freeze({
  'room-not-found': '保存していた部屋は終了しました。',
  'not-member': 'この部屋の参加者ではなかったため、入口へ戻りました。',
  'room-expired': '保存していた部屋の期限が切れています。',
  'room-status': 'いまはこの部屋へ接続できません。',
});

// 保存roomの解除・入口復帰を判断するための分類。null は「セッション失敗ではない」。
export function sessionFailureReason(error) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  const detailReason = error?.details?.reason;
  if (SESSION_REASON_VALUES.includes(detailReason)) return detailReason;
  const message = String(error?.message || '');
  if (code === 'not-found' || message.includes('部屋が見つかりません')) return SESSION_REASONS.ROOM_NOT_FOUND;
  if (code === 'permission-denied' || message.includes('この部屋の参加者ではありません')) return SESSION_REASONS.NOT_MEMBER;
  if (code === 'failed-precondition') {
    return message.includes('期限') ? SESSION_REASONS.ROOM_EXPIRED : SESSION_REASONS.ROOM_STATUS;
  }
  return null;
}
export function sessionRecoveryNotice(reason) {
  return SESSION_NOTICES[reason] || '入口へ戻りました。';
}

/* ------------------------------------------------------------------ presence */

// 既存2人＋こはる版と同じ判定（state==='online' かつ lastHeartbeatAt >= now-120秒）。
export function connectionOnline(connection, now = Date.now(), staleMs = PRESENCE_STALE_MS) {
  return Boolean(connection)
    && typeof connection === 'object'
    && connection.state === 'online'
    && Number.isFinite(Number(connection.lastHeartbeatAt))
    && Number(connection.lastHeartbeatAt) >= now - staleMs;
}
export function playerPresenceState(value, now = Date.now(), staleMs = PRESENCE_STALE_MS) {
  const connections = Object.values(value?.connections || {}).filter((connection) => (
    connection && typeof connection === 'object' && !Array.isArray(connection)
  ));
  const lastHeartbeatAt = connections.reduce((latest, connection) => (
    Number.isFinite(Number(connection.lastHeartbeatAt)) ? Math.max(latest, Number(connection.lastHeartbeatAt)) : latest
  ), 0);
  const online = connections.some((connection) => connectionOnline(connection, now, staleMs));
  return {
    // 複数connectionのうち1つでも生きていれば接続中。全部staleなら再接続待ち（退出ではない）。
    online,
    reconnecting: !online && connections.length > 0,
    hasConnections: connections.length > 0,
    connectionCount: connections.length,
    lastHeartbeatAt,
  };
}
export function presenceText(value, now = Date.now(), staleMs = PRESENCE_STALE_MS) {
  return playerPresenceState(value, now, staleMs).online ? TEXT.chipOnline : TEXT.chipReconnecting;
}
export function seatPresenceOf(room, presence, seatId, now = Date.now(), staleMs = PRESENCE_STALE_MS) {
  const uid = room?.playerUids?.[seatId];
  return uid ? presence?.[uid] : null;
}

/* -------------------------------------------------------------- 席表示の規則 */

// 内部seat ID（S1〜S6）を利用者向けの主表示にしない。自分は「あなた」、他は表示名か「あいてN」。
export function seatDisplayName(room, seatId, mySeatId) {
  if (!seatId) return '';
  if (seatId === mySeatId) return TEXT.selfLabel;
  const displayName = room?.players?.[seatId]?.displayName;
  if (typeof displayName === 'string' && displayName.trim()) return displayName.trim();
  const index = otherSeatIndex(room, seatId, mySeatId);
  return index === null ? TEXT.otherLabelPrefix : `${TEXT.otherLabelPrefix}${index}`;
}
// 自分を除いた席順（最大5人）。
export function otherSeatOrder(room, mySeatId) {
  return (room?.seatOrder || []).filter((seat) => seat !== mySeatId).slice(0, MAX_OTHERS);
}
export function otherSeatIndex(room, seatId, mySeatId) {
  const index = otherSeatOrder(room, mySeatId).indexOf(seatId);
  return index < 0 ? null : index + 1;
}

/* -------------------------------------------------------------------- ロビー */

export function lobbyView(room, mySeatId) {
  const seatOrder = [...(room?.seatOrder || [])];
  const seats = seatOrder.map((seat) => ({
    seatId: seat,
    isSelf: seat === mySeatId,
    label: seatDisplayName(room, seat, mySeatId),
    joined: Boolean(room?.playerUids?.[seat]),
    status: room?.playerStatus?.[seat] || PLAYER_STATUS.ACTIVE,
    isHost: Boolean(room?.playerUids?.[seat]) && room?.playerUids?.[seat] === room?.hostUid,
  }));
  const playerCount = seats.length;
  const isHost = Boolean(room?.hostUid) && room?.hostUid === room?.playerUids?.[mySeatId];
  const waiting = room?.status === ROOM_STATUS.WAITING;
  const full = playerCount >= MAX_PLAYERS;
  const canStart = isHost && waiting && playerCount >= MIN_PLAYERS && playerCount <= MAX_PLAYERS;
  return {
    seats,
    playerCount,
    playerCountText: `${playerCount}人 / ${MAX_PLAYERS}人`,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    emptySeats: Math.max(0, MAX_PLAYERS - playerCount),
    full,
    fullText: full ? TEXT.full : '',
    isHost,
    // participantにはゲーム開始ボタンを出さない（ホストだけ）。
    startVisible: isHost && waiting,
    canStart,
    startNote: !waiting ? '' : canStart ? '' : `${MIN_PLAYERS}人以上で開始できます`,
    // 招待コードはホストのwaiting中だけ表示する。
    inviteVisible: isHost && waiting,
    waitingNote: isHost ? '' : TEXT.waitingForHost,
    nextSeatId: full ? null : SEAT_IDS[playerCount] || null,
  };
}

/* ---------------------------------------------------------------- 手札・盤面 */

// 人数から公開契約で決まる初期手札と山札の枚数（中身は見ない）。
export function handSizeFor(playerCount) { return HAND_SIZE_BY_PLAYER_COUNT[playerCount] ?? null; }
export function deckCountFor(playerCount) { return LEFTOVERS_BY_PLAYER_COUNT[playerCount] ?? null; }

export function canMakeOffer(room, mySeatId) {
  return Boolean(room)
    && room.status === ROOM_STATUS.PLAYING
    && room.turnState === TURN_STATE.AWAITING_OFFER
    && room.currentTurnPlayerId === mySeatId
    && room.playerStatus?.[mySeatId] === PLAYER_STATUS.ACTIVE;
}
export function canJudge(room, mySeatId) {
  return Boolean(room)
    && room.status === ROOM_STATUS.PLAYING
    && room.turnState === TURN_STATE.AWAITING_JUDGMENT
    && room.publicOffer?.status === 'pending'
    && room.publicOffer?.toPlayerId === mySeatId
    && room.playerStatus?.[mySeatId] === PLAYER_STATUS.ACTIVE;
}
// 渡せる相手: 自分以外のactive席（最大5人）。
export function validTargets(room, mySeatId) {
  if (!canMakeOffer(room, mySeatId)) return [];
  return otherSeatOrder(room, mySeatId)
    .filter((seat) => room?.playerStatus?.[seat] === PLAYER_STATUS.ACTIVE)
    .map((seat) => ({ seatId: seat, label: seatDisplayName(room, seat, mySeatId) }));
}
export function claimOptions() {
  return ANIMALS.map((animalType) => ({
    animalType,
    label: ANIMAL_LABELS[animalType],
    emoji: ANIMAL_EMOJI[animalType],
    image: cardImagePath(animalType),
  }));
}
export function faceUpSummary(room, seatId) {
  const cards = room?.faceUpCards?.[seatId];
  const counts = {};
  for (const card of Array.isArray(cards) ? cards : []) {
    const animalType = card?.animalType;
    if (ANIMALS.includes(animalType)) counts[animalType] = (counts[animalType] || 0) + 1;
  }
  return ANIMALS.filter((animalType) => counts[animalType]).map((animalType) => ({
    animalType,
    label: ANIMAL_LABELS[animalType],
    emoji: ANIMAL_EMOJI[animalType],
    count: counts[animalType],
  }));
}
// 盤面中央の表示。山札0枚（4人戦）でも崩れないよう、常に枚数を持たせる。
export function boardView(room, mySeatId) {
  const playerCount = (room?.seatOrder || []).length;
  const deckCount = deckCountFor(playerCount);
  const offer = room?.publicOffer || null;
  const fromLabel = offer ? seatDisplayName(room, offer.fromPlayerId, mySeatId) : '';
  const base = {
    deckCount,
    deckText: deckCount === null ? '' : `山札 ${deckCount}枚`,
    deckEmpty: deckCount === 0,
    card: null,
    cardSub: '',
    message: '',
    resultLine: '',
  };
  if (!offer) return base;
  if (offer.status === 'pending') {
    return {
      ...base,
      card: { animalType: offer.claimAnimal, label: ANIMAL_LABELS[offer.claimAnimal], image: cardImagePath(offer.claimAnimal) },
      cardSub: `${fromLabel}の宣言`,
      message: offer.toPlayerId === mySeatId ? 'うそ？ ほんと？ えらんでね。' : 'みんなが判定するのを待っています…',
    };
  }
  const recipientLabel = seatDisplayName(room, offer.faceUpRecipientPlayerId, mySeatId);
  return {
    ...base,
    card: { animalType: offer.actualAnimal, label: ANIMAL_LABELS[offer.actualAnimal], image: cardImagePath(offer.actualAnimal) },
    cardSub: `${fromLabel}の宣言は「${ANIMAL_LABELS[offer.claimAnimal]}」`,
    message: offer.success ? '○ あたり！' : '× うそだった！',
    // 判定後だけ、宣言・実際の動物・本当/うそ・成功可否・受け取った人を公開する。
    resultLine: `本当は${ANIMAL_LABELS[offer.actualAnimal]}。判定${offer.success ? '成功' : '失敗'}。${recipientLabel}が表向きカードを受け取りました。`,
  };
}

/* ------------------------------------------------------------------- ゲーム */

function seatView(room, seatId, mySeatId, presence, now, staleMs, presenceReady) {
  const isSelf = seatId === mySeatId;
  const presenceValue = seatPresenceOf(room, presence, seatId, now, staleMs);
  const state = playerPresenceState(presenceValue, now, staleMs);
  const faceUp = faceUpSummary(room, seatId);
  const handCount = Number(room?.handCounts?.[seatId] || 0);
  const label = seatDisplayName(room, seatId, mySeatId);
  const faceUpCount = faceUp.reduce((sum, entry) => sum + entry.count, 0);
  return {
    seatId,
    isSelf,
    label,
    status: room?.playerStatus?.[seatId] || PLAYER_STATUS.ACTIVE,
    online: state.online,
    // RTDBのpresenceをまだ一度も受信していない間は接続状態を断定しない。
    presenceKnown: presenceReady && state.hasConnections,
    presenceText: presenceReady && state.hasConnections ? (state.online ? TEXT.chipOnline : TEXT.chipReconnecting) : '',
    handCount,
    faceUpCount,
    faceUp,
    isTurn: room?.currentTurnPlayerId === seatId && room?.status === ROOM_STATUS.PLAYING,
    isJudgeTarget: room?.publicOffer?.status === 'pending' && room?.publicOffer?.toPlayerId === seatId,
    // 内部seat IDを読み上げ名にしない（「あなた 接続中 手札5枚 表向き2枚」）。
    ariaLabel: `${label} ${state.online && presenceReady ? TEXT.chipOnline : state.hasConnections && presenceReady ? TEXT.chipReconnecting : ''} 手札${handCount}枚 表向き${faceUpCount}枚`.replace(/\s+/g, ' ').trim(),
  };
}

// 手番・判定が必要なプレイヤーが一時切断しているときだけ「再接続を待っています」を出す。
export function reconnectWaitingPlayer(room, presence, { mySeatId = null, now = Date.now(), staleMs = PRESENCE_STALE_MS, presenceReady = false } = {}) {
  if (!presenceReady || room?.status !== ROOM_STATUS.PLAYING) return null;
  const awaitedSeat = room.turnState === TURN_STATE.AWAITING_JUDGMENT
    ? room.publicOffer?.toPlayerId
    : room.turnState === TURN_STATE.AWAITING_OFFER ? room.currentTurnPlayerId : null;
  if (!awaitedSeat) return null;
  const state = playerPresenceState(seatPresenceOf(room, presence, awaitedSeat, now, staleMs), now, staleMs);
  if (state.online) return null;
  return {
    seatId: awaitedSeat,
    isSelf: awaitedSeat === mySeatId,
    label: seatDisplayName(room, awaitedSeat, mySeatId),
    text: awaitedSeat === mySeatId ? TEXT.reconnectSelf : `${seatDisplayName(room, awaitedSeat, mySeatId)}の再接続を待っています`,
  };
}

export function gameView(room, mySeatId, presence = {}, options = {}) {
  const { now = Date.now(), staleMs = PRESENCE_STALE_MS, presenceReady = false } = options;
  if (!room) return null;
  const self = seatView(room, mySeatId, mySeatId, presence, now, staleMs, presenceReady);
  const others = otherSeatOrder(room, mySeatId)
    .map((seat) => seatView(room, seat, mySeatId, presence, now, staleMs, presenceReady));
  const finished = room.status === ROOM_STATUS.FINISHED;
  const reconnect = reconnectWaitingPlayer(room, presence, { mySeatId, now, staleMs, presenceReady });
  return {
    status: room.status,
    finished,
    self,
    others,
    otherCount: others.length,
    turnSeatId: room.currentTurnPlayerId || null,
    turnText: finished ? TEXT.turnFinished : `${seatDisplayName(room, room.currentTurnPlayerId, mySeatId)}の番`,
    isMyTurn: !finished && room.currentTurnPlayerId === mySeatId,
    board: boardView(room, mySeatId),
    canMakeOffer: canMakeOffer(room, mySeatId),
    canJudge: canJudge(room, mySeatId),
    targets: validTargets(room, mySeatId),
    claims: claimOptions(),
    reconnect,
    result: finished ? resultView(room, mySeatId) : null,
  };
}

/* -------------------------------------------------------------------- 結果 */

export function gatheringReasonText(reason, animalType) {
  if (reason === GATHERING_REASON.FOUR_AND_EIGHT) return `${ANIMAL_LABELS[animalType]}が4枚、全8種類がそろってしまいました`;
  if (reason === GATHERING_REASON.FOUR_OF_A_KIND) return `${ANIMAL_LABELS[animalType]}が4枚そろってしまいました`;
  return '全8種類の動物が表向きにそろってしまいました';
}
export function isGatheringResult(room) {
  // draw=true だけで集合演出を出さない。finishReasonが集合のときだけ出す。
  return room?.status === ROOM_STATUS.FINISHED && room?.finishReason === FINISH_REASON.GATHERING;
}
export function resultView(room, mySeatId) {
  if (room?.status !== ROOM_STATUS.FINISHED) return null;
  const final = room.finalResult || null;
  const gathering = isGatheringResult(room);
  const winnerIds = [...(final?.winnerPlayerIds || room.winnerPlayerIds || [])];
  const loserIds = [...(final?.loserPlayerIds || room.loserPlayerIds || [])];
  const seats = final?.players?.length
    ? final.players.map((player) => player.seatId)
    : [...(room.seatOrder || [])];
  const players = seats.map((seatId) => {
    const summary = faceUpSummary(room, seatId);
    const total = summary.reduce((sum, entry) => sum + entry.count, 0);
    return {
      seatId,
      label: seatDisplayName(room, seatId, mySeatId),
      isSelf: seatId === mySeatId,
      status: final?.players?.find((player) => player.seatId === seatId)?.status || room.playerStatus?.[seatId] || PLAYER_STATUS.ACTIVE,
      handCount: final?.players?.find((player) => player.seatId === seatId)?.handCount ?? Number(room.handCounts?.[seatId] || 0),
      faceUp: summary,
      faceUpCount: total,
      isWinner: winnerIds.includes(seatId),
      isLoser: loserIds.includes(seatId),
      verdict: gathering
        ? (loserIds.includes(seatId) ? TEXT.loserVerdict : winnerIds.includes(seatId) ? TEXT.winVerdict : '')
        : (winnerIds.includes(seatId) ? TEXT.winVerdict : ''),
    };
  });
  const winnerLabels = winnerIds.map((seatId) => seatDisplayName(room, seatId, mySeatId));
  const loserSeat = loserIds[0] || null;
  const eliminationAnimal = loserSeat
    ? dominantAnimalFor(room, loserSeat)
    : null;
  let title;
  if (gathering) title = `${TEXT.gatheringTitle} ${loserSeat ? `${seatDisplayName(room, loserSeat, mySeatId)}の負け` : ''}`.trim();
  else if (winnerLabels.length > 1) title = TEXT.tiedWinners;
  else if (winnerLabels.length === 1) title = `${winnerLabels[0]}の勝ち！`;
  else title = 'ゲーム終了';
  return {
    kind: gathering ? 'gathering' : room.finishReason === FINISH_REASON.HAND_EMPTY ? 'hand-empty' : 'too-few-active',
    gathering,
    // 集合演出（正式ロゴ）は集合成立のときだけ。
    showGatheringOverlay: gathering,
    logoPath: LOGO_PATH,
    title,
    reason: gathering
      ? gatheringReasonText(room.gatheringReason || final?.gatheringReason, eliminationAnimal)
      : room.finishReason === FINISH_REASON.HAND_EMPTY ? TEXT.handEmptyNote : TEXT.tooFewActiveNote,
    winnerPlayerIds: winnerIds,
    winnerLabels,
    winnerText: winnerLabels.length > 1 ? `${winnerLabels.join('・')}が同率で勝ち！` : winnerLabels.length === 1 ? `${winnerLabels[0]}の勝ち！` : '',
    draw: Boolean(final?.draw ?? room.draw),
    players,
    eliminationAnimal,
  };
}
// 集合の原因になった動物を、敗者の表向きカードから特定する（表示専用）。
function dominantAnimalFor(room, seatId) {
  const summary = faceUpSummary(room, seatId);
  const four = summary.find((entry) => entry.count >= 4);
  if (four) return four.animalType;
  return summary.length >= ANIMALS.length ? summary[0].animalType : (summary[0]?.animalType || null);
}

/* -------------------------------------------------------------- あそびかた */

// 3〜6人版の説明。実装済みの内容だけを書く（退出・観戦・40枚化・NPCは書かない）。
export function helpSections() {
  return [
    {
      title: 'あそぶ人とかず',
      items: [
        '3人から6人まで、全員が人間であそびます。NPCやこはるは出てきません。',
        '部屋をつくった人がホストです。ホストが「ゲーム開始」を押すと始まります。',
        '初期の手札は3人=10枚、4人=8枚、5人=6枚、6人=5枚です。',
        '配られなかったカードは山札として置かれますが、ゲーム中はだれも引きません。',
      ],
    },
    {
      title: '手番のやりかた',
      items: [
        '① 手札からカードを1枚えらぶ ② 何の動物かを宣言する ③ 自分以外の参加中のだれかに渡す、の3ステップです。',
        '渡す相手は自分以外の参加中の人からえらびます（最大5人）。',
        '宣言は本当でも、うそでもかまいません。',
      ],
    },
    {
      title: '判定',
      items: [
        '受け取った本人だけが「ほんと？」「うそ！」で判定します。ほかの人は判定できません。',
        '判定成功 → 渡した人が、判定失敗 → 受け取った人が、表向きでカードをもらいます。',
      ],
    },
    {
      title: 'もふもふ大集合！',
      items: [
        '表向きでもらったカードで、同じ動物が4枚、または8種類すべてがそろうと「もふもふ大集合！」です。',
        'あなたの手札に同じ動物が4枚あっても、それだけでは負けになりません。手札は集合判定に含みません。',
        '集合成立でその場でゲームは終わり、敗者以外の全員が勝ちです。',
      ],
    },
    {
      title: '手札が0枚になったら',
      items: [
        'だれかの手札が0枚になると、その時点でゲームは終わります。',
        'このときは集合演出は出ません。表向きカードの合計が最も少ない人の勝ちです。',
        '最少が同じ人は、同率で全員勝ちとして名前を表示します。',
      ],
    },
    {
      title: 'つうしんが切れたとき',
      items: [
        '通信が切れても負けにはなりません。ゲームからも外れません。',
        '「再接続待ち」と出ている人が手番や判定の人のときは、その人が戻ってくるまで待ちます。',
        '「あなたの再接続を待っています」と出たら、そのまま待つと元の席に戻ります。',
      ],
    },
    {
      title: 'まだできること',
      items: [
        'この3〜6人版は、まだゲームの途中で抜けることはできません。',
        '部屋を閉じる機能もまだありません。ゲームが終わるまでそのまま遊んでください。',
      ],
    },
  ];
}
export function helpTextFlat() {
  return helpSections().flatMap((section) => [section.title, ...section.items]);
}
