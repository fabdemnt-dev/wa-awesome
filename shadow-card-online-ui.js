const ids=['entry','lobby','game'];
export const el=id=>document.getElementById(id);
function setHidden(node,hidden){node.hidden=hidden;node.style.display=hidden?'none':''}
export function show(id){ids.forEach(x=>setHidden(el(x),x!==id))}
export function status(t){el('status').textContent=t}

const cards={
  breakthrough:{name:'突破',type:'攻勢',image:'assets/shadow-card/card-breakthrough.webp'},
  'all-out':{name:'全力',type:'攻勢',image:'assets/shadow-card/card-all-out.webp'},
  assist:{name:'援護',type:'支援',image:'assets/shadow-card/card-assist.webp'},
  defense:{name:'守勢',type:'支援',image:'assets/shadow-card/card-defense.webp'},
  check:{name:'けん制',type:'妨害',image:'assets/shadow-card/card-check.webp'},
  disrupt:{name:'崩し',type:'妨害',image:'assets/shadow-card/card-disrupt.webp'},
  shift:{name:'変転',type:'撹乱',image:'assets/shadow-card/card-shift.webp'},
  misdirect:{name:'誘導',type:'撹乱',image:'assets/shadow-card/card-misdirect.webp'}
};
const npcs={
  support:{name:'支援型',description:'連携と守りを重視',image:'assets/shadow-card/npc-support.webp'},
  aggressive:{name:'強気型',description:'高い基本値で押し切る',image:'assets/shadow-card/npc-aggressive.webp'},
  bluff:{name:'ブラフ型',description:'変化と読み合いを重視',image:'assets/shadow-card/npc-bluff.webp'}
};
const resultImages={
  round:'assets/shadow-card/result-round.webp',
  win:'assets/shadow-card/result-win.webp',
  lose:'assets/shadow-card/result-lose.webp',
  draw:'assets/shadow-card/result-draw.webp'
};

function cardInfo(id){return cards[id]||{name:id||'不明',type:'',image:''}}
function npcInfo(role){return npcs[role]||{name:'NPC',description:'',image:''}}
function playerTeam(s){return s.seats?.find(seat=>seat.seatId===s.member?.seatId)?.team||null}
function npcMarkup(role,label){const npc=npcInfo(role);return `<article class="npc-card"><img src="${npc.image}" alt="" width="1024" height="1024"><div class="npc-card__body"><span class="npc-card__label">${escapeHtml(label)}</span><strong class="npc-card__name">${escapeHtml(npc.name)}</strong><p class="npc-card__desc">${escapeHtml(npc.description)}</p></div></article>`}

export function lobby(s,code){
  show('lobby');
  const limit=Number(s.room.humanLimit)||2;
  el('lobby-mode').textContent=`${limit}人対戦：参加者 ${s.members.length} / ${limit}`;
  const codeEl=el('shown-code');
  const hint=el('copy-code-hint');
  codeEl.textContent=code||'参加済み';
  codeEl.classList.toggle('invite-code--copyable',Boolean(code));
  if(code){
    codeEl.setAttribute('role','button');
    codeEl.setAttribute('tabindex','0');
    codeEl.setAttribute('aria-label',`招待コード ${code}。タップしてコピー`);
    setHidden(hint,false);
    hint.textContent='タップでコピー';
  }else{
    codeEl.removeAttribute('role');
    codeEl.removeAttribute('tabindex');
    codeEl.removeAttribute('aria-label');
    setHidden(hint,true);
  }
  el('members').innerHTML=s.members.map(m=>`<li>${escapeHtml(m.displayName)}（${m.role==='host'?'ホスト':'参加者'}）</li>`).join('');
  el('lobby-npc').innerHTML=limit===2?npcMarkup(s.member?.seatId==='seat2'?'aggressive':'support','あなたの味方NPC'):limit===3?'<p>開始時にチームを公平に決定し、空席をNPCが担当します。</p>':'<p>4人全員が人間プレイヤーです。</p>';
  setHidden(el('start-match'),s.member.role!=='host'||s.members.length<limit);
}

