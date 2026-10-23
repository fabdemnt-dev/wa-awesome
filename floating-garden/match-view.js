import { cellName, STONES, TERRAIN, scoreGarden, tilePorts } from './engine.js?v=20261002-match-save';
import { displayedGarden } from './session.js?v=20261002-match-save';
import { renderBoard, renderScore, tileArt } from './view.js?v=20261002-match-save';
import { getDecision, legalActions, publicMatch, rankMatch } from './match-engine.js?v=20261002-match-save';
import { remainingTileCounts } from './match-assist.js?v=20261002-match-save';
import { renderRuleExamples } from './match-rule-examples.js?v=20261002-match-save';
const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const shape = (tile) => tile.shape === 'bend' ? '曲線' : '直線';
const tileText = (tile) => tile ? `${TERRAIN[tile.terrain].name}・${shape(tile)}` : 'なし';
const control = (action, label, extras = '') => `<button type="button" data-action="${action}" data-focus="${action}" ${extras}>${label}</button>`;

export function renderMatchSaveStatus(save = {}) {
  if (!save.saving) return '';
  let text = save.saving === 'off' ? '保存なしでプレイ中。この画面を閉じると今回の進行は消えます。以前の保存は変更しません。' : save.saving === 'saved' ? 'このブラウザーに自動保存済み' : 'この端末・同じブラウザーに最新1試合を自動保存します';
  if (save.saving === 'saved' && save.savedAt !== null) text += ` · ${new Date(save.savedAt).toLocaleString('ja-JP')}`;
  const problems = {
    failed: '最新の操作を保存できませんでした。この画面には残っていますが、前回の保存からは進んでいる場合があります。進行を一時停止しています。',
    conflict: 'ほかのタブまたはブラウザー操作で保存が変わりました。上書きせず、この画面の進行を一時停止しました。',
    busy: '別のタブでCPU対戦を開いています。そのタブを閉じて保存を読み直してください。同じ保存を二重に進めることはできません。',
    changed: '保存の内容が更新されました。新しい内容を確認してから選んでください。',
  };
  if (save.issue) text = problems[save.issue];
  if (save.acquiring) text = '保存の使用状況を確認しています…';
  const controls = save.issue && !save.acquiring ? `<div class="save-actions">${save.issue === 'failed' ? control('retry-save', '保存を再試行') : ''}${control('reload-save', '保存を読み直す')}${save.issue !== 'changed' ? control('continue-unsaved', 'この画面だけで続ける（保存なし）') : ''}</div>` : '';
  return `<section class="panel match-save-status${save.issue ? ' save-warning' : ''}" id="match-save-status" tabindex="-1" data-focus="match-save-status" role="status" aria-live="polite"><p>${escape(text)}</p>${controls}<p class="demo-note">確定した操作と残数アシストのON/OFFを保存。仮置き・回転・石の選択・比較画面は再開時に解除します。ブラウザーのデータを消すと保存も消えます。</p></section>`;
}

export function renderMatchSetup({ playerCount = 4 } = {}, save = {}) {
  const stored = save.recovery?.snapshot?.state;
  const disabled = save.acquiring ? 'disabled' : '';
  const resume = stored ? `<section class="save-recovery"><h3>${stored.phase === 'finished' ? '完成した庭の記録があります' : '途中の庭づくりがあります'}</h3><p>${stored.players.length}人 · ${stored.phase === 'finished' ? '結果' : stored.phase === 'final-stone' ? '最後の石' : `${stored.round}巡目`} · 確定操作${stored.revision}回</p>${control('resume', save.saving === 'off' ? '保存せず再開する' : stored.phase === 'finished' ? '保存した結果を見る' : '続きから再開する', `class="primary" ${disabled}`)}<p>再開するだけでは、あなたの手もCPUの手も進みません。</p></section>` : save.recovery?.status === 'invalid' ? `<section class="save-recovery"><h3>保存データを読み込めません</h3><p>${escape(save.recovery.message)}。削除や上書きはしていません。</p></section>` : '';
  const confirm = save.confirm ? `<section class="replacement-confirm panel"><h3>保存中の1試合を置き換えますか？</h3><p>新しい${playerCount}人対戦を始めると、以前の保存に戻れなくなります。取り消すと保存を残します。</p>${control('confirm-reset', '保存を置き換えて始める', `class="primary" ${disabled}`)}${control('cancel-reset', '取り消す', disabled)}</section>` : '';
  return `${renderMatchSaveStatus(save)}<section class="panel match-setup"><h2>CPUと庭をつくる</h2>${resume}<p>あなた1人とCPU。引いた1枚を使う・譲る・保管する。最後は全員の庭が完成します。</p><div class="match-options" role="group" aria-label="参加人数">${[2, 3, 4].map((count) => control(`count-${count}`, `${count}人 <small>CPU ${count - 1}人</small>`, `aria-pressed="${count === playerCount}" ${disabled}`)).join('')}</div><p class="demo-note">CPUは山札の順番を見ません。公開された庭とタイルだけで考えます</p>${control('start', save.recovery?.raw ? '新しく庭づくりを始める' : '庭づくりを始める', `class="primary" ${disabled}`)}${confirm}<p class="demo-note">通信はありません。保存は同じ端末・同じブラウザー専用です。CPUは「CPUの手を進める」を押したときだけ動きます。</p></section>${renderMatchRules()}`;
}

