// Client controller and production handlers linked through the in-memory transaction
// fixture. This checks their actual contract, not Auth/Callable transport or rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createOnlineController, ONLINE_SAVE_KEY } from '../lab/floating-garden/online/controller.js';
import { getDecision, legalActions, rankMatch } from '../lab/floating-garden/match-engine.js';
import { chooseCpuAction } from '../lab/floating-garden/cpu.js';
import { createMemoryStore } from './helpers/floating-garden-store.mjs';
const require = createRequire(import.meta.url);
const { createHandlers } = require('../functions/floating-garden-online/handlers.js');
const names = { create: 'floatingGardenCreateRoom', join: 'floatingGardenJoinRoom', start: 'floatingGardenStartMatch', getSnapshot: 'floatingGardenGetSnapshot', submit: 'floatingGardenSubmitAction' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('actual client/server contract completes a linked two-human match with lost create/action responses and reloads', async () => {
  const db = createMemoryStore();
  const handlers = createHandlers({ db, inviteSecret: () => 'linked-controller-test-only-hmac-key-not-production' });
  const values = [new Map(), new Map()];
  const dropNext = [null, null];
  const controllers = [];
  function client(seat) {
    const uid = `linked-player-${seat}`;
    const storage = { getItem: (key) => values[seat].get(key) ?? null, setItem: (key, value) => values[seat].set(key, value) };
    const api = Object.fromEntries(Object.entries(names).map(([kind, method]) => [kind, async (payload) => {
      const result = await handlers[method]({ auth: { uid }, data: payload, rawRequest: { ip: '127.0.0.1' } });
      if (dropNext[seat] === kind) { dropNext[seat] = null; throw Object.assign(new Error('Lost accepted response'), { code: 'unavailable' }); }
      return result;
    }]));
    return createOnlineController({ api, ensureUser: async () => ({ uid }), storage, requestId: randomUUID,
      subscribe: (roomId, next) => db.subscribe(`floatingGardenRooms/${roomId}`, (snapshot) => next({ room: snapshot.exists ? snapshot.data() : null, fromCache: false })),
    });
  }
  try {
    controllers[0] = client(0); await controllers[0].resume();
    dropNext[0] = 'create'; assert.equal(await controllers[0].create('Linked host'), false);
    const pendingCreate = JSON.parse(values[0].get(ONLINE_SAVE_KEY)).pending;
    assert.equal(controllers[0].getState().room, null);
    controllers[0].dispose(); controllers[0] = client(0); await controllers[0].resume();
    assert.equal(controllers[0].getState().room.players.length, 1);
    assert.ok(controllers[0].getState().inviteCode.startsWith('FG1-'));
    assert.equal(db.paths().filter((path) => /^floatingGardenRooms\/[^/]+$/.test(path)).length, 1);
    assert.equal(JSON.parse(values[0].get(ONLINE_SAVE_KEY)).pending, null);
    assert.ok(pendingCreate.payload.requestId);
    controllers[1] = client(1); await controllers[1].resume();
    await controllers[1].join(controllers[0].getState().inviteCode, 'Linked guest'); await tick();
    await controllers[0].start(); await tick();
    dropNext[0] = 'submit'; assert.equal(await controllers[0].submit('draw'), false); await tick();
    const request = controllers[0].getState().pending;
    assert.ok(request); assert.equal(controllers[0].getState().canConfirm, false);
    assert.equal(await controllers[0].submit('self'), false);
    await controllers[0].resume(); await tick();
    assert.equal(controllers[0].getState().room.match.revision, 1);
    assert.equal(controllers[0].getState().pending, null);
    assert.equal(await controllers[0].submit('offer', { target: 1 }), true); await tick();
    const before = controllers[1].getState().room.match;
    controllers[1].dispose(); controllers[1] = client(1); await controllers[1].resume();
    assert.deepEqual(controllers[1].getState().room.match, before);
    assert.equal(await controllers[1].submit('accept'), true); await tick();
    let actions = 0;
    while (controllers[0].getState().room.status !== 'finished') {
      assert.ok(++actions < 600);
      const state = controllers[0].getState().room.match;
      const decision = getDecision(state);
      const action = chooseCpuAction(state, legalActions(state));
      const { type, seat, revision, ...extra } = action;
      assert.equal(seat, decision.seat);
      assert.equal(await controllers[seat].submit(type, extra, revision), true);
      await tick();
      if (actions % 19 === 0) {
        const target = actions % 2;
        const saved = controllers[target].getState().room;
        controllers[target].dispose(); controllers[target] = client(target); await controllers[target].resume();
        assert.deepEqual(controllers[target].getState().room, saved);
      }
    }
    assert.deepEqual(controllers[0].getState().room, controllers[1].getState().room);
    const room = controllers[0].getState().room;
    assert.deepEqual(room.scores, rankMatch(room.match));
    assert.ok(room.match.players.every((player) => player.garden.every(Boolean)));
    assert.equal(Object.hasOwn(room.match, 'deck'), false);
    assert.equal(Object.hasOwn(room.match, 'seed'), false);
    assert.equal(new Set(room.match.players.map((player) => player.careCount)).size, 1);
  } finally { controllers.forEach((controller) => controller?.dispose()); }
});