export function game(s,onSelect){
  show('game');
  el('round-label').textContent=`ROUND ${s.game.roundNumber} / 5`;
  el('score-label').textContent=`${s.game.scores.A} - ${s.game.scores.B}`;
  el('field-label').textContent=`場札：${s.round.field.name}（${s.round.field.points}点）`;
  el('deadline').textContent=s.game.phase==='finished'?'対戦終了':s.round.phase==='choosing'?'選択期限は90秒です。':'全員公開済み';
  renderNpcPanel(s);
  const hand=s.privateRound?.hand||[];
  el('hand').innerHTML=hand.map((id,i)=>{
    const card=cardInfo(id);
    return `<button class="card" type="button" role="radio" aria-checked="false" data-index="${i}" aria-label="${escapeHtml(card.name)}を選ぶ"><img class="card__image" src="${card.image}" alt="" width="1200" height="800"><span class="card__body"><span class="card__type">${escapeHtml(card.type)}</span><strong>${escapeHtml(card.name)}</strong><span class="card__meta">手札 ${i+1}</span></span></button>`;
  }).join('');
  el('hand').querySelectorAll('.card').forEach(b=>b.onclick=()=>onSelect(Number(b.dataset.index),b));
  setHidden(el('submit-card'),s.round.phase!=='choosing');
  el('submit-card').disabled=s.privateRound?.submitted!==false;
  renderResult(s.result,s.game,s);
}

function renderNpcPanel(s){
  const team=playerTeam(s);
  const npcSeats=(s.seats||[]).filter(seat=>seat.controllerType==='npc');
  el('npc-panel').innerHTML=npcSeats.length?npcSeats.map(seat=>npcMarkup(seat.npcRole,seat.team===team?'あなたの味方NPC':'相手の味方NPC')).join(''):'<p>この対戦にNPCはいません。</p>';
}

export function shouldShowNextRound(g){return g?.phase==='round-result'}
export function finalOutcomeText(g){
  if(g?.phase!=='finished')return'';
  const a=Number(g?.scores?.A||0),b=Number(g?.scores?.B||0);
  if(a===b)return'総合結果：引き分け';
  return`総合結果：${a>b?'A':'B'}チーム勝利`;
}

function finalResultKind(g,s){
  const a=Number(g?.scores?.A||0),b=Number(g?.scores?.B||0);
  if(a===b)return'draw';
  const winner=a>b?'A':'B';
  return winner===playerTeam(s)?'win':'lose';
}
function seatLabel(s,seatId){
  if(seatId===s.member?.seatId)return'あなた';
  const seat=(s.seats||[]).find(item=>item.seatId===seatId);
  if(!seat)return seatId;
  const mine=seat.team===playerTeam(s);
  if(seat.controllerType==='npc')return mine?'味方NPC':'相手NPC';
  const member=(s.members||[]).find(item=>item.seatId===seatId);
  return member?.displayName?`${member.displayName}（${mine?'味方':'相手'}）`:mine?'味方プレイヤー':'相手プレイヤー';
}
function playedCardMarkup(s,seatId,played){
  const card=cardInfo(played.cardId);
  return `<article class="result-card"><img src="${card.image}" alt="" width="1200" height="800"><div class="result-card__body"><span class="result-card__owner">${escapeHtml(seatLabel(s,seatId))}</span><strong>${escapeHtml(card.name)}</strong><span class="result-card__value">基本値 ${played.resolvedBaseValue}</span></div></article>`;
}
function renderResult(r,g,s){
  el('result').innerHTML='';
  setHidden(el('next-round'),!shouldShowNextRound(g));
  setHidden(el('return-to-title'),g?.phase!=='finished');
  if(!r)return;
  const finished=g.phase==='finished';
  const resultKind=finished?finalResultKind(g,s):'round';
  const resultAlt=finished?(resultKind==='win'?'勝利':resultKind==='lose'?'敗北':'引き分け'):'ラウンド結果';
  const heading=r.outcome==='draw'?'引き分け':r.outcome==='A'?'Aチーム勝利':'Bチーム勝利';
  const final=finished?`<div class="final-summary"><h2>最終結果</h2><img class="final-result-art" src="${resultImages[resultKind]}" alt="" width="1200" height="675"><p class="final-outcome">${finalOutcomeText(g)}</p><p>最終スコア A ${g.scores.A} - B ${g.scores.B}</p></div>`:'';
  const roundArt=finished?'':`<img class="round-result-art" src="${resultImages.round}" alt="" width="1200" height="675">`;
  const box=document.createElement('div');
  box.className='revealed';
  box.setAttribute('aria-label',resultAlt);
  box.innerHTML=`${roundArt}<h2>${heading}</h2><div class="result-cards">${Object.entries(r.played).map(([seat,played])=>playedCardMarkup(s,seat,played)).join('')}</div><p class="result-total">最終値 A ${r.calculation.A.finalValue} - B ${r.calculation.B.finalValue}</p>${final}`;
  el('result').append(box);
}

function escapeHtml(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML}