function phaseHint(state) {
  const player = state.players[getDecision(state)?.seat ?? 0];
  if (state.phase === 'finished') return '全員の庭が完成しました';
  const hints = {
    source: '山札を1枚引くか、保管している1枚を使います',
    choose: '引いた1枚を自分で使うか、相手に譲るか、保管します',
    'offer-response': `${state.players[state.activeSeat].name}から1枚を譲る提案です。受け取るとすぐに自庭へ置けます`,
    'invite-response': `${state.players[state.activeSeat].name}が使う1枚です。力3で招く希望を出しますか？ 希望後は撤回できません`,
    welcome: `${state.requests.map((seat) => state.players[seat].name).join('・')}が招く希望を出しています。優先は${state.players[state.requests[0]]?.name}です`,
    place: `${state.drawn?.protected ? 'この1枚は保護されています。' : ''}空きマスに仮置きしてから確定してください`,
    care: '手入れを1回。瞑想で力+1、または力3で石を1個置きます',
    'final-stone': '最後の石を1個置くか、見送ります。手持ちの力を使います',
  };
  return `${player.name}: ${hints[state.step] || ''}`;
}

function renderDecisionTile(state, ui) {
  if (!state.drawn) return '';
  const tile = { ...state.drawn.tile, rotation: state.step === 'place' && state.players[getDecision(state).seat].isHuman ? ui.rotation : state.drawn.tile.rotation };
  const ports = tilePorts(tile).map((port) => ['上', '右', '下', '左'][port]).join('・');
  return `<div class="decision-tile"><span class="drawn-tile terrain-${tile.terrain}" aria-hidden="true">${tileArt(tile)}<span class="terrain-mark">${TERRAIN[tile.terrain].mark}</span></span><div><strong>公開の1枚: ${tileText(tile)}</strong><p>流れ: ${ports}${state.drawn.protected ? ' · 保護タイル' : ''}</p></div></div>`;
}

export function renderMatchAssist(state, ui, disabled = false) {
  const enabled = Boolean(ui.assist);
  let content = '';
  if (enabled) {
    const inventory = remainingTileCounts(publicMatch(state));
    const current = state.drawn?.tile;
    const sameKind = current && inventory.kinds.find((kind) => kind.terrain === current.terrain && kind.shape === current.shape);
    content = `<div class="assist-content"><p class="assist-current">${current ? `公開の1枚と同じ種類<br><strong>${tileText(current)} · 山札にあと${sameKind.count}枚</strong>` : 'いま公開中のタイルはありません'}<br><span>山札全体: 残り${inventory.total}枚</span></p><details id="match-assist-details"><summary>10種類の残数一覧</summary><table class="assist-inventory"><caption class="sr-only">地形と流れの形ごとの、まだ引かれていない枚数</caption><thead><tr><th scope="col">地形</th><th scope="col">直線</th><th scope="col">曲線</th></tr></thead><tbody>${Object.entries(TERRAIN).map(([terrain, data]) => `<tr><th scope="row">${data.name}</th>${inventory.kinds.filter((kind) => kind.terrain === terrain).map((kind) => `<td>${kind.count}<small>枚</small></td>`).join('')}</tr>`).join('')}</tbody></table></details><p class="demo-note">まだ引かれていない山札だけを数えます。公開中の1枚・保管中・各庭のタイルは含めません。回転した向きは区別しません。</p><p class="demo-note">引く順番は表示しません。CPUの考え方は変わりません。</p></div>`;
  }
  return `<div class="match-assist"><div class="assist-heading">${control('toggle-assist', `残数アシスト ${enabled ? 'ON' : 'OFF'}`, `aria-pressed="${enabled}" ${disabled ? 'disabled' : ''}`)}<small>CPU戦専用</small></div>${content}</div>`;
}

