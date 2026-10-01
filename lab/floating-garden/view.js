import { cellName, scoreGarden, STONES, TERRAIN } from './engine.js';
import { displayedGarden } from './session.js';

const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const portNames = ['上', '右', '下', '左'];
const shapeName = (shape) => shape === 'bend' ? '曲線' : '直線';

export function tileArt(tile) {
  const line = tile.shape === 'straight' ? 'M50 0 V100' : 'M50 0 Q50 50 100 50';
  return `<svg class="flow" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g transform="rotate(${tile.rotation * 90} 50 50)"><path class="flow-glow" d="${line}"/><path class="flow-line" d="${line}"/></g></svg>`;
}

function tileLabel(tile) {
  const ports = (tile.shape === 'straight' ? [0, 2] : [0, 1]).map((port) => portNames[(port + tile.rotation) % 4]);
  return `${TERRAIN[tile.terrain].name}、${shapeName(tile.shape)}、流れは${ports.join('と')}${tile.stone ? `、${STONES[tile.stone].name}の石` : ''}`;
}

export function renderBoard(session) {
  const garden = displayedGarden(session);
  const { connections } = scoreGarden(garden);
  return `<div class="board" role="group" aria-label="4行4列の庭。列AからD、行1から4">
    ${garden.map((cell, index) => {
      const pending = session.pending?.index === index;
      const connected = connections.flatMap(({ from, to }) => from === index ? [to === index + 1 ? 'right' : 'bottom'] : to === index ? [from === index - 1 ? 'left' : 'top'] : []);
      return `<button type="button" class="cell ${cell ? `terrain-${cell.terrain}` : 'empty'}${pending ? ' pending' : ''}" data-action="cell" data-index="${index}" data-focus="cell-${index}" aria-pressed="${pending}" aria-label="${cellName(index)}、${cell ? tileLabel(cell) : '空きマス'}${pending ? '、仮置き中' : ''}">
        <span class="coordinate">${cellName(index)}</span>
        ${cell ? `${tileArt(cell)}<span class="terrain-mark" aria-hidden="true">${TERRAIN[cell.terrain].mark}</span><span class="terrain-name">${TERRAIN[cell.terrain].name}</span>${cell.stone ? `<span class="stone-badge" title="${STONES[cell.stone].name}"><span aria-hidden="true">${STONES[cell.stone].mark}</span><span class="sr-only">${STONES[cell.stone].name}</span></span>` : ''}` : '<span class="empty-star" aria-hidden="true">✧</span>'}
        ${connected.map((direction) => `<span class="connection connection-${direction}" aria-hidden="true"></span>`).join('')}
        ${pending ? '<span class="preview-tag">仮</span>' : ''}
      </button>`;
    }).join('')}
  </div>`;
}

export function renderScore(garden, committedTotal, isPreview) {
  const score = scoreGarden(garden);
  const delta = score.total - committedTotal;
  return `<section class="score-panel panel" aria-labelledby="score-title">
    <div class="section-label"><h2 id="score-title">${isPreview ? '仮置きした庭の得点' : 'いまの庭の得点'}</h2><span>${isPreview ? 'PREVIEW' : 'SCORE'}</span></div>
    <div class="total"><strong>${score.total}</strong><span>点</span>${isPreview ? `<span class="score-delta">確定済み ${committedTotal}点 → ${delta >= 0 ? '+' : ''}${delta}点</span>` : ''}</div>
    <dl class="score-summary"><div><dt>つながる流れ</dt><dd>${score.connectionPoints}<small>点</small></dd></div><div><dt>星の石</dt><dd>${score.stonePoints}<small>点</small></dd></div><div><dt>共通のお題</dt><dd>${score.objective.points}<small>点</small></dd></div></dl>
    <div class="objective ${score.objective.achieved ? 'achieved' : ''}"><span aria-hidden="true">${score.objective.achieved ? '✦' : '◇'}</span><div><strong>四隅異なる地形</strong><p>${score.objective.achieved ? '達成！ 四隅がすべて別の地形です' : 'A1・D1・A4・D4を4種類の地形で埋めると4点'}</p></div></div>
    <details id="score-details" open><summary>得点の内訳を見る</summary><div class="score-details">
      <h3>流れ · ${score.connectionPoints}点</h3><p>${score.connections.length ? score.connections.map(({ from, to }) => `${cellName(from)}–${cellName(to)}`).join(' / ') : '向かい合う辺の流れが合うと1点。地形は違ってもつながります。'}</p>
      <h3>星の石 · ${score.stonePoints}点</h3>
      ${score.stones.length ? `<ul class="stone-breakdown">${score.stones.map((stone) => `<li><div><strong>${STONES[stone.stone].name} <small>${cellName(stone.index)}</small></strong><b>${stone.points}点</b></div><p>${stone.count}${stone.stone === 'color' ? '種類' : stone.stone === 'echo' ? '個' : '枚'} × 2${stone.capped ? ` = ${stone.rawPoints}点 → 上限6点` : ` = ${stone.points}点`}<br>${stone.matches.length ? `対象: ${stone.matches.map(cellName).join('・')}${stone.stone === 'color' ? '（重複する地形は1種類）' : ''}` : 'いまは対象がありません'}</p></li>`).join('')}</ul>` : '<p>石を置くと、何が得点になったかここに表示します。</p>'}
    </div></details>
  </section>`;
}

