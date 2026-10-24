// Browser-only offline fixture. Synthetic seats, no Firebase or real identities.
import { createMatch, applyMatchAction, publicMatch, rankMatch } from '../../floating-garden/match-engine.js';
import { createOnlineController, ONLINE_SAVE_KEY } from '../../floating-garden/limited-trial/online/controller.js';
import { mountOnline } from '../../floating-garden/limited-trial/online/mount.js';
let previous;
export async function reset() {
  previous?.dispose();
  let engine = createMatch({ playerCount: 2, seed: 'seat-assist-browser' });
  engine.players.forEach((p, i) => { p.isHuman = true; p.name = `Fixture ${i}`; });
  let room = { id: 'local', gameId: 'game', playerCount: 2, humanSeatCount: 2, npcCount: 0, hostSeat: 0, revision: 3, rulesVersion: engine.version, status: 'playing', match: publicMatch(engine), players: engine.players.map(({ seat, name, isHuman }) => ({ seat, name, isHuman })), scores: [], expiresAtMillis: Date.now() + 3600000 };
  const listeners = new Set(), receipts = new Map(), stores = [new Map(), new Map()], roots = [0, 1].map(i => document.querySelector(`#seat${i}`));
  const clients = [], mounts = [], calls = [], flags = { delay: 0, lose: false, reject: false };
  let serial = 0;
  const publish = () => { for (const fn of listeners) fn({ room: structuredClone(room) }); };
  function mount(seat) {
    const controller = createOnlineController({
      ensureUser: async () => ({ uid: `fixture-${seat}` }),
      storage: { getItem: k => stores[seat].get(k) || null, setItem: (k, v) => stores[seat].set(k, v) },
      requestId: () => `request-${++serial}`,
      subscribe: (_id, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      api: {
        async getSnapshot() { return { room: structuredClone(room), self: { seat, isHost: seat === 0 } }; },
        async submit(payload) {
          calls.push({ seat, ...structuredClone(payload) });
          if (flags.delay) await new Promise(r => setTimeout(r, flags.delay));
          if (receipts.has(payload.requestId)) return receipts.get(payload.requestId);
          if (flags.reject) throw Object.assign(Error('fixture rejection'), { code: 'failed-precondition' });
          engine = applyMatchAction(engine, { ...payload.command, seat, revision: payload.expectedRevision });
          room = { ...room, revision: room.revision + 1, match: publicMatch(engine), status: engine.phase === 'finished' ? 'finished' : 'playing', scores: engine.phase === 'finished' ? rankMatch(engine) : [] };
          receipts.set(payload.requestId, { ok: true }); publish();
          if (flags.lose) { flags.lose = false; throw Object.assign(Error('fixture lost response'), { code: 'unavailable' }); }
          return { ok: true };
        },
      },
    });
    clients[seat] = controller; mounts[seat] = mountOnline(roots[seat], { controller }); return mounts[seat].ready;
  }
  for (let seat = 0; seat < 2; seat++) {
    stores[seat].set(ONLINE_SAVE_KEY, JSON.stringify({ version: 1, uid: `fixture-${seat}`, roomId: 'local', pending: null }));
    await mount(seat);
  }
  previous = {
    flags, clients, roots, calls,
    get room() { return structuredClone(room); },
    async reload(seat) { mounts[seat].unmount(); await mount(seat); },
    changeGame() { room.gameId = 'changed'; publish(); },
    state(seat) { return clients[seat].getState(); },
    status(seat) { return roots[seat].querySelector('[data-seat-assist-status]').textContent; },
    click(seat, action) { const b = roots[seat].querySelector(`[data-action="${action}"]`); if (!b || b.disabled) throw Error(`unavailable ${seat}:${action}`); b.click(); },
    dispose() { mounts.forEach(m => m.unmount()); },
  };
  return previous;
}