function renderControls(state, ui) {
  const decision = getDecision(state);
  if (!decision) return '';
  if (!state.players[decision.seat].isHuman) return `${control('cpu-next', 'CPUの手を進める', 'class="primary"')}<p class="demo-note">あなたの応答が必要になったところで止まります。比較している間は進みません。</p>`;
  const legal = legalActions(state);
  const choices = [];
  const labels = { draw: '山札から1枚引く', 'use-storage': '保管の1枚を使う', self: '自分の庭に使う', store: state.players[decision.seat].storage ? '新しい1枚を保管し、前の1枚を使う' : '1枚を保管する', accept: '譲り受ける', decline: '今回は見送る', 'request-invite': '力3で招く希望を出す', 'pass-invite': '招かずに見守る', welcome: '力2で庭に迎える', yield: '渡して、保護代替を引く', meditate: '瞑想する · 力+1', 'pass-final': '最後の石を見送る' };
  for (const type of Object.keys(labels)) {
    if (legal.some((action) => action.type === type)) choices.push(control(`command-${type}`, labels[type], `data-revision="${state.revision}"`));
  }
  if (state.step === 'choose') {
    const offers = legal.filter((item) => item.type === 'offer').map((action) => control(`offer-${action.target}`, `${escape(state.players[action.target].name)}に譲る`, `data-revision="${state.revision}"`));
    const group = (kind, label, buttons) => `<fieldset class="match-choice-group match-${kind}-choices"><legend>${label}</legend><div class="match-choice-buttons">${buttons.join('')}</div></fieldset>`;
    const ownLabel = legal.some((action) => action.type === 'store') ? '自分で使う・保管' : '自分で使う';
    return `<div class="match-choice-groups">${group('own', ownLabel, choices)}${offers.length ? group('offer', '相手に譲る', offers) : ''}</div>`;
  }
  if (state.step === 'welcome' && !legal.some((action) => action.type === 'welcome')) choices.push('<p class="power-warning">力が2未満のため「庭に迎える」は選べません。渡したあと、保護代替を必ず自庭に置きます。</p>');
  if (state.step === 'place') choices.push(control('rotate', '↻ 90°回す'), `<span class="selection-preview terrain-${state.drawn.tile.terrain}" aria-label="配置する向き ${ui.rotation * 90}度">${tileArt({ ...state.drawn.tile, rotation: ui.rotation })}</span>`);
  if (['care', 'final-stone'].includes(state.step)) {
    const stones = Object.entries(STONES).map(([stone, data]) => control(`stone-${stone}`, `${data.mark} ${data.name} · 力3`, `${legal.some((action) => action.stone === stone) ? '' : 'disabled'} aria-pressed="${ui.stone === stone}"`)).join('');
    choices.push(`<div class="match-stones" role="group" aria-label="置く石を選ぶ">${stones}</div>`);
    if (state.players[decision.seat].power < 3) choices.push('<p class="demo-note">石には力3が必要です</p>');
  }
  return `<div class="match-actions">${choices.join('')}</div>${ui.pending ? `<p class="placement-score">${cellName(ui.pending.index)}に仮置き中 · 得点を確認して確定</p><div class="placement-actions">${control('commit', 'この配置を確定', 'class="primary"')}${control('cancel', '仮置きを取り消す')}</div>` : ''}`;
}