export function renderSession(session, { message = '', error = false, replacement = null } = {}) {
  const tile = session.selection.type === 'tile' ? session.selection.tile : null;
  const garden = displayedGarden(session);
  const committed = scoreGarden(session.garden);
  const previewScore = scoreGarden(garden);
  const scoreChange = previewScore.total - committed.total;
  const usedStones = new Set(session.garden.filter((cell) => cell?.stone).map((cell) => cell.stone));
  return `<div class="garden-layout"><div class="workbench">
    <section class="tools panel" aria-labelledby="tools-title"><div class="section-label"><h2 id="tools-title">1. 庭に迎えるものを選ぶ</h2><span>SELECT</span></div>
      <div class="terrain-choices" role="group" aria-label="地形を選ぶ">${Object.entries(TERRAIN).map(([key, item]) => `<button type="button" class="terrain-choice terrain-${key}" data-action="terrain" data-terrain="${key}" data-focus="terrain-${key}" aria-pressed="${tile?.terrain === key}"><span aria-hidden="true">${item.mark}</span>${item.name}</button>`).join('')}</div>
      <div class="shape-controls"><div role="group" aria-label="流れの形を選ぶ">${[['straight', '直線'], ['bend', '曲線']].map(([key, name]) => `<button type="button" data-action="shape" data-shape="${key}" data-focus="shape-${key}" aria-pressed="${tile?.shape === key}">${name}</button>`).join('')}</div><button type="button" data-action="rotate" data-focus="rotate" ${!tile ? 'disabled' : ''}>↻ 90°回す</button><span class="selection-preview ${tile ? `terrain-${tile.terrain}` : 'stone-selection'}" aria-hidden="true">${tile ? tileArt(tile) : STONES[session.selection.stone].mark}</span></div>
      <div class="stone-choices" role="group" aria-label="石を選ぶ。各1個、最大6点">${Object.entries(STONES).map(([key, stone]) => `<button type="button" data-action="stone" data-stone="${key}" data-focus="stone-${key}" aria-pressed="${session.selection.type === 'stone' && session.selection.stone === key}" ${usedStones.has(key) ? 'disabled' : ''}><span aria-hidden="true">${stone.mark}</span>${stone.name}<small>${usedStones.has(key) ? '配置済み' : '残り1個'}</small></button>`).join('')}</div>
      <p class="selection-hint">${tile ? `${TERRAIN[tile.terrain].name} / ${shapeName(tile.shape)} · 空きマスをタップして仮置き` : `${STONES[session.selection.stone].name} · ${STONES[session.selection.stone].rule}。最大6点。地形のあるマスをタップ`}</p>
    </section>
    <section class="garden-section" aria-labelledby="garden-title"><div class="board-title"><h2 id="garden-title">2. 庭に置いて、確かめる</h2><span>${committed.filled} / 16 マス${session.pending?.type === 'tile' ? ' ＋ 仮置き1' : ''}</span></div>
      ${renderBoard(session)}
      <p class="board-caption">金色の点は流れのつながり · 斜めのマスは隣接しません</p>
    </section>
    <section class="placement-bar panel" aria-label="配置の確認"><p id="placement-status" class="status ${error ? 'error' : ''}" role="status" aria-live="polite" aria-atomic="true">${escape(message || '地形を選んで、空いているマスをタップしてください')}</p>${session.pending ? `<p class="placement-score">仮置き後 <strong>${previewScore.total}点</strong> <span>（確定済み比 ${scoreChange >= 0 ? '+' : ''}${scoreChange}点）</span></p>` : ''}<div class="placement-actions"><button type="button" class="primary" data-action="commit" data-focus="commit" ${!session.pending ? 'disabled' : ''}>${session.pending ? `${cellName(session.pending.index)}への配置を確定` : '配置を確定'}</button><button type="button" data-action="cancel" data-focus="cancel" ${!session.pending ? 'disabled' : ''}>仮置きを取り消す</button></div></section>
    <div class="experiment-actions"><button type="button" data-action="undo" data-focus="undo" ${!session.history.length || session.pending ? 'disabled' : ''}>1手戻す</button><button type="button" data-action="example" data-focus="example">見本の庭</button><button type="button" data-action="reset" data-focus="reset">空の庭に戻す</button></div>
    ${replacement ? `<section class="replacement-confirm panel" role="region" aria-labelledby="replace-title"><h2 id="replace-title">${replacement === 'example' ? '見本の庭に切り替えますか？' : '庭を空にしますか？'}</h2><p>いまの配置と「1手戻す」の履歴が消えます。</p><div><button type="button" class="primary" data-action="replace-confirm" data-focus="replace-confirm">${replacement === 'example' ? '見本に切り替える' : '空の庭に戻す'}</button><button type="button" data-action="replace-cancel" data-focus="replace-cancel">やめる</button></div></section>` : ''}
    <p class="sandbox-note">自由配置モード · 素材は何度でも選べます。「1手戻す」は検証用です。対戦ルールでは確定した地形や石を動かしません。</p>
  </div><aside class="sidebar">${renderScore(garden, committed.total, Boolean(session.pending))}
    <section class="rules-panel panel"><details id="rules-details"><summary>この試作のルール</summary><div class="rule-content"><h3>流れをつなぐ</h3><p>隣り合う2枚の向かい合う辺で流れがつながると1点。同じ辺は1回だけ数えます。盤外や空きマスは0点。</p><h3>星の石を置く</h3><p>各種類1個、地形1枚に石1個。すべて上限6点。得点は庭が変わるたびに計算します。</p><ul>${Object.values(STONES).map((stone) => `<li><strong>${stone.name}</strong> — ${stone.rule}</li>`).join('')}</ul><p>風守・彩りは足元と斜めを数えません。共鳴は自分の石を数えません。彩りは4種類あっても6点です。</p><h3>まだ作っていない部分</h3><p>引いた1枚を使う・譲る判断、保管、精霊を招く／庭に迎える、力、12巡と仕上げ、CPU、複数人対戦、通信。今は配置・回転・石・採点の感触を確かめる段階です。</p></div></details></section>
  </aside></div>`;
}
