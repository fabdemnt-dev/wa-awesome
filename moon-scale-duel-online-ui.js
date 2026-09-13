const ids = ['entry', 'lobby', 'started'];
export const el = (id) => document.getElementById(id);
function hidden(node, value) { node.hidden = value; }
export function show(id) { ids.forEach((item) => hidden(el(item), item !== id)); }
export function status(text) { el('status').textContent = text; }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }

export function lobby(snapshot) {
  show('lobby');
  el('shown-code').textContent = snapshot.inviteCode || '参加済み';
  el('members').innerHTML = snapshot.seats.map((seat) => `<li><strong>${seat.seatId === snapshot.you.seatId ? 'あなた' : '対手'}</strong><span>${seat.occupied ? escapeHtml(seat.displayName) : '相手の参加待ち'}</span></li>`).join('');
  const isHost = snapshot.you.role === 'host';
  hidden(el('start-match'), !isHost);
  el('start-match').disabled = snapshot.room.humanCount !== 2;
  el('lobby-note').textContent = isHost
    ? snapshot.room.humanCount === 2 ? '2人揃いました。決闘を開始できます。' : '対手が参加するまでお待ちください。'
    : 'ホストが決闘を始めるまでお待ちください。';
}

export function started(snapshot) {
  show('started');
  const opponent = snapshot.seats.find((seat) => seat.seatId !== snapshot.you.seatId);
  el('started-you').textContent = snapshot.you.displayName;
  el('started-opponent').textContent = opponent?.displayName || '対手';
  el('started-state').textContent = `第 ${snapshot.game.round} ラウンド開始前`;
}