export function renderMatch(state, ui, save = {}) {
  const human = state.players.find((player) => player.isHuman);
  const session = { garden: human.garden, pending: ui.pending };
  const garden = displayedGarden(session);
  const score = scoreGarden(human.garden);
  const decision = getDecision(state);
  const opponents = state.players.filter((player) => !player.isHuman);
  const phase = state.phase === 'normal' ? `通常 ${state.round}/12巡` : state.phase === 'finishing' ? `仕上げ ${state.round - 12}/4巡` : state.phase === 'final-stone' ? '最後の石' : '庭の完成';
  const interactive = !save.issue && decision?.seat === human.seat && (state.step === 'place' || (['care', 'final-stone'].includes(state.step) && ui.stone));
  const board = renderBoard(session, { readOnly: !interactive });
  return `${renderMatchSaveStatus(save)}<section class="shared-table panel"><div class="shared-heading"><h2>${phase}</h2><span class="turn-badge">${decision ? `${escape(state.players[decision.seat].name)}の${state.phase === 'final-stone' || state.activeSeat === decision.seat ? '番' : '応答'}` : '結果'}</span><a class="match-jump" href="#match-controls">操作・結果へ ↓</a></div><div class="shared-draw">${state.drawn ? `<span class="drawn-tile terrain-${state.drawn.tile.terrain}" aria-hidden="true">${tileArt(state.drawn.tile)}<span class="terrain-mark">${TERRAIN[state.drawn.tile.terrain].mark}</span></span><p><strong>公開の1枚: ${tileText(state.drawn.tile)}</strong><span>${escape(state.players[state.drawn.ownerSeat].name)}の手番 · ${state.drawn.protected ? '保護されています' : '公開中'}</span></p>` : `<p>${state.phase === 'finished' ? 'すべての庭が完成しました' : state.phase === 'final-stone' ? '最後の石を配置します' : '次の1枚を待っています'}</p>`}<p class="shared-objective">共通のお題<strong>四隅異なる地形 · 4点</strong></p></div><p class="demo-note">山札 残り${state.deck.length - state.deckCursor}枚 · 招く優先マーカー: P${state.prioritySeat + 1} ${escape(state.players[state.prioritySeat].name)}から席順</p></section>
    <div class="garden-layout table-layout match-layout"><section class="opponents panel"><div class="section-label"><h2>相手の庭</h2><span>${opponents.length} GARDENS</span></div><p class="opponents-hint">タップして拡大・比較</p><div class="opponent-cards" style="--opponent-count:${opponents.length}">${opponents.map((player) => `<button type="button" class="opponent-card" data-action="inspect" data-seat="${player.seat}" data-focus="inspect-${player.seat}" aria-haspopup="dialog" aria-label="P${player.seat + 1} ${escape(player.name)}を拡大・比較"><span class="opponent-name"><small>P${player.seat + 1} · 力 ${player.power}/6</small><strong>${escape(player.name)}</strong></span>${renderBoard({ garden: player.garden }, { readOnly: true, compact: true })}<span class="opponent-score"><b>${scoreGarden(player.garden).total}点</b><span>${player.garden.filter(Boolean).length}/16</span></span><span class="card-zoom">保管: ${tileText(player.storage)}<br>拡大・比較 ↗</span></button>`).join('')}</div></section>
    <div class="workbench"><section class="garden-section"><div class="board-title"><h2>あなたの庭 <small>P1 · 力 ${human.power}/6 · 手入れ ${human.careCount}回</small></h2><span>${score.filled}/16 マス</span></div>${board}<p class="board-caption">保管: ${tileText(human.storage)}<br>確定した地形や石は動かせません</p></section><section id="match-controls" class="panel match-controls" aria-label="対戦操作">${renderDecisionTile(state, ui)}${renderMatchAssist(state, ui, Boolean(save.issue))}<p class="status ${ui.error ? 'error' : ''}" role="status" aria-live="polite" aria-atomic="true">${escape(ui.message || phaseHint(state))}</p>${ui.message ? `<p class="decision-hint">${escape(phaseHint(state))}</p>` : ''}${save.issue ? '<p>保存の選択が終わるまで手番を止めています。</p>' : renderControls(state, ui)}</section>
    ${state.phase === 'finished' ? `<section class="panel match-results"><h2>庭の得点</h2><ol>${rankMatch(state).map((item) => `<li><strong>${item.rank}位 · ${escape(state.players[item.seat].name)}</strong><span>${item.score}点</span></li>`).join('')}</ol><p>同点は同じ順位です · 全員 ${human.careCount}回の手入れ</p></section>` : ''}
    <div class="experiment-actions">${control('restart', state.phase === 'finished' ? 'もう一度遊ぶ' : '対戦をやり直す')}${control('setup', '人数を変える')}</div>${ui.confirm ? `<section class="replacement-confirm panel"><h2>${ui.confirm === 'reload' ? '保存を読み直しますか？' : 'いまの対戦を終了しますか？'}</h2><p>${ui.confirm === 'reload' ? 'この画面だけの未保存の進行・仮置きは破棄して、保存の選択画面へ戻ります。' : '新しい対戦を始めると保存中の1試合を置き換えます。人数変更では、新しく開始するまで前の保存が残ります。'}取り消すと、そのまま続けられます。</p>${control('confirm-reset', '終了して進む', 'class="primary"')}${control('cancel-reset', '対戦を続ける')}</section>` : ''}</div>
    <aside class="sidebar">${renderScore(garden, score.total, Boolean(ui.pending))}${renderMatchRules()}<section class="panel match-log"><details id="match-log"><summary>庭の記録（${state.log.length}件）</summary><ol>${state.log.slice().reverse().map((message) => `<li>${escape(message)}</li>`).join('')}</ol></details><p class="demo-note">${state.log.slice(-3).map(escape).join('<br>')}</p></section></aside></div>${renderMatchComparison(state, ui)}`;
}

