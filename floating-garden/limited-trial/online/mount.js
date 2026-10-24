import { validateEntryMode } from './entry-mode.js';
import { renderOnline } from './view.js?v=20261023-shared-objectives-1';
import { ONLINE_SAVE_KEY, ONLINE_PARKED_KEY } from './controller.js?v=20261023-shared-objectives-1';
import { createSeatAssist, seatAssistPanel } from './seat-assist.js?v=20261024-seat-assist-1';

/** DOM lifecycle separated from Firebase so the same UI can be exercised against emulator/test services. */
export function mountOnline(root, { controller, initialMode = null } = {}) {
  const document = root.ownerDocument, page = document.defaultView;
  let mounted = true, renderEpoch = 0, returnFocus = null, savedPage = null, lastFocus = null;
  const assist = createSeatAssist({ root, getState: () => controller.getState(), getEpoch: () => renderEpoch });
  const selectedMode = validateEntryMode(initialMode, { threeHumanModesReady: true, fourHumanModesReady: true });
  const fields = { displayName: '', inviteCode: '', humanSeatCount: selectedMode?.humanSeatCount ?? 2, npcCount: selectedMode?.npcCount ?? 0 };
  function restorePage() {
    if (!savedPage) return;
    document.body.style.overflow = savedPage.overflow;
    page?.scrollTo?.(savedPage.x, savedPage.y); savedPage = null;
  }
  function render() {
    if (!mounted) return;
    const state = controller.getState();
    const focus = document.activeElement?.dataset?.focus || lastFocus;
    if (focus) lastFocus = focus;
    const details = [...root.querySelectorAll('details')].map(({ id, open }) => ({ id, open }));
    renderEpoch += 1;
    root.innerHTML = seatAssistPanel + renderOnline(state, fields);
    root.querySelectorAll('button[data-action]').forEach((button) => {
      button.dataset.epoch = String(renderEpoch);
      if (!button.dataset.revision && state.room?.match) button.dataset.revision = String(state.room.match.revision);
    });
    assist.update();
    for (const item of details) { const next = root.querySelector(`#${item.id}`); if (next) next.open = item.open; }
    const modal = root.querySelector('#online-comparison');
    if (modal) {
      if (!savedPage) { savedPage = { x: page?.scrollX || 0, y: page?.scrollY || 0, overflow: document.body.style.overflow }; document.body.style.overflow = 'hidden'; }
      if (modal.showModal) modal.showModal(); else modal.setAttribute('open', '');
    } else restorePage();
    if (focus) {
      const retained = root.querySelector(`[data-focus="${focus}"]`);
      const next = retained && !retained.disabled ? retained : [...root.querySelectorAll('button[data-action]')].find((item) => !item.disabled && /^(command-|commit|rotate|resume|start)/.test(item.dataset.action));
      next?.focus({ preventScroll: true });
    }
  }
  const unobserve = controller.observe(render);
  function closeComparison() { lastFocus = returnFocus; controller.closeComparison(); root.querySelector(`[data-focus="${returnFocus}"]`)?.focus({ preventScroll: true }); }
  function onInput(event) {
    assist.stop('手動操作のため停止しました');
    if (event.target.id === 'online-name') fields.displayName = event.target.value;
    if (event.target.id === 'online-code') fields.inviteCode = event.target.value;
    if (event.target.id === 'online-room-mode') {
      const [humans, npcs] = event.target.value.split('-').map(Number);
      try { validateEntryMode({ id: event.target.value, humanSeatCount: humans, npcCount: npcs }, controller.getState()); } catch { return; }
      fields.humanSeatCount = humans; fields.npcCount = npcs; render();
    }
  }
  function handleClick(event) {
    const target = event.target.closest('button[data-action]');
    if (!mounted || !target || !root.contains(target) || target.disabled || target.dataset.epoch !== String(renderEpoch)) return;
    const action = target.dataset.action, state = controller.getState();
    const revision = Number(target.dataset.revision);
    if (action === 'seat-assist-start') return assist.start();
    if (action === 'seat-assist-stop') return assist.stop();
    if (!assist.dispatching) assist.stop('手動操作のため停止しました');
    if (action === 'jump-controls') {
      const controls = root.querySelector('#online-controls');
      controls?.scrollIntoView({ block: 'start', behavior: 'auto' });
      controls?.focus({ preventScroll: true });
      return;
    }
    if (action === 'resume') return controller.resume();
    if (action === 'park-room') return controller.requestSwitch();
    if (action === 'restore-room') return controller.requestSwitch(target.dataset.roomId);
    if (action === 'confirm-switch') return controller.confirmSwitch();
    if (action === 'return-entry') return controller.requestReturn();
    if (action === 'cancel-return') return controller.cancelReturn();
    if (action === 'confirm-return') return controller.returnToEntry();
    if (action === 'create') {
      try { validateEntryMode({ id: `${fields.humanSeatCount}-${fields.npcCount}`, humanSeatCount: fields.humanSeatCount, npcCount: fields.npcCount }, state); } catch { return; }
      return controller.create(fields.displayName, fields.npcCount, fields.humanSeatCount);
    }
    if (action === 'join') return controller.join(fields.inviteCode, fields.displayName);
    if (action === 'start') return controller.start(Number(target.dataset.roomRevision));
    if (action === 'inspect') { returnFocus = target.dataset.focus; controller.compare(Number(target.dataset.seat)); root.querySelector('[data-action="comparison-close"]')?.focus(); return; }
    if (action === 'comparison-close') return closeComparison();
    if (action === 'compare-single' || action === 'compare-pair') return controller.compare(state.ui.comparison?.seat, action === 'compare-pair');
    if (state.ui.comparison) return;
    if (action.startsWith('command-')) return controller.submit(action.slice(8), {}, revision);
    if (action.startsWith('offer-')) return controller.submit('offer', { target: Number(action.slice(6)) }, revision);
    if (action.startsWith('stone-')) return controller.preview('stone', action.slice(6), revision);
    if (action === 'cell') return controller.preview('cell', Number(target.dataset.index), revision);
    if (action === 'rotate' || action === 'cancel') return controller.preview(action, null, revision);
    if (action === 'commit') return controller.commit(revision);
  }
  function onClick(event) { const result = handleClick(event); assist.track(result); return result; }
  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    assist.stop('手動操作のため停止しました');
    if (controller.getState().ui.comparison) { event.preventDefault(); closeComparison(); }
    else if (controller.getState().ui.returnConfirm) { event.preventDefault(); controller.cancelReturn(); }
    else controller.preview('cancel');
  }
  function onCancel(event) { if (event.target.id === 'online-comparison') { event.preventDefault(); closeComparison(); } }
  const resume = () => controller.resume();
  const visible = () => { if (document.visibilityState === 'visible') return resume(); assist.stop('画面が非表示になったため停止しました'); controller.cancelReturn(); };
  const offline = () => { assist.stop('オフラインのため停止しました'); controller.offline(); };
  const hide = () => { assist.stop('画面を離れたため停止しました'); controller.suspend(); };
  const storage = (event) => { if (event.key === ONLINE_SAVE_KEY || event.key === ONLINE_PARKED_KEY || event.key === null) { assist.stop('復帰情報が変わったため停止しました'); controller.storageChanged(); } };
  root.addEventListener('input', onInput); root.addEventListener('click', onClick); root.addEventListener('keydown', onKeydown); root.addEventListener('cancel', onCancel, true);
  document.addEventListener('visibilitychange', visible);
  for (const [name, handler] of [['online', resume], ['offline', offline], ['pageshow', resume], ['pagehide', hide], ['storage', storage]]) page?.addEventListener(name, handler);
  render();
  return { controller, ready: controller.resume(), unmount() {
    assist.dispose();
    mounted = false; renderEpoch += 1; unobserve(); controller.dispose(); root.querySelector('#online-comparison')?.close?.(); restorePage();
    root.removeEventListener('input', onInput); root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKeydown); root.removeEventListener('cancel', onCancel, true);
    document.removeEventListener('visibilitychange', visible);
    for (const [name, handler] of [['online', resume], ['offline', offline], ['pageshow', resume], ['pagehide', hide], ['storage', storage]]) page?.removeEventListener(name, handler);
  } };
}
