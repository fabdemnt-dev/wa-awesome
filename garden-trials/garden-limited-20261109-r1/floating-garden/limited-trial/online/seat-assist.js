// Limited-trial UI only. No transport, authentication, storage or game mutation.
// Every action clicks a fresh visible button through mountOnline's normal guards.
export const seatAssistPanel = `<section class="panel" aria-label="この席の試験補助"><h2>この席の試験補助</h2><p>自庭に置く・招かず見守る・瞑想・最後の石を見送る、を順に選びます。相手の席は操作しません。</p><button type="button" data-action="seat-assist-start">この席の操作を進める</button><button type="button" data-action="seat-assist-stop" disabled>止める</button><p data-seat-assist-status role="status" aria-live="polite">停止中</p><p>通信不明・画面を離れたとき・対戦終了で止まります。復帰しても自動再開しません。送信済みの操作は取り消しません。</p></section>`;

export function createSeatAssist({ root, getState, getEpoch, delay = 350, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const document = root.ownerDocument;
  let active = false, disposed = false, timer = null, clicking = false, flight = null, identity = null, preview = null;
  let message = '停止中';
  const key = s => JSON.stringify([s.uid, s.room?.id, s.room?.gameId, s.self?.seat]);
  const mode = s => s.room?.playerCount === 2 && (s.room.humanSeatCount ?? 2) === 2 && (s.room.npcCount ?? 0) === 0
    && s.room.match?.players?.length === 2 && s.room.match.players.every(p => p.isHuman === true)
    && [0, 1].includes(s.self?.seat) && Boolean(s.uid && s.room.id && s.room.gameId);
  function reason(s, starting = false) {
    if (disposed || !root.isConnected || root.inert || root.closest('[inert], [aria-disabled="true"]')) return '画面を離れたため停止しました';
    if (document.visibilityState !== 'visible') return '画面が非表示になったため停止しました';
    if (!mode(s) || (identity && key(s) !== identity)) return '席・部屋・試合が変わったため停止しました';
    if (s.terminal || s.room.status !== 'playing' || s.room.match.phase === 'finished') return '対戦が終了したため停止しました';
    if (s.error || s.storageIssue || !['ready', 'syncing'].includes(s.connection)) return '接続の確認が必要なため停止しました';
    if (s.ui.comparison || s.ui.returnConfirm) return '画面の操作を確認するため停止しました';
    const ownSend = !starting && (clicking || flight);
    if ((s.pending || s.busy || s.connection !== 'ready' || !s.canConfirm) && !ownSend) return '送信・復帰の確認が必要なため停止しました';
    if (starting && (s.ui.pending || s.ui.stone || s.ui.rotation)) return '仮置き・石・回転を解除してから開始してください';
    return null;
  }
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function paint() {
    const s = getState(), start = root.querySelector('[data-action="seat-assist-start"]'), stop = root.querySelector('[data-action="seat-assist-stop"]');
    if (start) start.disabled = active || Boolean(flight) || Boolean(reason(s, true));
    if (stop) stop.disabled = !active;
    const status = root.querySelector('[data-seat-assist-status]');
    if (status) status.textContent = active ? (flight || clicking ? 'この席の送信を待っています' : '進行中 · この席の選択ができるまで待ちます') : message;
  }
  function stop(why = '停止しました。再開には開始ボタンを押してください') {
    active = false; cancelTimer(); identity = null; preview = null; message = why; paint();
  }
  function update() {
    if (disposed) return;
    if (active) {
      const why = reason(getState());
      if (why) { stop(why); return; }
      if (!flight && !clicking && timer === null) timer = setTimer(tick, delay);
    }
    paint();
  }
  const visible = b => b && root.contains(b) && !b.disabled && !b.hidden && b.getClientRects().length > 0
    && !b.closest('[inert], [hidden], [aria-hidden="true"]') && document.defaultView.getComputedStyle(b).visibility === 'visible';
  function candidate(s) {
    const match = s.room.match;
    // Opponent turns have no enabled controls; never inspect/click their board.
    if (root.querySelector('#online-controls .waiting-label')) return null;
    const commands = { source: 'command-draw', choose: 'command-self', 'invite-response': 'command-pass-invite', care: 'command-meditate', 'final-stone': 'command-pass-final' };
    if (match.step === 'place') {
      if (s.ui.pending) {
        if (!preview || preview.revision !== match.revision || preview.index !== s.ui.pending.index || s.ui.pending.type !== 'tile' || s.ui.rotation !== 0) { stop('仮置きが変わったため停止しました'); return null; }
        return root.querySelector('#online-controls [data-action="commit"]');
      }
      return [...root.querySelectorAll('.workbench .garden-section button.cell.empty[data-action="cell"]')].find(visible);
    }
    if (commands[match.step]) return root.querySelector(`#online-controls [data-action="${commands[match.step]}"]`);
    stop('この選択は手動で確認してください'); return null;
  }
  function tick() {
    timer = null;
    if (!active || disposed) return;
    const s = getState(), why = reason(s);
    if (why) { stop(why); return; }
    if (flight || clicking) return;
    const b = candidate(s);
    if (!active) return;
    if (visible(b) && b.dataset.epoch === String(getEpoch()) && b.dataset.revision === String(s.room.match.revision)) {
      if (b.dataset.action === 'cell') preview = { revision: s.room.match.revision, index: Number(b.dataset.index) };
      // Mark before click: controller synchronously publishes normal pending state.
      clicking = true;
      try { b.click(); } catch { stop('操作を確認できないため停止しました'); }
      finally { clicking = false; }
    }
    update();
  }
  return {
    get dispatching() { return clicking; },
    get running() { return active; },
    start() {
      if (active || flight || disposed) return false;
      const s = getState(), why = reason(s, true);
      if (why) { message = why; paint(); return false; }
      identity = key(s); active = true; preview = null; update(); return true;
    },
    stop, update,
    track(result) {
      if (!clicking) return;
      if (!result || typeof result.then !== 'function') {
        if (result !== true && active) stop('操作を受け付けなかったため停止しました');
        return;
      }
      const current = Promise.resolve(result); flight = current;
      current.then(ok => { if (ok !== true && active) stop('操作の結果を確認するため停止しました'); }, () => { if (active) stop('通信の結果を確認するため停止しました'); })
        .finally(() => { if (flight === current) flight = null; update(); });
    },
    dispose() { stop('画面を離れたため停止しました'); disposed = true; },
  };
}