export function renderMatchComparison(state, ui) {
  if (!ui.comparison) return '';
  const human = state.players.find((player) => player.isHuman);
  const opponent = state.players[ui.comparison.seat];
  const pair = ui.comparison.pair;
  const garden = (player, pending = null) => {
    const session = { garden: player.garden, pending };
    const committed = scoreGarden(player.garden);
    return `<section class="comparison-garden${pair ? ' paired-garden' : ''}"><div class="board-title"><h3>${escape(player.name)}</h3><span>力 ${player.power}/6</span></div>${renderBoard(session, { readOnly: true, label: `${player.name}、${pending ? '仮置きを含む' : '確定済み'}、4行4列の閲覧用の庭` })}<p class="comparison-breakdown">${pending ? `${cellName(pending.index)}の仮置きを含む` : '確定済み'} · 保管: ${tileText(player.storage)}</p>${renderScore(displayedGarden(session), committed.total, Boolean(pending), { idPrefix: `comparison-score-${player.seat}`, title: pending ? '仮置きした庭の得点' : '確定した庭の得点', detailsOpen: false, compact: true })}</section>`;
  };
  return `<dialog id="match-comparison" class="garden-dialog" aria-labelledby="match-comparison-title"><div class="dialog-heading"><h2 id="match-comparison-title">${pair ? '譲る・招く前に見比べる' : `${escape(opponent.name)}を拡大`}</h2>${control('comparison-close', '閉じる', 'autofocus')}</div><div class="comparison-players">${state.players.filter((player) => !player.isHuman).map((player) => control(`compare-${player.seat}`, `P${player.seat + 1} ${escape(player.name)}`, `aria-pressed="${opponent.seat === player.seat}"`)).join('')}</div><div class="comparison-modes">${control('compare-single', '大きく見る', `aria-pressed="${!pair}"`)}${control('compare-pair', '自庭と比較', `aria-pressed="${pair}"`)}</div><p class="comparison-help">${state.drawn ? `公開の1枚: ${tileText(state.drawn.tile)}。` : ''}比較中は手番が進みません。閉じると仮置きや選択を保って戻ります。</p><div class="comparison-boards${pair ? ' is-pair' : ''}">${pair ? garden(human, ui.pending) : ''}${garden(opponent)}</div><p class="comparison-legend">${Object.values(TERRAIN).map(({ mark, name }) => `${mark}＝${name}`).join(' / ')}<br>${Object.values(STONES).map(({ mark, name }) => `${mark}＝${name}`).join(' / ')}</p></dialog>`;
}

export function renderMatchRules() {
  return `<section class="rules-panel panel"><details id="match-rules"><summary>対戦のルールと操作</summary><div class="rule-content"><h3>引く・譲る・保管</h3><p>1枚引くか保管を使い、自分で使う・1人に譲る提案・保管を選びます。譲渡成立は力+2。拒否されたら自用か保管へ。再提案はできません。保管は1枚、満杯なら新しい1枚を保管して前の1枚を使います。取り出した保管は再保管できません。</p><h3>精霊を招く・庭に迎える</h3><p>他の人が自用にした未配置の1枚へ、力3で招く希望を出せます。希望は撤回できず、複数なら優先マーカーから席順。持主は力2で庭に迎えるか、渡します。実際に受け取った人だけ力3を使い、優先マーカーはその次の席へ。完成した庭、保護代替、受け取ったタイルには招けません。</p><h3>必ず庭が進む</h3><p>譲渡・招き成立、空の保管に入れたときは、保護代替を引いて自庭へ必ず配置。タイルの後に手入れを1回。瞑想は力+1、石は力3。力は初期4、上限6。確定した庭は変更できません。</p><h3>庭の完成</h3><p>通常12巡、その後は最大4巡の仕上げ。仕上げは保管を先に使い1枚配置し、譲渡・招き・保管はありません。完成済みの人も手入れを続け、全員完成した巡末で最後の石へ。全員同じ回数の手入れをします。最後は手持ちの力で石1個かパス。余力は得点にならず、同点は同順位です。</p><h3>星の石と採点</h3><p>石は各種類1個、地形1枚に1個。各石の上限は6点。</p><ul>${Object.values(STONES).map((stone) => `<li>${stone.name}: ${stone.rule}</li>`).join('')}</ul><p>隣り合う流れの接続1辺につき1点。四隅を4種類の地形で埋めると4点。盤外や斜めはつながりません。</p>${renderRuleExamples()}<h3>CPUの進行</h3><p>「CPUの手を進める」で、次にあなたの選択が必要なところまで進みます。仮置き・比較・確認中は進みません。確定操作は同じブラウザーに自動保存します。再開だけではCPUは進みません。保存を利用できない場合は画面に知らせます。</p></div></details></section>`;
}
