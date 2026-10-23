import { cellName, scoreGarden, STONES, TERRAIN, tilePorts } from '../engine.js?v=20261002-match-save';
import { getDecision, legalActions } from '../match-engine.js?v=20261002-match-save';
import { displayedGarden } from '../session.js?v=20261002-match-save';
import { renderBoard, renderScore, tileArt } from '../view.js?v=20261002-match-save';
import { renderRuleExamples } from '../match-rule-examples.js?v=20261002-match-save';
export const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const tileText = (tile) => tile ? `${TERRAIN[tile.terrain].name}・${tile.shape === 'bend' ? '曲線' : '直線'}` : 'なし';
const button = (action, label, extras = '') => `<button type="button" data-action="${action}" data-focus="${action}" ${extras}>${label}</button>`;
const phases = (match) => match.phase === 'normal' ? `通常 ${match.round}/12巡` : match.phase === 'finishing' ? `仕上げ ${match.round - 12}/4巡` : match.phase === 'final-stone' ? '最後の石' : '庭の完成';
export function phaseHint(match) {
  const decision = getDecision(match);
  if (!decision) return '全員の庭が完成しました';
  const hints = {
    source: '山札を1枚引くか、保管している1枚を使います', choose: '自分で使う・相手に譲る・保管を選びます',
    'offer-response': `${match.players[match.activeSeat].name}から譲る提案です。受け取るとすぐに自庭へ置けます`,
    'invite-response': `${match.players[match.activeSeat].name}の1枚を、力3で招く希望を出しますか？ 希望後は撤回できません`,
    welcome: `${match.requests.map((seat) => match.players[seat].name).join('・')}が招く希望を出しています。力2で自庭に迎えるか、渡します`,
    place: `${match.drawn?.protected ? 'この1枚は保護されています。' : ''}空きマスに仮置きし、回転・得点を確かめて確定します`,
    care: '手入れを1回。瞑想で力+1、または力3で石を1個置きます', 'final-stone': '手持ちの力で最後の石を1個置くか、見送ります',
  };
  return `${match.players[decision.seat].name}: ${hints[match.step] || ''}`;
}
function connectionPanel(state) {
  const labels = { initial: '接続の準備中', syncing: '最新の状態を確認中', ready: 'サーバーと同期済み', cache: '保存済みの表示です。サーバーとの同期完了まで操作できません', offline: 'オフラインです。通信を戻してから接続を確認してください', uncertain: '操作の結果を確認できません。元の操作を同じ番号で確認します', error: '接続を確認してください', 'identity-mismatch': '参加時と異なる認証です。元の認証に戻すまで操作できません', conflict: '別のタブの操作を確認してください' };
  const retry = !state.busy && !['initial', 'ready', 'identity-mismatch', 'conflict'].includes(state.connection) && !state.storageIssue;
  return `<section class="panel online-connection${state.error ? ' save-warning' : ''}" aria-label="接続状況"><p role="status" aria-live="polite">${escape(labels[state.connection] || state.connection)}${state.pending ? ' · 確認待ちの操作があります' : ''}</p>${state.notice || state.storageIssue ? `<p class="${state.error ? 'error' : ''}">${escape(state.storageIssue || state.notice)}</p>` : ''}${retry ? button('resume', state.pending ? '同じ操作の結果を確認' : '接続を確認') : ''}<p class="demo-note">通信が途切れても人間の応答を自動で選びません。仮置きはこの画面だけの表示です。</p>${state.canReturnToEntry ? button('return-entry', state.terminal ? '入口へ戻る' : '入口へ戻って別の部屋に参加') : ''}${state.ui.returnConfirm ? `<section class="replacement-confirm"><h3>${state.terminal ? 'この端末の復帰先を解除しますか？' : 'このブラウザーの復帰先だけを解除しますか？'}</h3><p>${state.terminal ? `${state.terminal === 'finished' ? '結果画面への自動復帰が解除されます。' : '期限切れ・削除済みの部屋への復帰情報を解除します。'}部屋の記録や認証は変更しません。` : '1人で待っている部屋への自動復帰だけを解除します。匿名認証（UID）は変わりません。サーバー上の部屋・参加情報・招待コードは変更しません。入口で相手の招待コードを入力できます。'}</p>${button('confirm-return', '解除して入口へ戻る', state.canReturnToEntry ? '' : 'disabled')}${button('cancel-return', '取り消す')}</section>` : ''}</section>`;
}
export function renderEntry(state, fields = {}) {
  const disabled = state.canConfirm ? '' : 'disabled';
  return `${connectionPanel(state)}<section class="panel online-entry"><h2>2人で庭をつくる</h2><p>別のブラウザーで、それぞれ1席ずつ参加します。</p><label for="online-name">庭師の名前（1〜20文字）</label><input id="online-name" name="displayName" maxlength="40" autocomplete="nickname" value="${escape(fields.displayName || '')}" placeholder="星の庭師" ${disabled}><label for="online-npc-count">新しい部屋の人数</label><select id="online-npc-count" name="npcCount" ${disabled}>${[0, 1, 2].map((count) => `<option value="${count}" ${Number(fields.npcCount || 0) === count ? 'selected' : ''}>${count ? `人間2人＋NPC${count}人（${count + 2}人戦）` : '人間2人（2人戦）'}</option>`).join('')}</select><p class="demo-note">NPCの参加数は部屋を作るときに決まります。招待コードで参加するときは、相手の部屋の設定を使います。</p><div>${button('create', '部屋を作る', `class="primary" ${disabled}`)}</div><label for="online-code">相手から受け取った招待コード</label><input id="online-code" name="inviteCode" maxlength="100" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${escape(fields.inviteCode || '')}" ${disabled}>${button('join', 'コードで参加する', disabled)}<p class="demo-note">同じブラウザーの匿名認証と復帰情報を使って、同じ席へ戻れます。ブラウザーのデータ消去や別端末への席の引き継ぎには対応していません。</p></section>${renderRules()}`;
}
function renderLobby(state) {
  const { room, self } = state;
  const npcCount = room.npcCount || 0;
  return `${connectionPanel(state)}<section class="panel online-lobby"><h2>庭師の待合室</h2><ol>${room.players.map((player) => `<li>P${player.seat + 1} ${escape(player.name)}${player.seat === self.seat ? '（あなた）' : ''}${player.seat === room.hostSeat ? ' · ホスト' : ''}</li>`).join('')}</ol><p>人間 ${room.players.length}/2人が参加しています${npcCount ? ` · NPC${npcCount}人を加えた${room.playerCount}人戦` : ''}</p>${npcCount ? `<p class="demo-note">NPCは開始時にP3${npcCount === 2 ? '・P4' : ''}へ参加します。人間2人の参加を待ってから始めます。</p>` : ''}${state.inviteCode ? `<label for="room-invite">相手に渡す招待コード</label><input id="room-invite" readonly value="${escape(state.inviteCode)}" aria-label="招待コード"><p class="demo-note">招待コードは参加してほしい相手だけに渡してください。</p>` : ''}${self.isHost ? button('start', `${room.playerCount}人で庭づくりを始める`, `class="primary" ${state.canConfirm && room.players.length === 2 ? '' : 'disabled'} data-room-revision="${room.revision}"`) : '<p>ホストが開始するのを待っています</p>'}${expiry(room)}</section>${renderRules()}`;
}
function expiry(room) { return `<p class="demo-note">部屋の有効期限: ${escape(new Date(room.expiresAtMillis).toLocaleString('ja-JP'))}。期限後は再開できません。</p>`; }
function controls(state) {
  const { room: { match }, ui, self } = state;
  const decision = getDecision(match);
  if (!decision) return '';
  if (decision.seat !== self.seat) return '<p class="waiting-label">相手の選択を待っています。庭を比較して待てます。</p>';
  const actions = legalActions(match);
  const disabled = state.canConfirm ? '' : 'disabled';
  const extra = `${disabled} data-revision="${match.revision}"`;
  const labels = { draw: '山札から1枚引く', 'use-storage': '保管の1枚を使う', self: '自分の庭に使う', store: match.players[self.seat].storage ? '新しい1枚を保管し、前の1枚を使う' : '1枚を保管する', accept: '譲り受ける', decline: '今回は見送る', 'request-invite': '力3で招く希望を出す', 'pass-invite': '招かずに見守る', welcome: '力2で庭に迎える', yield: '渡して、保護代替を引く', meditate: '瞑想する · 力+1', 'pass-final': '最後の石を見送る' };
  let choices = Object.entries(labels).filter(([type]) => actions.some((action) => action.type === type)).map(([type, label]) => button(`command-${type}`, label, extra));
  choices.push(...actions.filter((action) => action.type === 'offer').map((action) => button(`offer-${action.target}`, `${escape(match.players[action.target].name)}に譲る`, extra)));
  if (match.step === 'welcome' && !actions.some((action) => action.type === 'welcome')) choices.push('<p class="power-warning">力が2未満のため庭に迎えられません。渡したあと、保護代替を自庭に置きます。</p>');
  if (match.step === 'place') choices.push(button('rotate', '↻ 90°回す', extra), `<span class="selection-preview terrain-${match.drawn.tile.terrain}" aria-label="配置する向き ${ui.rotation * 90}度">${tileArt({ ...match.drawn.tile, rotation: ui.rotation })}</span>`);
  if (['care', 'final-stone'].includes(match.step)) choices.push(`<div class="match-stones" role="group" aria-label="置く石を選ぶ">${Object.entries(STONES).map(([stone, data]) => button(`stone-${stone}`, `${data.mark} ${data.name} · 力3`, `${extra} ${actions.some((action) => action.stone === stone) ? '' : 'disabled'} aria-pressed="${ui.stone === stone}"`)).join('')}</div>`, ...(match.players[self.seat].power < 3 ? ['<p class="demo-note">石には力3が必要です</p>'] : []));
  return `<div class="match-actions">${choices.join('')}</div>${ui.pending ? `<p class="placement-score">${cellName(ui.pending.index)}に仮置き中 · 得点を確認して確定</p><div class="placement-actions">${button('commit', 'この配置を確定', `class="primary" ${extra}`)}${button('cancel', '仮置きを取り消す', extra)}</div>` : ''}`;
}
function decisionTile(match, ui, selfSeat) {
  if (!match.drawn) return '';
  const tile = { ...match.drawn.tile, rotation: match.step === 'place' && getDecision(match)?.seat === selfSeat ? ui.rotation : match.drawn.tile.rotation };
  return `<div class="decision-tile"><span class="drawn-tile terrain-${tile.terrain}" aria-hidden="true">${tileArt(tile)}<span class="terrain-mark">${TERRAIN[tile.terrain].mark}</span></span><div><strong>公開の1枚: ${tileText(tile)}</strong><p>流れ: ${tilePorts(tile).map((port) => ['上', '右', '下', '左'][port]).join('・')}${match.drawn.protected ? ' · 保護タイル' : ''}</p></div></div>`;
}
export function renderOnline(state, fields = {}) {
  if (!state.room) return renderEntry(state, fields);
  if (!state.room.match) return renderLobby(state);
  const { room, self, ui } = state, match = room.match;
  const player = match.players[self.seat], decision = getDecision(match);
  const session = { garden: player.garden, pending: ui.pending };
  const score = scoreGarden(player.garden);
  const interactive = state.canConfirm && decision?.seat === self.seat && (match.step === 'place' || (['care', 'final-stone'].includes(match.step) && ui.stone));
  return `${connectionPanel(state)}<section class="shared-table panel"><div class="shared-heading"><h2>${phases(match)}</h2><span class="turn-badge">${decision ? `${escape(match.players[decision.seat].name)}の${decision.seat === match.activeSeat ? '番' : '応答'}` : '結果'}</span><a class="match-jump" href="#online-controls">操作・結果へ ↓</a></div><div class="shared-draw">${match.phase === 'finished' ? '<p>庭づくりが完了しました</p>' : decisionTile(match, ui, self.seat) || '<p>次の選択を待っています</p>'}<p class="shared-objective">共通のお題<strong>四隅異なる地形 · 4点</strong></p></div><p class="demo-note">招く優先マーカー: P${match.prioritySeat + 1} ${escape(match.players[match.prioritySeat].name)}から席順 · 確定操作 ${match.revision}回</p></section>
  <div class="garden-layout table-layout match-layout"><section class="opponents panel"><div class="section-label"><h2>相手の庭</h2><span>${match.players.length - 1} GARDEN${match.players.length > 2 ? 'S' : ''}</span></div><p class="opponents-hint">タップして拡大・比較</p><div class="opponent-cards" data-opponent-count="${match.players.length - 1}" style="--opponent-count:1">${match.players.filter((other) => other.seat !== self.seat).map((other) => `<button type="button" class="opponent-card" data-action="inspect" data-seat="${other.seat}" data-focus="inspect-${other.seat}" aria-haspopup="dialog" aria-label="P${other.seat + 1} ${escape(other.name)}を拡大・比較"><span class="opponent-name"><small>P${other.seat + 1}${other.isHuman === false ? ' · NPC' : ''} · 力 ${other.power}/6</small><strong>${escape(other.name)}</strong></span>${renderBoard({ garden: other.garden }, { readOnly: true, compact: true })}<span class="opponent-score"><b>${scoreGarden(other.garden).total}点</b><span>${other.garden.filter(Boolean).length}/16</span></span><span class="card-zoom">保管: ${tileText(other.storage)}<br>拡大・比較 ↗</span></button>`).join('')}</div></section>
  <div class="workbench"><section class="garden-section"><div class="board-title"><h2>あなたの庭 <small>P${self.seat + 1} ${escape(player.name)} · 力 ${player.power}/6 · 手入れ ${player.careCount}回</small></h2><span>${score.filled}/16 マス</span></div>${renderBoard(session, { readOnly: !interactive })}<p class="board-caption">保管: ${tileText(player.storage)}<br>確定した地形や石は動かせません</p></section><section id="online-controls" class="panel match-controls" aria-label="対戦操作">${decisionTile(match, ui, self.seat)}<p class="status" role="status" aria-live="polite">${escape(phaseHint(match))}</p>${controls(state)}</section>
  ${match.phase === 'finished' ? `<section class="panel match-results"><h2>庭の得点</h2><p>サーバーで確定した共通の結果です</p><ol>${room.scores.map((item) => `<li><strong>${item.rank}位 · ${escape(match.players[item.seat].name)}${match.players[item.seat].isHuman === false ? '（NPC）' : ''}</strong><span>${item.score}点</span></li>`).join('')}</ol><p>同点は同じ順位です · 全員 ${player.careCount}回の手入れ</p></section>` : ''}${expiry(room)}</div>
  <aside class="sidebar">${renderScore(displayedGarden(session), score.total, Boolean(ui.pending))}${renderRules()}<section class="panel match-log"><details id="online-log"><summary>庭の記録（${match.log.length}件）</summary><ol>${match.log.slice().reverse().map((message) => `<li>${escape(message)}</li>`).join('')}</ol></details><p class="demo-note">${match.log.slice(-3).map(escape).join('<br>')}</p></section></aside></div>${renderComparison(state)}`;
}
export function renderComparison({ room: { match }, self, ui }) {
  if (!ui.comparison) return '';
  const other = match.players[ui.comparison.seat], pair = ui.comparison.pair;
  const garden = (player, pending = null) => { const session = { garden: player.garden, pending }; return `<section class="comparison-garden${pair ? ' paired-garden' : ''}"><div class="board-title"><h3>P${player.seat + 1} ${escape(player.name)}${player.isHuman === false ? '（NPC）' : ''}</h3><span>力 ${player.power}/6</span></div>${renderBoard(session, { readOnly: true, label: `${player.name}、${pending ? '仮置きを含む' : '確定済み'}、4行4列の閲覧用の庭` })}<p class="comparison-breakdown">保管: ${tileText(player.storage)}</p>${renderScore(displayedGarden(session), scoreGarden(player.garden).total, Boolean(pending), { idPrefix: `comparison-score-${player.seat}`, title: pending ? '仮置きした庭の得点' : '確定した庭の得点', detailsOpen: false, compact: true })}</section>`; };
  return `<dialog id="online-comparison" class="garden-dialog" aria-labelledby="comparison-title"><div class="dialog-heading"><h2 id="comparison-title">${pair ? '譲る・招く前に見比べる' : `${escape(other.name)}を拡大`}</h2>${button('comparison-close', '閉じる', 'autofocus')}</div><div class="comparison-modes">${button('compare-single', '大きく見る', `aria-pressed="${!pair}"`)}${button('compare-pair', '自庭と比較', `aria-pressed="${pair}"`)}</div><p class="comparison-help">比較中も相手は操作できます。確定した庭は最新の状態に更新され、手番の更新時に古い仮置きは解除されます。</p><div class="comparison-boards${pair ? ' is-pair' : ''}">${pair ? garden(match.players[self.seat], ui.pending) : ''}${garden(other)}</div><p class="comparison-legend">${Object.values(TERRAIN).map(({ mark, name }) => `${mark}＝${name}`).join(' / ')}<br>${Object.values(STONES).map(({ mark, name }) => `${mark}＝${name}`).join(' / ')}</p></dialog>`;
}
export function renderRules() {
  return `<section class="rules-panel panel"><details id="online-rules"><summary>対戦のルールと操作</summary><div class="rule-content"><h3>引く・譲る・保管</h3><p>1枚引くか保管を使い、自分で使う・相手に譲る提案・保管を選びます。譲渡成立は力+2。拒否されたら自用か保管へ。再提案はできません。保管は1枚、満杯なら新しい1枚を保管して前の1枚を使います。取り出した保管は再保管できません。</p><h3>精霊を招く・庭に迎える</h3><p>相手が自用にした未配置の1枚へ、力3で招く希望を出せます。希望は撤回できません。持主は力2で庭に迎えるか、渡します。実際に受け取った人だけ力3を使い、優先マーカーはその次の席へ。完成した庭、保護代替、受け取ったタイルには招けません。</p><h3>必ず庭が進む</h3><p>譲渡・招き成立、空の保管に入れたときは、保護代替を引いて自庭へ必ず配置。タイルの後に手入れを1回。瞑想は力+1、石は力3。力は初期4、上限6。確定した庭は変更できません。</p><h3>庭の完成</h3><p>通常12巡、その後は最大4巡の仕上げ。仕上げは保管を先に使い1枚配置し、譲渡・招き・保管はありません。完成済みの人も手入れを続け、全員完成した巡末で最後の石へ。全員同じ回数の手入れをします。最後は手持ちの力で石1個かパス。余力は得点にならず、同点は同順位です。</p><h3>星の石と採点</h3><p>石は各種類1個、地形1枚に1個。各石の上限は6点。</p><ul>${Object.values(STONES).map((stone) => `<li>${stone.name}: ${stone.rule}</li>`).join('')}</ul><p>隣り合う流れの接続1辺につき1点。四隅を4種類の地形で埋めると4点。盤外や斜めはつながりません。</p>${renderRuleExamples()}<h3>人間2人とNPC</h3><p>新しい部屋でNPCを0〜2人選べます。NPCは公開された盤面・タイルと合法手だけで判断し、山札の先は見ません。NPCの選択はサーバーが進め、人間の選択が必要なところで止まります。人間の切断を理由に代わりの操作はしません。</p><h3>オンラインの接続</h3><p>確定はサーバーで行います。通信の結果が不明な間は、新しい操作を重ねず、同じ操作の結果を確認します。部屋は作成から24時間有効です。再戦・退席・別端末への席の移動は初版の対象外です。</p></div></details></section>`;
}
