import { createExampleGarden, createGarden } from './engine.js';
import { createSession, updateSession } from './session.js';
import { renderSession } from './view.js';

export function mountGarden(root) {
  let session = createSession();
  let message = '';
  let error = false;
  let replacement = null;
  let lastTile = { terrain: 'cloud', shape: 'straight', rotation: 0 };

  function render(focusKey) {
    const details = [...root.querySelectorAll('details')].map((element) => ({ id: element.id, open: element.open }));
    const previousFocus = focusKey || root.ownerDocument.activeElement?.dataset?.focus;
    root.innerHTML = renderSession(session, { message, error, replacement });
    for (const detail of details) root.querySelector(`#${detail.id}`).open = detail.open;
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
    if (replacement) {
      const origin = replacement;
      replacement = null;
      render(origin);
    } else if (session.pending) {
      dispatch({ type: 'cancel' });
    }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  render();
  return { getSession: () => structuredClone(session), dispatch, unmount: () => { root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKeydown); } };
}

const root = document.querySelector('#garden-app');
if (root) mountGarden(root);
