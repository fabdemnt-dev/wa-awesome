import { applyPlacement, createTile } from './engine.js?v=20261002-match-save';
import { createMatch, applyMatchAction, getDecision, legalActions, publicMatch } from './match-engine.js?v=20261002-match-save';
import { chooseCpuAction } from './cpu.js?v=20261002-match-save';
import { createMatchSaveStore, encodeMatchSave, SAVE_KEY } from './match-save.js?v=20261002-match-save';
import { renderMatch, renderMatchSetup } from './match-view.js?v=20261002-match-save';

export function mountMatch(root, { seed = globalThis.crypto?.randomUUID?.() ?? `garden-${Date.now()}`, saveStore = null, now = () => Date.now() } = {}) {
  let state = null;
  let generation = 0;
  let config = { playerCount: 4, seed: String(seed) };
  let ui = freshUi();
  let savedPage = null;
  let returnFocus = null;
  let mounted = true;
  const document = root.ownerDocument;
  const page = document.defaultView;
  let storage = null;
  try { storage = page?.localStorage; } catch { /* Privacy settings can deny even the property getter. */ }
  const store = saveStore || createMatchSaveStore({ storage, locks: page?.navigator?.locks });
  let recovery = store.read();
  let expectedRaw = recovery.raw;
  let actions = [];
  let saveRevision = recovery.snapshot?.saveRevision ?? 0;
  let savedAt = recovery.snapshot?.savedAt ?? null;
  let saving = store.available && recovery.status !== 'unavailable' ? 'ready' : 'off';
  let saveIssue = null;
  let acquiring = false;
  let replacementApproved = false;
  const saveInfo = () => ({ recovery, saving, issue: saveIssue, savedAt, acquiring, confirm: ui.confirm === 'start' });
  function persist() {
    if (!state || saving === 'off' || saveIssue) return;
    let text;
    const at = now();
    try { text = encodeMatchSave({ state, actions, assist: ui.assist, saveRevision: saveRevision + 1, savedAt: at }); }
    catch { saveIssue = 'failed'; return; }
    const result = store.write(expectedRaw, text);
    if (result.status === 'saved') { expectedRaw = result.raw; saveRevision += 1; savedAt = at; saving = 'saved'; }
    else saveIssue = result.status === 'conflict' ? 'conflict' : 'failed';
  }
  function reloadSave() {
    generation += 1; restorePage(); store.release();
    state = null; actions = []; ui = freshUi(); replacementApproved = false;
    recovery = store.read(); expectedRaw = recovery.raw;
    saveRevision = recovery.snapshot?.saveRevision ?? 0; savedAt = recovery.snapshot?.savedAt ?? null;
    saving = store.available && recovery.status !== 'unavailable' ? 'ready' : 'off'; saveIssue = null;
  }
  function activate(kind) {
    generation += 1; restorePage(); ui = freshUi(); saveIssue = null;
    if (kind === 'resume') {
      const snapshot = recovery.snapshot;
      state = structuredClone(snapshot.state); actions = structuredClone(snapshot.actions); ui.assist = snapshot.assist;
      saveRevision = snapshot.saveRevision; savedAt = snapshot.savedAt;
      config = { playerCount: state.players.length, seed: state.seed };
      ui.message = '保存したところから再開しました。仮置き・回転・石の選択は解除しています。CPUはボタンを押すまで進みません';
      if (saving !== 'off') saving = 'saved';
    } else { state = createMatch(config); actions = []; persist(); }
    replacementApproved = false;
    render(kind === 'resume' ? 'match-save-status' : 'command-draw');
  }
  function begin(kind) {
    if (acquiring || (kind === 'resume' && recovery.status !== 'valid')) return;
    if (saving === 'off') { activate(kind); return; }
    acquiring = true; const token = generation; const requestedRaw = expectedRaw; render();
    // Hold a Web Lock while this match is open. A second tab can inspect a save, but cannot replace it.
    return store.acquire().then((result) => {
      acquiring = false;
      if (!mounted || generation !== token) { store.release(); if (mounted) render(); return; }
      if (result === 'busy') { saveIssue = 'busy'; ui.confirm = null; render('reload-save'); return; }
      if (result === 'unavailable') { saving = 'off'; activate(kind); return; }
      const current = store.read();
      if (current.status === 'unavailable') { store.release(); saving = 'off'; activate(kind); return; }
      if (current.raw !== requestedRaw) {
        store.release(); recovery = current; expectedRaw = current.raw; saveRevision = current.snapshot?.saveRevision ?? 0; savedAt = current.snapshot?.savedAt ?? null; ui.confirm = null; replacementApproved = false;
        saveIssue = 'changed'; render('resume'); return;
      }
      recovery = current;
      activate(kind);
    });
  }
  function freshUi() { return { assist: false, pending: null, rotation: 0, stone: null, comparison: null, confirm: null, message: '', error: false }; }
  function restorePage() {
    if (!savedPage) return;
    document.body.style.overflow = savedPage.overflow;
    document.defaultView?.scrollTo(savedPage.x, savedPage.y);
    savedPage = null;
  }
  function render(focus) {
    if (!mounted) return;
    const details = [...root.querySelectorAll('details')].map(({ id, open }) => ({ id, open }));
    const previous = saveIssue ? 'match-save-status' : focus || document.activeElement?.dataset?.focus;
    root.innerHTML = state ? renderMatch(state, ui, saveInfo()) : renderMatchSetup(config, saveInfo());
    // An old button retained by a queued event must not affect a new match.
    root.querySelectorAll('button[data-action]').forEach((button) => { button.dataset.generation = String(generation); });
    for (const detail of details) { const next = root.querySelector(`#${detail.id}`); if (next) next.open = detail.open; }
    if (ui.comparison) root.querySelector('#match-comparison').showModal();
    if (previous) {
      const target = root.querySelector(`[data-focus="${previous}"]`) || [...root.querySelectorAll('button[data-action]')].find((button) => !button.disabled && /^(command-|cpu-next|rotate|restart|start)/.test(button.dataset.action));
      target?.focus({ preventScroll: true });
    }
  }
  function closeComparison() { if (!ui.comparison) return; ui.comparison = null; restorePage(); render(returnFocus); }
  function commitAction(action) {
    state = applyMatchAction(state, action);
    actions.push(structuredClone(action));
    ui.pending = null; ui.stone = null; ui.rotation = 0; ui.message = ''; ui.error = false;
    persist();
  }
  function actionOf(type, extra = {}) { return legalActions(state).find((action) => action.type === type && Object.entries(extra).every(([key, value]) => action[key] === value)); }
  function doCommand(type, extra) {
    const action = actionOf(type, extra);
    if (!action) throw new Error('いまはその操作を選べません');
    commitAction(action);
  }
  function advanceCpu() {
    if (!state || ui.pending || ui.comparison || ui.confirm) return;
    // Synchronous, explicitly requested, and bounded by a complete legal game.
    // No timer/promise can outlive restart, mode changes or unmount.
    let count = 0;
    while (!saveIssue && getDecision(state) && !state.players[getDecision(state).seat].isHuman) {
      if (++count > 1000) throw new Error('CPUの進行を止めました。対戦をやり直してください');
      commitAction(chooseCpuAction(publicMatch(state), legalActions(state)));
    }
    ui.message = 'CPUの手を進めました。庭の記録でやり取りを確認できます';
  }
  function reset(kind) {
    generation += 1; restorePage(); ui = freshUi();
    config = { ...config, seed: `${seed}:${generation}` };
    if (kind === 'reload') { reloadSave(); return; }
    state = kind === 'setup' ? null : createMatch(config); actions = [];
    if (kind === 'setup') { recovery = store.read(); replacementApproved = true; }
    else persist();
  }
  function onClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!mounted || !button || !root.contains(button) || button.disabled || button.dataset.generation !== String(generation)) return;
    const action = button.dataset.action;
    if (acquiring) return;
    try {
      if (action === 'reload-save') {
        if (state) { ui.confirm = 'reload'; render('cancel-reset'); }
        else { reloadSave(); render(); }
        return;
      }
      if (action === 'continue-unsaved') { saving = 'off'; saveIssue = null; store.release(); render(); return; }
      if (action === 'retry-save' && saveIssue === 'failed') { saveIssue = null; persist(); render(); return; }
      if (saveIssue && state && !ui.confirm) return;
      if (!state) {
        if (ui.confirm === 'start') {
          if (action === 'confirm-reset') { ui.confirm = null; return begin('new'); }
          if (action === 'cancel-reset') { ui.confirm = null; render('start'); }
          return;
        }
        if (/^count-[234]$/.test(action)) config.playerCount = Number(action.slice(-1));
        else if (action === 'resume') return begin('resume');
        else if (action === 'start') {
          if (expectedRaw !== null && !replacementApproved && saving !== 'off') { ui.confirm = 'start'; render('cancel-reset'); return; }
          return begin('new');
        }
        render(); return;
      }
      if (ui.comparison) {
        if (action === 'comparison-close') { closeComparison(); return; }
        if (/^compare-[123]$/.test(action) && state.players[Number(action.slice(-1))]) ui.comparison.seat = Number(action.slice(-1));
        else if (action === 'compare-pair' || action === 'compare-single') ui.comparison.pair = action === 'compare-pair';
        render(); return;
      }
      if (ui.confirm) {
        if (action === 'confirm-reset') { const kind = ui.confirm; reset(kind); render(kind === 'setup' ? 'start' : 'command-draw'); return; }
        if (action === 'cancel-reset') { const origin = ui.confirm; ui.confirm = null; render(origin); }
        return;
      }
      if (action === 'toggle-assist') { ui.assist = !ui.assist; persist(); render('toggle-assist'); return; }
      if (action === 'restart' || action === 'setup') { ui.confirm = action; render('cancel-reset'); return; }
      if (action === 'inspect' && state.players[Number(button.dataset.seat)] && !state.players[Number(button.dataset.seat)].isHuman) {
        returnFocus = button.dataset.focus;
        ui.comparison = { seat: Number(button.dataset.seat), pair: false };
        savedPage = { x: document.defaultView?.scrollX || 0, y: document.defaultView?.scrollY || 0, overflow: document.body.style.overflow };
        document.body.style.overflow = 'hidden'; render('comparison-close'); return;
      }
      if (action === 'cpu-next') { advanceCpu(); render('command-draw'); return; }
      const decision = getDecision(state);
      if (!decision || !state.players[decision.seat].isHuman) return;
      if (button.dataset.revision && Number(button.dataset.revision) !== state.revision) return;
      ui.message = ''; ui.error = false;
      if (action.startsWith('command-')) doCommand(action.slice(8));
      else if (action.startsWith('offer-')) doCommand('offer', { target: Number(action.slice(6)) });
      else if (action === 'rotate' && state.step === 'place') {
        ui.rotation = (ui.rotation + 1) % 4;
        if (ui.pending) ui.pending = { ...ui.pending, tile: createTile(state.drawn.tile.terrain, state.drawn.tile.shape, ui.rotation) };
      } else if (action.startsWith('stone-') && actionOf('stone', { stone: action.slice(6) })) { ui.stone = action.slice(6); ui.pending = null; }
      else if (action === 'cell') {
        const index = Number(button.dataset.index);
        if (state.step === 'place' && actionOf('place', { index, rotation: ui.rotation })) ui.pending = { type: 'tile', index, tile: createTile(state.drawn.tile.terrain, state.drawn.tile.shape, ui.rotation) };
        else if (ui.stone && actionOf('stone', { index, stone: ui.stone })) ui.pending = { type: 'stone', index, stone: ui.stone };
        else throw new Error('置けるマスを選んでください');
        applyPlacement(state.players[decision.seat].garden, ui.pending);
      } else if (action === 'commit' && ui.pending) {
        if (ui.pending.type === 'tile') doCommand('place', { index: ui.pending.index, rotation: ui.rotation });
        else doCommand('stone', { index: ui.pending.index, stone: ui.pending.stone });
      } else if (action === 'cancel') { ui.pending = null; ui.message = '仮置きを取り消しました'; }
      render();
    } catch (error) { ui.error = true; ui.message = error.message; render(); }
  }
  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (ui.comparison) { event.preventDefault(); closeComparison(); }
    else if (ui.confirm) { const origin = ui.confirm; ui.confirm = null; render(origin); }
    else if (ui.pending) { ui.pending = null; render(); }
  }
  function onCancel(event) { if (event.target.id === 'match-comparison') { event.preventDefault(); closeComparison(); } }
  function onStorage(event) {
    if (event.key !== SAVE_KEY && event.key !== null) return;
    if (saving === 'off' || !mounted) return;
    if (event.newValue === expectedRaw && event.key === SAVE_KEY) return;
    if (state) { saveIssue = 'conflict'; ui.confirm = null; ui.comparison = null; restorePage(); }
    else { recovery = store.read(); expectedRaw = recovery.raw; saveRevision = recovery.snapshot?.saveRevision ?? 0; savedAt = recovery.snapshot?.savedAt ?? null; ui.confirm = null; replacementApproved = false; saveIssue = 'changed'; }
    render();
  }
  function onPageHide() { generation += 1; store.release(); }
  function onPageShow(event) {
    if (!event.persisted) return;
    if (saving !== 'off') { saveIssue = 'conflict'; ui.comparison = null; ui.confirm = null; restorePage(); }
    render();
  }
  page?.addEventListener?.('storage', onStorage); page?.addEventListener?.('pagehide', onPageHide); page?.addEventListener?.('pageshow', onPageShow);
  root.addEventListener('click', onClick); root.addEventListener('keydown', onKeydown); root.addEventListener('cancel', onCancel, true);
  render();
  return { getState: () => state && structuredClone(state), getUi: () => structuredClone(ui), unmount: () => { mounted = false; generation += 1; store.release(); page?.removeEventListener?.('storage', onStorage); page?.removeEventListener?.('pagehide', onPageHide); page?.removeEventListener?.('pageshow', onPageShow); root.querySelector('#match-comparison')?.close(); restorePage(); root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKeydown); root.removeEventListener('cancel', onCancel, true); } };
}
const root = document.querySelector('#match-app');
if (root) mountMatch(root);
