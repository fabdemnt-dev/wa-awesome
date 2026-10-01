import { applyPlacement, createTile } from './engine.js?v=20261001-rule-examples';
import { createMatch, applyMatchAction, getDecision, legalActions, publicMatch } from './match-engine.js?v=20261001-rule-examples';
import { chooseCpuAction } from './cpu.js?v=20261001-rule-examples';
import { renderMatch, renderMatchSetup } from './match-view.js?v=20261001-rule-examples';

export function mountMatch(root, { seed = globalThis.crypto?.randomUUID?.() ?? `garden-${Date.now()}` } = {}) {
  let state = null;
  let generation = 0;
  let config = { playerCount: 4, seed: String(seed) };
  let ui = freshUi();
  let savedPage = null;
  let returnFocus = null;
  let mounted = true;
  const document = root.ownerDocument;
  function freshUi() { return { pending: null, rotation: 0, stone: null, comparison: null, confirm: null, message: '', error: false }; }
  function restorePage() {
    if (!savedPage) return;
    document.body.style.overflow = savedPage.overflow;
    document.defaultView?.scrollTo(savedPage.x, savedPage.y);
    savedPage = null;
  }
  function render(focus) {
    if (!mounted) return;
    const details = [...root.querySelectorAll('details')].map(({ id, open }) => ({ id, open }));
    const previous = focus || document.activeElement?.dataset?.focus;
    root.innerHTML = state ? renderMatch(state, ui) : renderMatchSetup(config);
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
    ui.pending = null; ui.stone = null; ui.rotation = 0; ui.message = ''; ui.error = false;
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
    while (getDecision(state) && !state.players[getDecision(state).seat].isHuman) {
      if (++count > 1000) throw new Error('CPUの進行を止めました。対戦をやり直してください');
      commitAction(chooseCpuAction(publicMatch(state), legalActions(state)));
    }
    ui.message = 'CPUの手を進めました。庭の記録でやり取りを確認できます';
  }
  function reset(kind) {
    generation += 1; restorePage(); ui = freshUi();
    config = { ...config, seed: `${seed}:${generation}` };
    state = kind === 'setup' ? null : createMatch(config);
  }
  function onClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!mounted || !button || !root.contains(button) || button.disabled || button.dataset.generation !== String(generation)) return;
    const action = button.dataset.action;
    try {
      if (!state) {
        if (/^count-[234]$/.test(action)) config.playerCount = Number(action.slice(-1));
        else if (action === 'start') { generation += 1; state = createMatch(config); ui = freshUi(); }
        render(action === 'start' ? 'command-draw' : undefined); return;
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
  root.addEventListener('click', onClick); root.addEventListener('keydown', onKeydown); root.addEventListener('cancel', onCancel, true);
  render();
  return { getState: () => state && structuredClone(state), getUi: () => structuredClone(ui), unmount: () => { mounted = false; generation += 1; root.querySelector('#match-comparison')?.close(); restorePage(); root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKeydown); root.removeEventListener('cancel', onCancel, true); } };
}
const root = document.querySelector('#match-app');
if (root) mountMatch(root);
