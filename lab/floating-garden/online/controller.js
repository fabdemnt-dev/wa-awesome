import { applyPlacement, createTile } from '../engine.js?v=20261002-match-save';
import { getDecision, legalActions, MATCH_VERSION } from '../match-engine.js?v=20261002-match-save';

export const ONLINE_SAVE_KEY = 'floating-garden-online-recovery-v1';
const clone = (value) => structuredClone(value);
const immutable = (value) => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') immutable(child); return value; };
const freshPreview = () => ({ pending: null, rotation: 0, stone: null });
const codeOf = (error) => String(error?.code || '').replace(/^functions\//, '');
const definitive = (error) => ['invalid-argument', 'failed-precondition', 'permission-denied', 'not-found', 'unauthenticated', 'already-exists', 'out-of-range'].includes(codeOf(error));
const messages = { 'permission-denied': 'この認証では部屋を開けません。同じブラウザーの参加時の認証を確認してください', 'not-found': '部屋が見つからないか、保存期限が切れています', 'failed-precondition': '進行が更新されたため操作を受け付けませんでした。最新の状態を確認してください', 'invalid-argument': '名前・招待コード・操作内容を確認してください', unauthenticated: '認証を確認できませんでした。再接続してください', 'resource-exhausted': '少し待ってから、同じ操作の結果を確認してください' };
const problem = (error) => messages[codeOf(error)] || '通信の結果を確認できません。同じ操作の結果を確認するまで、次の確定操作はできません';

/** UI-independent authoritative client. api: create/join/start/getSnapshot/submit; subscribe: roomId, next, error. */
export function createOnlineController({ api, ensureUser, subscribe = () => () => {}, storage, requestId = () => crypto.randomUUID(), isOnline = () => true } = {}) {
  let alive = true, generation = 0, listener = null, resuming = null, sending = null, suspended = false, queuedResume = null;
  let saved = null, storageIssue = null, returnTarget = null, returning = null;
  const observers = new Set();
  const state = { uid: null, room: null, self: null, connection: 'initial', pending: null, busy: false, notice: '', error: false, storageIssue: null, terminal: null, ui: { ...freshPreview(), comparison: null, returnConfirm: false } };
  try {
    if (!storage) throw new Error('storage-unavailable');
    const raw = storage.getItem(ONLINE_SAVE_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (value.version !== 1 || typeof value.uid !== 'string' || (value.roomId !== null && typeof value.roomId !== 'string') || (value.pending && (!['create', 'join', 'start', 'submit'].includes(value.pending.kind) || typeof value.pending.payload?.requestId !== 'string' || value.pending.uid !== value.uid))) throw new Error('invalid-recovery');
      if (value.pending && ['start', 'submit'].includes(value.pending.kind) && value.pending.payload.roomId !== value.roomId) throw new Error('wrong-room-recovery');
      saved = value;
    }
  } catch { storageIssue = '復帰情報を読み込めません。ブラウザーの保存設定を確認してください。保存を上書きせず停止しています'; }
  const publish = () => { if (alive) for (const observer of observers) observer(clone(state)); };
  const status = (notice, error = false) => { state.notice = notice; state.error = error; publish(); };
  const stopListener = () => { const previous = listener; listener = null; previous?.unsubscribe?.(); };
  function persist() {
    try {
      if (storageIssue) throw new Error(storageIssue);
      storage.setItem(ONLINE_SAVE_KEY, JSON.stringify(saved));
      state.storageIssue = null;
      return true;
    } catch {
      storageIssue ||= '復帰情報を保存できません。結果不明の操作を失わないため、通信操作を止めています';
      state.storageIssue = storageIssue; state.error = true; state.notice = storageIssue; publish(); return false;
    }
  }
  const canConfirm = () => alive && !returning && !sending && !resuming && !state.pending && !storageIssue && isOnline() && state.connection === 'ready' && Boolean(state.uid);
  // A lobby return only forgets this browser's recovery pointer. Keep a server-
  // confirmed, solitary host and its exact confirmation separate from terminal recovery.
  function canReturnLobby(checking = false) {
    const { room, self } = state;
    return alive && !suspended && !sending && !resuming && (!returning || checking)
      && (!state.busy || checking) && !state.pending && !saved?.pending && !storageIssue && !state.error
      && isOnline() && state.connection === 'ready' && Boolean(state.uid) && saved?.uid === state.uid
      && Boolean(room) && room.id === saved?.roomId && room.status === 'waiting'
      && room.match === null && room.gameId === null && Number.isSafeInteger(room.revision) && room.revision >= 0
      && self?.isHost === true && self.seat === room.hostSeat
      && Array.isArray(room.players) && room.players.length === 1 && room.players[0]?.seat === self.seat;
  }
  const canReturnToEntry = () => Boolean(state.terminal && !state.pending && !state.busy) || canReturnLobby();
  function invalidateLobbyReturn() {
    if (!returnTarget) return;
    returnTarget = null; state.ui.returnConfirm = false;
  }
  function returnRecoveryUnchanged(target) {
    try {
      const raw = storage.getItem(ONLINE_SAVE_KEY);
      if (!raw || JSON.stringify(JSON.parse(raw)) !== target.recovery || JSON.stringify(saved) !== target.recovery) {
        state.connection = 'conflict'; invalidateLobbyReturn();
        status('別のタブの復帰情報が変わりました。元のタブの操作を確認して、このページを再読み込みしてください', true); return false;
      }
      return true;
    } catch {
      storageIssue = '復帰情報を確認できないため操作を止めています'; state.storageIssue = storageIssue;
      invalidateLobbyReturn(); status(storageIssue, true); return false;
    }
  }
  function clearRecovery() {
    const previous = saved; saved = { version: 1, uid: state.uid, roomId: null, inviteCode: null, pending: null };
    if (!persist()) { saved = previous; return false; }
    generation += 1; stopListener(); returnTarget = null; state.room = null; state.self = null; state.terminal = null;
    state.ui = { ...freshPreview(), comparison: null, returnConfirm: false }; state.busy = false;
    state.notice = 'この端末の復帰先を解除しました'; state.error = false; state.connection = isOnline() ? 'ready' : 'offline'; publish(); return true;
  }
  function confirmLobbyReturn(target) {
    if (!canReturnLobby() || !returnRecoveryUnchanged(target)) return Promise.resolve(false);
    const token = generation;
    const current = () => state.ui.returnConfirm && returnTarget === target && token === generation
      && target.uid === state.uid && target.room === JSON.stringify(state.room) && target.self === JSON.stringify(state.self);
    state.busy = true;
    const task = Promise.resolve().then(async () => {
      try {
        if (!current() || !canReturnLobby(true)) return false;
        if (!await authenticate(token)) return false;
        // Authentication can yield while another player joins, a tab writes recovery,
        // or the page is suspended. Never use the pre-auth eligibility after that wait.
        if (!current() || !canReturnLobby(true) || !returnRecoveryUnchanged(target)) return false;
        return clearRecovery();
      } catch (error) {
        if (alive && token === generation) { state.connection = 'error'; status(problem(error), true); }
        return false;
      } finally {
        if (returning === task) returning = null;
        if (alive && (token === generation || !state.room)) { state.busy = false; publish(); }
      }
    });
    returning = task; publish(); return task;
  }
  function invalidatePreview() { Object.assign(state.ui, freshPreview()); }
  function accept(snapshot, token = generation, { fromCache = false, allowSuperseded = false } = {}) {
    if (!alive || token !== generation || !snapshot?.room || !state.uid) return false;
    const { room, self = state.self } = snapshot;
    if (!saved?.roomId || room.id !== saved.roomId || !Number.isSafeInteger(room.revision) || room.rulesVersion !== MATCH_VERSION || !self || ![0, 1].includes(self.seat) || !Array.isArray(room.players) || !room.players.some((player) => player?.seat === self.seat)) return false;
    const previous = state.room;
    if (previous?.gameId && room.gameId !== previous.gameId) return false;
    if (room.match && (room.match.version !== MATCH_VERSION || !Number.isSafeInteger(room.match.revision))) return false;
    if (state.self && state.self.seat !== self.seat) return false;
    if (previous && (room.revision < previous.revision || (previous.match && room.match && room.match.revision < previous.match.revision))) {
      // A stale cache must not roll confirmed data back or leave a ready client
      // claiming live synchronization. Preserve stronger blockers and recovery.
      if (fromCache && state.connection === 'ready' && room.revision >= 0 && (!room.match || room.match.revision >= 0) && room.gameId === previous.gameId && Boolean(room.match) === Boolean(previous.match)) {
        state.connection = 'cache'; invalidateLobbyReturn(); publish();
      }
      // A live server event may overtake an in-flight refresh. Only a fully
      // validated, consistently older reply can leave that confirmed state ready.
      return allowSuperseded && !fromCache && state.connection === 'ready'
        && room.gameId === previous.gameId && Boolean(room.match) === Boolean(previous.match)
        && room.revision >= 0 && room.revision <= previous.revision
        && (!room.match || (room.match.revision >= 0 && room.match.revision <= previous.match.revision));
    }
    if (!previous || previous.gameId !== room.gameId || previous.match?.revision !== room.match?.revision) invalidatePreview();
    if (returnTarget && (fromCache || returnTarget.room !== JSON.stringify(room) || returnTarget.self !== JSON.stringify(self))) invalidateLobbyReturn();
    state.room = clone(room); state.self = clone(self);
    if (!fromCache) state.terminal = room.status === 'finished' ? 'finished' : null;
    state.connection = fromCache ? 'cache' : isOnline() ? 'ready' : 'offline';
    publish(); return true;
  }
  function listen(token) {
    const roomId = saved?.roomId, uid = state.uid;
    const valid = () => alive && !suspended && token === generation && saved?.roomId === roomId && state.uid === uid;
    if (!valid()) return;
    // A mutation's authoritative refresh does not require restarting its live watch.
    if (listener && listener.roomId === roomId && listener.token === token && listener.uid === uid) return;
    stopListener();
    if (!roomId || !valid()) return;
    const watch = { roomId, uid, token, unsubscribe: null };
    listener = watch;
    const current = () => listener === watch && valid();
    const failed = (error) => {
      if (!current()) return;
      stopListener();
      if (!valid()) return;
      state.connection = 'error'; status(problem(error), true);
    };
    try {
      const unsubscribe = subscribe(roomId, (event) => {
        if (!current()) return;
        const room = event && Object.hasOwn(event, 'room') ? event.room : event;
        if (!room) { state.connection = 'error'; status('部屋を読み込めません。保存期限を確認してください', true); return; }
        accept({ room, self: state.self }, token, { fromCache: Boolean(event?.fromCache) });
      }, failed);
      // Synchronous callbacks can retire this watch before subscribe returns.
      if (current()) watch.unsubscribe = unsubscribe;
      else unsubscribe?.();
    } catch (error) { failed(error); }
  }
  async function authenticate(token) {
    const user = await ensureUser();
    if (!alive || token !== generation) return false;
    if (!user?.uid || (saved && saved.uid !== user.uid) || (state.uid && state.uid !== user.uid)) {
      stopListener(); state.connection = 'identity-mismatch'; status('参加時と認証が異なります。席の引き継ぎはできません。元のブラウザーの認証で開いてください', true); return false;
    }
    state.uid = user.uid;
    saved ||= { version: 1, uid: user.uid, roomId: null, inviteCode: null, pending: null };
    state.pending = saved.pending ? immutable(clone(saved.pending)) : null;
    return true;
  }
  async function refresh(token) {
    if (!saved?.roomId) { state.connection = isOnline() ? 'ready' : 'offline'; return; }
    let snapshot;
    try { snapshot = await api.getSnapshot({ roomId: saved.roomId }); }
    catch (error) {
      if (alive && token === generation && (codeOf(error) === 'not-found' || error?.details?.reason === 'room-expired')) state.terminal = 'expired';
      throw error;
    }
    if (!alive || token !== generation) return;
    if (!accept(snapshot, token, { allowSuperseded: true })) { state.connection = 'syncing'; status('新しい状態を待っています。もう一度接続を確認してください', true); }
  }
  async function sendPending(token) {
    const pending = state.pending;
    if (!pending || pending.uid !== state.uid || !isOnline()) return false;
    try {
      if (!await authenticate(token)) return false;
      const result = await api[pending.kind](clone(pending.payload));
      if (!alive || token !== generation) return false;
      if (pending.kind === 'create' || pending.kind === 'join') {
        if (!result?.roomId || ![0, 1].includes(result.seat)) throw new Error('invalid-receipt');
        saved.roomId = result.roomId;
        if (result.inviteCode) saved.inviteCode = result.inviteCode;
      }
      saved.pending = null; state.pending = null;
      if (!persist()) return false;
      state.notice = '確定した状態を同期しています'; state.error = false;
      await refresh(token);
      if (alive && token === generation) { state.notice = ''; state.error = false; listen(token); }
      return true;
    } catch (error) {
      if (!alive || token !== generation) return false;
      if (definitive(error)) {
        saved.pending = null; state.pending = null; persist();
        state.connection = 'syncing'; state.notice = problem(error); state.error = true;
        try { await refresh(token); listen(token); } catch { if (alive && token === generation) state.connection = 'error'; }
      } else { state.connection = isOnline() ? 'uncertain' : 'offline'; state.notice = problem(error); state.error = true; }
      return false;
    }
  }
  function resume() {
    if (!alive) return Promise.resolve(false);
    if (resuming || sending || returning) {
      const running = returning || sending || resuming;
      if (!suspended) return running;
      queuedResume ||= running.finally(() => { queuedResume = null; return resume(); });
      return queuedResume;
    }
    suspended = false;
    const token = ++generation; stopListener(); invalidatePreview(); invalidateLobbyReturn();
    state.connection = isOnline() ? 'syncing' : 'offline'; state.busy = true; state.storageIssue = storageIssue; publish();
    const task = Promise.resolve().then(async () => {
      try {
        if (storageIssue || !isOnline()) return false;
        if (!await authenticate(token)) return false;
        if (state.pending) return await sendPending(token);
        await refresh(token); if (alive && token === generation) listen(token); return true;
      } catch (error) { if (alive && token === generation) { state.connection = 'error'; state.notice = problem(error); state.error = true; } return false; }
      finally { if (resuming === task) resuming = null; if (alive && token === generation) { state.busy = false; publish(); } }
    });
    resuming = task; return task;
  }
  function mutate(kind, payload) {
    if (!canConfirm()) return Promise.resolve(false);
    // Observe a request saved by another tab before replacing it. Revision checking is the server's final arbiter.
    try {
      const other = storage.getItem(ONLINE_SAVE_KEY);
      const stored = other ? JSON.parse(other) : null;
      if (stored && (stored.uid !== state.uid || stored.roomId !== saved.roomId || stored.pending)) { state.connection = 'conflict'; status('別のタブの復帰情報が変わりました。元のタブの操作を確認して、このページを再読み込みしてください', true); return Promise.resolve(false); }
    } catch { storageIssue = '復帰情報を確認できないため操作を止めています'; state.storageIssue = storageIssue; publish(); return Promise.resolve(false); }
    const pending = immutable({ kind, uid: state.uid, payload: { ...clone(payload), requestId: requestId() } });
    state.pending = pending; saved.pending = clone(pending);
    if (!persist()) return Promise.resolve(false);
    state.busy = true; state.connection = 'syncing'; publish();
    const token = generation;
    const task = sendPending(token).finally(() => { if (sending === task) sending = null; if (alive && token === generation) { state.busy = false; publish(); } });
    sending = task; return task;
  }
  function ownAction(type, extra = {}) {
    const match = state.room?.match;
    if (!match || getDecision(match)?.seat !== state.self?.seat) return null;
    return legalActions(match).find((action) => action.type === type && Object.entries(extra).every(([key, value]) => action[key] === value));
  }
  function submit(type, extra = {}, expectedRevision = state.room?.match?.revision) {
    const action = ownAction(type, extra);
    if (!action || action.revision !== expectedRevision) return Promise.resolve(false);
    const { seat, revision, ...command } = action;
    return mutate('submit', { roomId: state.room.id, gameId: state.room.gameId, rulesVersion: state.room.rulesVersion, expectedRevision: revision, command });
  }
  function preview(kind, value, expectedRevision = state.room?.match?.revision) {
    if (!state.room?.match || !canConfirm() || state.room.match.revision !== expectedRevision || getDecision(state.room?.match)?.seat !== state.self?.seat) return false;
    const match = state.room.match;
    if (kind === 'cancel') state.ui.pending = null;
    else if (kind === 'rotate' && match.step === 'place') {
      state.ui.rotation = (state.ui.rotation + 1) % 4;
      if (state.ui.pending) state.ui.pending.tile = createTile(match.drawn.tile.terrain, match.drawn.tile.shape, state.ui.rotation);
    } else if (kind === 'stone' && ownAction('stone', { stone: value })) { state.ui.stone = value; state.ui.pending = null; }
    else if (kind === 'cell') {
      let pending;
      if (match.step === 'place' && ownAction('place', { index: value, rotation: state.ui.rotation })) pending = { type: 'tile', index: value, tile: createTile(match.drawn.tile.terrain, match.drawn.tile.shape, state.ui.rotation) };
      else if (state.ui.stone && ownAction('stone', { index: value, stone: state.ui.stone })) pending = { type: 'stone', index: value, stone: state.ui.stone };
      if (!pending) return false;
      applyPlacement(match.players[state.self.seat].garden, pending); state.ui.pending = pending;
    } else return false;
    state.notice = ''; state.error = false; publish(); return true;
  }
  return {
    getState: () => ({ ...clone(state), canConfirm: canConfirm(), canReturnToEntry: canReturnToEntry(), inviteCode: saved?.inviteCode || null }),
    observe(fn) { observers.add(fn); return () => observers.delete(fn); },
    resume,
    create(displayName) { if (saved?.roomId) return Promise.resolve(false); return mutate('create', { displayName: displayName.trim() }); },
    join(inviteCode, displayName) { if (saved?.roomId) return Promise.resolve(false); return mutate('join', { inviteCode: inviteCode.trim(), displayName: displayName.trim() }); },
    start(expectedRevision = state.room?.revision) { if (state.room?.status !== 'waiting' || !state.self?.isHost || state.room.players.length !== 2 || expectedRevision !== state.room.revision) return Promise.resolve(false); return mutate('start', { roomId: state.room.id, expectedRevision }); },
    submit, preview,
    commit(expectedRevision = state.room?.match?.revision) { const pending = state.ui.pending; return pending?.type === 'tile' ? submit('place', { index: pending.index, rotation: state.ui.rotation }, expectedRevision) : pending ? submit('stone', { index: pending.index, stone: pending.stone }, expectedRevision) : Promise.resolve(false); },
    compare(seat, pair = false) { if (!state.room?.match?.players.some((player) => player.seat === seat && player.seat !== state.self?.seat)) return false; state.ui.comparison = { seat, pair }; publish(); return true; },
    closeComparison() { state.ui.comparison = null; publish(); },
    offline() { state.connection = 'offline'; invalidatePreview(); invalidateLobbyReturn(); publish(); },
    suspend() { suspended = true; generation += 1; stopListener(); state.connection = 'syncing'; invalidatePreview(); invalidateLobbyReturn(); state.busy = false; publish(); },
    storageChanged() { state.connection = 'conflict'; invalidatePreview(); invalidateLobbyReturn(); status('別のタブで復帰情報が更新されました。通信が終わったらこのページを再読み込みしてください', true); },
    requestReturn() {
      if (!canReturnToEntry() || returning) return false;
      returnTarget = state.terminal ? null : { uid: state.uid, room: JSON.stringify(state.room), self: JSON.stringify(state.self), recovery: JSON.stringify(saved) };
      if (returnTarget && !returnRecoveryUnchanged(returnTarget)) return false;
      state.ui.returnConfirm = true; publish(); return true;
    },
    cancelReturn() { returnTarget = null; state.ui.returnConfirm = false; publish(); },
    returnToEntry() {
      if (!state.ui.returnConfirm || returning) return false;
      if (returnTarget) return confirmLobbyReturn(returnTarget);
      if (!state.terminal || state.pending || state.busy || storageIssue) return false;
      return clearRecovery();
    },
    dispose() { alive = false; generation += 1; stopListener(); observers.clear(); },
  };
}
