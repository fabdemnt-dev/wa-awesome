import { ONLINE_MODES } from './modes.js?v=20261022-human4-1';
const invalid = () => new Error('人数の指定が正しくありません。入口で選び直してください。');
export function parseEntryMode(hash = '') {
  if (hash === '') return null;
  const match = /^#mode=([234]-[012])$/.exec(hash);
  const mode = match && ONLINE_MODES.find(item => item.id === match[1]);
  if (!mode) throw invalid();
  return mode;
}
export function modeRoute(humans, npcs) {
  const mode = ONLINE_MODES.find(item => item.humanSeatCount === humans && item.npcCount === npcs);
  if (!mode) throw invalid();
  return `./play/index.html#mode=${mode.id}`;
}
export function validateEntryMode(mode, capabilities = {}) {
  if (mode === null || mode === undefined) return null;
  const valid = ONLINE_MODES.find(item => item.id === mode.id && item.humanSeatCount === mode.humanSeatCount && item.npcCount === mode.npcCount);
  if (!valid) throw invalid();
  if ((valid.humanSeatCount === 3 && capabilities.threeHumanModesReady !== true) || (valid.humanSeatCount === 4 && capabilities.fourHumanModesReady !== true)) {
    throw new Error('選択した人数は未公開です。別の人数へ自動変更せず停止しました。');
  }
  return valid;
}
