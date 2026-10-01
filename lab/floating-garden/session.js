import { applyPlacement, createGarden, createTile, scoreGarden, STONES, validateGarden } from './engine.js?v=20261001-cpu-matches';

export function createSession(garden = createGarden()) {
  validateGarden(garden);
  return { garden: garden.map((cell) => cell && { ...cell }), history: [], selection: { type: 'tile', tile: createTile('cloud') }, pending: null };
}

export function displayedGarden(session) {
  return session.pending ? applyPlacement(session.garden, session.pending) : session.garden;
}

/** All UI actions are deterministic. Rejected actions leave the session unchanged. */
export function updateSession(session, action) {
  try {
    if (action.type === 'select-tile') {
      return { session: { ...session, selection: { type: 'tile', tile: createTile(action.terrain, action.shape, action.rotation) }, pending: null }, message: '地形を選びました。空いているマスを選んでください' };
    }
    if (action.type === 'select-stone') {
      if (!Object.hasOwn(STONES, action.stone)) throw new Error('石を選んでください');
      if (session.garden.some((cell) => cell?.stone === action.stone)) throw new Error('この石はすでに庭にあります');
      return { session: { ...session, selection: { type: 'stone', stone: action.stone }, pending: null }, message: '石を選びました。地形のあるマスを選んでください' };
    }
    if (action.type === 'rotate') {
      if (session.selection.type !== 'tile') throw new Error('回転する地形を選んでください');
      const tile = createTile(session.selection.tile.terrain, session.selection.tile.shape, session.selection.tile.rotation + 1);
      return { session: { ...session, selection: { type: 'tile', tile }, pending: session.pending ? { ...session.pending, tile } : null }, message: '地形を90度回しました' };
    }
    if (action.type === 'preview') {
      const command = { ...session.selection, index: action.index };
      applyPlacement(session.garden, command);
      return { session: { ...session, pending: command }, message: '仮置きしました。得点を見てから確定できます' };
    }
    if (action.type === 'cancel') {
      return { session: { ...session, pending: null }, message: '仮置きを取り消しました' };
    }
    if (action.type === 'commit') {
      if (!session.pending) throw new Error('先に置くマスを選んでください');
      const garden = applyPlacement(session.garden, session.pending);
      const selection = session.selection.type === 'stone' ? { type: 'tile', tile: createTile('cloud') } : session.selection;
      return { session: { ...session, garden, selection, pending: null, history: [...session.history, session.garden] }, message: scoreGarden(garden).filled === 16 ? '庭が埋まりました。残った石も試せます' : '配置を確定しました' };
    }
    if (action.type === 'undo') {
      if (session.pending) throw new Error('仮置きを取り消してから戻してください');
      if (!session.history.length) throw new Error('戻せる配置がありません');
      return { session: { ...session, garden: session.history.at(-1), history: session.history.slice(0, -1) }, message: 'ひとつ前の配置に戻しました（試作の検証用）' };
    }
    throw new Error('操作を確認してください');
  } catch (error) {
    return { session, error: error.code || 'invalid-action', message: error.message };
  }
}
