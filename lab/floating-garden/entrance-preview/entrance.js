import { mayAnimate, startsAnimated } from './motion-policy.js';

const video = document.querySelector('#garden-video');
const toggle = document.querySelector('#motion-toggle');
const label = document.querySelector('#motion-label');
const icon = document.querySelector('#motion-icon');
const scene = document.querySelector('#garden-scene');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const connection = navigator.connection;
const state = {
  enabled: startsAnimated({ reducedMotion: reduced.matches, saveData: connection?.saveData }),
  visible: !document.hidden, intersecting: false, pageActive: true, dialogOpen: false,
};
let generation = 0;
let failed = false;
let manuallyPaused = false;
let previousPreferences = { reducedMotion: reduced.matches, saveData: Boolean(connection?.saveData) };

function paintToggle() {
  toggle.setAttribute('aria-pressed', String(state.enabled));
  label.textContent = state.enabled ? '背景をとめる' : '背景を動かす';
  icon.textContent = state.enabled ? 'Ⅱ' : '▷';
}
function pause() {
  generation += 1;
  video.pause();
}
function syncMotion() {
  paintToggle();
  if (failed || !mayAnimate(state)) { pause(); return; }
  if (!video.getAttribute('src')) { video.src = video.dataset.src; video.muted = true; }
  if (!video.paused) return;
  const token = ++generation;
  const playing = video.play();
  playing?.then(() => {
    // A delayed play promise must not restart a hidden/dismissed/paused scene.
    if (!mayAnimate(state)) pause();
  }).catch((error) => {
    if (token !== generation || error?.name === 'AbortError') return;
    state.enabled = false;
    paintToggle();
  });
}
toggle.hidden = false;
toggle.addEventListener('click', () => { state.enabled = !state.enabled; manuallyPaused = !state.enabled; syncMotion(); });
video.addEventListener('playing', () => { if (mayAnimate(state)) video.classList.add('is-ready'); else pause(); });
video.addEventListener('error', () => {
  failed = true; state.enabled = false; pause(); video.classList.remove('is-ready');
  toggle.hidden = true; // The still image remains, even if the video cannot play.
});
document.addEventListener('visibilitychange', () => { state.visible = !document.hidden; syncMotion(); });
window.addEventListener('pagehide', () => { state.pageActive = false; pause(); });
window.addEventListener('pageshow', () => { state.pageActive = true; state.visible = !document.hidden; syncMotion(); });
function preferenceChanged() {
  const next = { reducedMotion: reduced.matches, saveData: Boolean(connection?.saveData) };
  // Network quality changes are not permission to override a deliberate pause.
  if (next.reducedMotion === previousPreferences.reducedMotion && next.saveData === previousPreferences.saveData) return;
  previousPreferences = next;
  state.enabled = !manuallyPaused && startsAnimated(next);
  syncMotion();
}
reduced.addEventListener?.('change', preferenceChanged);
connection?.addEventListener?.('change', preferenceChanged);
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([entry]) => { state.intersecting = entry.isIntersecting; syncMotion(); }, { threshold: 0.01 }).observe(scene);
} else { state.intersecting = true; }
syncMotion();

const dialog = document.querySelector('#howto-dialog');
const open = document.querySelector('#howto-open');
let returnFocus = null;
if (typeof dialog.showModal === 'function') {
  document.querySelector('#howto-static').hidden = true;
  document.querySelector('#howto-fallback').hidden = true;
  open.hidden = false;
  open.addEventListener('click', () => {
    if (dialog.open) return;
    returnFocus = document.activeElement;
    dialog.showModal();
    document.body.classList.add('dialog-open');
    state.dialogOpen = true; syncMotion();
  });
  const close = () => { if (dialog.open) dialog.close(); };
  document.querySelector('#howto-close').addEventListener('click', close);
  document.querySelector('#howto-done').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
    state.dialogOpen = false; syncMotion();
    returnFocus?.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
}

// UI-only composition selector. No game state, credentials or network access.
const humans = document.querySelector('#human-count');
const npcs = document.querySelector('#npc-count');
const modeSummary = document.querySelector('#mode-summary');
const modeAvailability = document.querySelector('#mode-availability');
function showComposition() {
  const humanCount = [2, 3, 4].includes(Number(humans.value)) ? Number(humans.value) : 2;
  humans.value = String(humanCount);
  const previous = Number(npcs.value);
  const maximum = 4 - humanCount;
  npcs.innerHTML = '<option value="0">なし</option>' + (maximum >= 1 ? '<option value="1">1人</option>' : '') + (maximum >= 2 ? '<option value="2">2人</option>' : '');
  const npcCount = Number.isInteger(previous) && previous >= 0 && previous <= maximum ? previous : 0;
  npcs.value = String(npcCount);
  npcs.disabled = maximum === 0;
  modeSummary.textContent = `人間${humanCount}人 ＋ NPC${npcCount === 0 ? 'なし' : npcCount + '人'} · 合計${humanCount + npcCount}人戦`;
  modeAvailability.textContent = humanCount >= 3 ? 'この3〜4人用モードは未公開の見本です。' : '確認用のため開始できません。';
}
humans.addEventListener('change', showComposition);
npcs.addEventListener('change', showComposition);
showComposition();
document.querySelector('#mode-controls').hidden = false;
document.querySelector('#mode-fallback').hidden = true;
