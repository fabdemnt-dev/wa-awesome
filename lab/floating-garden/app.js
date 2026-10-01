import { createExampleGarden, createGarden } from './engine.js?v=20261001-cpu-matches-r2';
import { createSession, updateSession } from './session.js?v=20261001-cpu-matches-r2';
import { renderComparison, renderSession } from './view.js?v=20261001-cpu-matches-r2';
import { createTableDemo } from './table-demo.js?v=20261001-cpu-matches-r2';

export function mountGarden(root) {
  let session = createSession();
  let message = '';
  let error = false;
  let replacement = null;
  const table = createTableDemo();
  let tableVisible = false;
  let comparison = null;
  let returnFocus = null;
  let savedPage = null;
  const document = root.ownerDocument;

  function lockPage() {
    const window = document.defaultView;
    savedPage = { x: window?.scrollX || 0, y: window?.scrollY || 0, overflow: document.body.style.overflow };
    document.body.style.overflow = 'hidden';
  }

  function restorePage() {
    if (!savedPage) return;
    document.body.style.overflow = savedPage.overflow;
    document.defaultView?.scrollTo(savedPage.x, savedPage.y);
    savedPage = null;
  }

  function closeComparison() {
    if (!comparison) return;
    comparison = null;
    restorePage();
    render(returnFocus);
  }

  let lastTile = { terrain: 'cloud', shape: 'straight', rotation: 0 };

  function render(focusKey) {
    const details = [...root.querySelectorAll('details')].map((element) => ({ id: element.id, open: element.open }));
    const previousFocus = focusKey || root.ownerDocument.activeElement?.dataset?.focus;
    root.innerHTML = renderSession(session, { message, error, replacement, table: tableVisible ? table : null }) + renderComparison(session, table, comparison);
    for (const detail of details) root.querySelector(`#${detail.id}`).open = detail.open;
    if (comparison) root.querySelector('#garden-comparison').showModal();
    if (previousFocus) root.querySelector(`[data-focus="${previousFocus}"]`)?.focus({ preventScroll: true });
  }

  function dispatch(action) {
    const committedIndex = session.pending?.index;
    const result = updateSession(session, action);
    session = result.session;
    message = result.message;
    error = Boolean(result.error);
    if (session.selection.type === 'tile') lastTile = { ...session.selection.tile };
    render(action.type === 'commit' && !result.error ? `cell-${committedIndex}` : undefined);
  }

  function onClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button || !root.contains(button) || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'comparison-close') { closeComparison(); return; }
    if (comparison) {
      if (action === 'comparison-player' && table.opponents.some(({ id }) => id === button.dataset.opponent)) {
        comparison = { ...comparison, opponentId: button.dataset.opponent };
        render(button.dataset.focus);
      } else if (action === 'comparison-mode' && ['inspect', 'give', 'invite'].includes(button.dataset.intent)) {
        comparison = { ...comparison, intent: button.dataset.intent };
        render(button.dataset.focus);
      }
      return;
    }
    if (action === 'view-solo' || action === 'view-table') {
      tableVisible = action === 'view-table';
      render(button.dataset.focus);
      return;
    }
    if (action === 'inspect' && tableVisible && table.opponents.some(({ id }) => id === button.dataset.opponent)) {
      returnFocus = button.dataset.focus;
      comparison = { opponentId: button.dataset.opponent, intent: 'inspect' };
      lockPage();
      render('comparison-close');
      return;
    }
    if (action === 'reset' || action === 'example') {
      replacement = action;
      render('replace-cancel');
      root.querySelector('.replacement-confirm')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (action === 'replace-cancel') {
      const origin = replacement;
      replacement = null;
      render(origin);
      return;
    }
    if (action === 'replace-confirm' && replacement) {
      const isExample = replacement === 'example';
      session = createSession(isExample ? createExampleGarden() : createGarden());
      lastTile = { ...session.selection.tile };
      replacement = null;
      message = isExample ? '見本の庭です。石の対象と得点の内訳を見比べてみてください' : '空の庭に戻しました';
      error = false;
      render('terrain-cloud');
      return;
    }
    // Any different editing action dismisses a stale replacement prompt.
    replacement = null;
    if (action === 'terrain') dispatch({ type: 'select-tile', ...lastTile, terrain: button.dataset.terrain });
    else if (action === 'shape') dispatch({ type: 'select-tile', ...lastTile, shape: button.dataset.shape });
    else if (action === 'stone') dispatch({ type: 'select-stone', stone: button.dataset.stone });
    else if (action === 'cell') dispatch({ type: 'preview', index: Number(button.dataset.index) });
    else if (['rotate', 'commit', 'cancel', 'undo'].includes(action)) dispatch({ type: action });
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (comparison) { event.preventDefault(); closeComparison(); return; }
    if (replacement) {
      const origin = replacement;
      replacement = null;
      render(origin);
    } else if (session.pending) {
      dispatch({ type: 'cancel' });
    }
  }

  function onDialogCancel(event) {
    if (event.target.id !== 'garden-comparison') return;
    event.preventDefault();
    closeComparison();
  }

  root.addEventListener('cancel', onDialogCancel, true);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  render();
  return { getSession: () => structuredClone(session), dispatch, unmount: () => { comparison = null; root.querySelector('#garden-comparison')?.close(); restorePage(); root.removeEventListener('cancel', onDialogCancel, true); root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKeydown); } };
}

const root = document.querySelector('#garden-app');
if (root) mountGarden(root);
