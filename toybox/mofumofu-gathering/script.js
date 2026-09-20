"use strict";

const ANIMALS = [
  { id:"cat", name:"ねこ", emoji:"🐱" },
  { id:"rabbit", name:"うさぎ", emoji:"🐰" },
  { id:"bear", name:"くま", emoji:"🐻" },
  { id:"chick", name:"ひよこ", emoji:"🐤" },
  { id:"fox", name:"きつね", emoji:"🦊" },
  { id:"penguin", name:"ぺんぎん", emoji:"🐧" },
  { id:"panda", name:"ぱんだ", emoji:"🐼" },
  { id:"polar", name:"しろくま", emoji:"🐻‍❄️" }
];

const PLAYER_DATA = [
  { id:"you", name:"あなた", face:"🙂", personality:"player" },
  { id:"koharu", name:"こはる", face:"🌸", personality:"honest" },
  { id:"mitsuki", name:"みつき", face:"🌙", personality:"mischief" }
];

const $ = (id) => document.getElementById(id);
const screens = ["titleScreen","gameScreen","resultScreen"];
let game = null;
let timers = [];

function later(fn, ms) {
  const id = setTimeout(() => { timers = timers.filter(x => x !== id); fn(); }, ms);
  timers.push(id);
}
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function animal(id) { return ANIMALS.find(a => a.id === id); }
function rand(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[rand(arr.length)]; }
function shuffle(arr) {
  const a = [...arr];
  for (let i=a.length-1;i>0;i--) {
    const j=rand(i+1); [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function showScreen(id) {
  screens.forEach(s => $(s).classList.toggle("active", s === id));
  window.scrollTo({top:0,behavior:"smooth"});
}
function activePlayers() { return game.players.filter(p => !p.out); }
function getPlayer(id) { return game.players.find(p => p.id === id); }
function faceCards(p) { return Object.values(p.faceUp).reduce((sum,n) => sum+n,0); }
function sortHand(player) {
  const order=Object.fromEntries(ANIMALS.map((a,i)=>[a.id,i]));
  player.hand.sort((a,b)=>order[a.id]-order[b.id] || a.uid.localeCompare(b.uid));
}
function addLog(text) {
  game.log.push(text);
  if (game.log.length > 14) game.log.shift();
  renderLog();
}
function flash(text) {
  $("flash").textContent = text;
  $("flash").classList.remove("show");
  void $("flash").offsetWidth;
  $("flash").classList.add("show");
}
function makeDeck() {
  const cards=[];
  ANIMALS.forEach(a => { for(let i=0;i<4;i++) cards.push({id:a.id, uid:a.id+"-"+i}); });
  return shuffle(cards);
}
function freshPlayer(data) {
  return {...data, hand:[], faceUp:Object.fromEntries(ANIMALS.map(a=>[a.id,0])), out:false};
}
function freshHistory(players) {
  return Object.fromEntries(players.map(p => [p.id,{truth:0,total:0}]));
}

function startGame() {
  clearTimers();
  const deck=makeDeck();
  const players=PLAYER_DATA.map(freshPlayer);
  // 10枚ずつ配り、余り2枚は使わない山札へ。
  for(let i=0;i<10;i++) players.forEach(p => p.hand.push(deck.pop()));
  game={
    players, deck, discard:[], turnIndex:0, selectedUid:null, claim:null,
    offer:null, log:["ゲームスタート！ あなたからどうぞ。"],
    history:freshHistory(players),
    ended:false
  };
  showScreen("gameScreen");
  render();
  beginTurn();
}

function beginTurn() {
  if (!game || game.ended) return;
  const alive=activePlayers();
  if (alive.length === 1) return finishWinner(alive[0], "最後まで残りました！");
  if (alive.some(p => p.hand.length === 0)) return finishByHandEmpty(alive);

  let guard=0;
  while (game.players[game.turnIndex].out && guard++ < game.players.length) {
    game.turnIndex=(game.turnIndex+1)%game.players.length;
  }
  const actor=game.players[game.turnIndex];
  if (actor.hand.length === 0) {
    // 3人以上で手札が尽きた場合は、行動不能者を脱落扱いにはせず手番だけ飛ばす。
    // ただし残り2人なら上の特別終了条件が適用される。
    addLog(actor.name+"は手札がないので手番をスキップ。");
    return nextTurn();
  }
  game.selectedUid=null; game.claim=null; game.offer=null;
  render();
  if (actor.id !== "you") later(cpuTurn, 650);
}

function nextTurn() {
  if (game.ended) return;
  game.turnIndex=(game.turnIndex+1)%game.players.length;
  later(beginTurn, 450);
}

function render() {
  if (!game) return;
  const actor=game.players[game.turnIndex];
  $("turnBadge").textContent=actor.out ? "進行中" : actor.name+"の番";
  $("deckCount").textContent=game.deck.length;
  renderCpus();
  renderHand();
  renderJudgeHand();
  renderClaims();
  renderTargets();
  renderCollections();
  renderLog();

  const yourTurn=actor.id==="you" && !game.offer;
  $("handStep").classList.toggle("hidden",!yourTurn);
  $("claimStep").classList.toggle("hidden",!yourTurn || !game.selectedUid);
  $("targetStep").classList.toggle("hidden",!yourTurn || !game.selectedUid || !game.claim);
  $("judgeStep").classList.toggle("hidden",!(game.offer && game.offer.to==="you"));
  if (!game.offer) {
    $("offerText").textContent=yourTurn ? "カードを選んでね" : actor.name+"が考えています…";
  }
}

function renderCpus() {
  $("cpuRow").innerHTML=game.players.filter(p=>p.id!=="you").map(p =>
    `<div class="player-box ${game.players[game.turnIndex].id===p.id?"current":""} ${p.out?"out":""}">
      <div class="face">${p.face}</div><div class="name">${p.name}${p.out?"（脱落）":""}</div>
      <div class="count">手札 ${p.hand.length}枚 ／ 表向き ${faceCards(p)}枚</div>
    </div>`
  ).join("");
}

function renderHand() {
  const you=getPlayer("you");
  $("hand").innerHTML=you.hand.length ? you.hand.map(c => {
    const a=animal(c.id);
    return `<button class="hand-card ${game.selectedUid===c.uid?"selected":""}" data-uid="${c.uid}" aria-label="${a.name}のカード">
      <span>${a.emoji}</span><small>${a.name}</small>
    </button>`;
  }).join("") : "<p>手札はありません。</p>";
  document.querySelectorAll(".hand-card").forEach(btn => btn.addEventListener("click",()=>{
    if(game.players[game.turnIndex].id!=="you" || game.offer) return;
    game.selectedUid=btn.dataset.uid; game.claim=null; render();
  }));
}

function renderJudgeHand() {
  const box=$("judgeHand");
  if(!box) return;
  const you=getPlayer("you");
  box.innerHTML=you.hand.length ? you.hand.map(c=>{
    const a=animal(c.id);
    return `<div class="hand-card read-only"><span>${a.emoji}</span><small>${a.name}</small></div>`;
  }).join("") : "<p>手札はありません。</p>";
}

function renderClaims() {
  $("claimButtons").innerHTML=ANIMALS.map(a =>
    `<button class="${game.claim===a.id?"selected":""}" aria-pressed="${game.claim===a.id}" data-claim="${a.id}">${game.claim===a.id?"✓ ":""}${a.emoji} ${a.name}</button>`
  ).join("");
  document.querySelectorAll("[data-claim]").forEach(btn=>btn.addEventListener("click",()=>{
    game.claim=btn.dataset.claim; render();
  }));
}

function renderTargets() {
  const targets=activePlayers().filter(p=>p.id!=="you");
  $("targetButtons").innerHTML=targets.map(p=>`<button data-target="${p.id}">${p.face} ${p.name}に渡す</button>`).join("");
  document.querySelectorAll("[data-target]").forEach(btn=>btn.addEventListener("click",()=>playerOffer(btn.dataset.target)));
}

function renderCollections() {
  $("collections").innerHTML=game.players.map(p=>{
    const chips=ANIMALS.filter(a=>p.faceUp[a.id]>0).map(a=>{
      const n=p.faceUp[a.id];
      return `<span class="chip ${n>=3?"danger":""}">${a.emoji}${a.name} ×${n}</span>`;
    }).join("") || '<span class="chip">まだ0枚</span>';
    return `<div class="collection-row ${p.out?"out":""}"><strong>${p.face} ${p.name}${p.out?"（脱落）":""}</strong><div class="chips">${chips}</div></div>`;
  }).join("");
}
function renderLog() {
  if(!game) return;
  $("log").innerHTML=game.log.map(x=>`<p>${escapeHtml(x)}</p>`).join("");
  $("log").scrollTop=$("log").scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function playerOffer(targetId) {
  const you=getPlayer("you");
  const idx=you.hand.findIndex(c=>c.uid===game.selectedUid);
  if(idx<0 || !game.claim) return;
  const card=you.hand.splice(idx,1)[0];
  createOffer("you",targetId,card,game.claim);
}

function createOffer(from,to,card,claim) {
  game.offer={from,to,card,claim};
  game.history[from].total++;
  if(card.id===claim) game.history[from].truth++;
  const giver=getPlayer(from), receiver=getPlayer(to), a=animal(claim);
  addLog(`${giver.name}「これは『${a.name}』だよ」→ ${receiver.name}`);
  $("offerText").textContent=`${giver.name}「${a.name}だよ」`;
  $("offerCardMain").textContent="？";
  $("offerCardSub").textContent=`宣言：${a.name}`;
  animateCard(to);
  render();
  if(to!=="you") later(()=>cpuJudge(to),800);
}

function animateCard(targetId) {
  const el=$("flyingCard");
  el.className="flying-card";
  void el.offsetWidth;
  const targets=activePlayers().filter(p=>p.id!==game.offer.from);
  const targetIndex=Math.max(0,targets.findIndex(p=>p.id===targetId));
  el.classList.add(targetIndex % 2 ? "fly-right" : "fly-left");
}

function cpuTurn() {
  if(game.ended) return;
  const cpu=game.players[game.turnIndex];
  if(cpu.out || cpu.hand.length===0) return beginTurn();
  const card=pick(cpu.hand);
  const truthChance=cpu.personality==="honest" ? .72 : .30;
  let claim;
  if(Math.random()<truthChance) claim=card.id;
  else claim=pick(ANIMALS.filter(a=>a.id!==card.id)).id;
  const targets=activePlayers().filter(p=>p.id!==cpu.id);
  // 初心者向けに、CPUは人間を極端に集中攻撃しない。
  const humanTarget=targets.find(p=>p.personality==="player");
  const target=Math.random()<.48 && humanTarget ? humanTarget : pick(targets);
  cpu.hand.splice(cpu.hand.findIndex(c=>c.uid===card.uid),1);
  createOffer(cpu.id,target.id,card,claim);
}

function cpuJudge(cpuId) {
  const cpu=getPlayer(cpuId), offer=game.offer;
  if(!offer || offer.to!==cpuId) return;
  const h=game.history[offer.from];
  const observed=h.total>1 ? h.truth/h.total : .5;
  let believe=.5+(observed-.5)*.45;
  if(cpu.personality==="honest") believe+=.05;
  if(cpu.personality==="mischief") believe-=.06;
  believe=Math.max(.28,Math.min(.72,believe));
  resolveJudge(Math.random()<believe);
}

function resolveJudge(saysTrue) {
  const offer=game.offer;
  if(!offer || game.ended) return;
  const actualTruth=offer.card.id===offer.claim;
  const success=(saysTrue && actualTruth)||(!saysTrue && !actualTruth);
  const judge=getPlayer(offer.to), giver=getPlayer(offer.from);
  const receiver=success ? giver : judge;
  const verdict=saysTrue?"ほんと？":"うそ！";
  addLog(`${judge.name}「${verdict}」→ ${success?"判定成功！":"判定失敗！"} 正体は${animal(offer.card.id).name}。`);
  receiver.faceUp[offer.card.id]++;
  flash(success?"✨ 判定成功！":"💭 判定失敗！");
  game.offer=null;
  $("offerCardMain").textContent=animal(offer.card.id).emoji;
  $("offerCardSub").textContent=`正体：${animal(offer.card.id).name}`;
  $("offerText").textContent=`${receiver.name}が受け取りました`;
  render();
  if(receiver.faceUp[offer.card.id]>=4) return later(()=>eliminate(receiver,offer.card.id),700);
  later(nextTurn,700);
}

function eliminate(player, animalId) {
  if(player.out || game.ended) return;
  player.out=true;
  game.discard.push(...player.hand);
  player.hand=[];
  ANIMALS.forEach(a=>{
    for(let i=0;i<player.faceUp[a.id];i++) game.discard.push({id:a.id,uid:"discard-"+Math.random()});
    player.faceUp[a.id]=0;
  });
  addLog(`${player.name}は「もふもふ大集合！」 ${animal(animalId).name}が4枚そろって脱落！`);
  flash("🐾 もふもふ大集合！");
  render();
  const alive=activePlayers();
  if(alive.length===1) return later(()=>finishWinner(alive[0],"最後まで残りました！"),700);
  later(nextTurn,850);
}

function finishByHandEmpty(alive) {
  const counts=alive.map(p=>({p,n:faceCards(p)}));
  game.finalSnapshot=game.players.map(p=>({id:p.id,name:p.name,face:p.face,count:faceCards(p),out:p.out}));
  if(counts[0].n===counts[1].n) {
    finishResult(null,`手札切れで終了。表向きカードは両者とも${counts[0].n}枚。引き分けです！`,"🤝 引き分け！");
  } else {
    const winner=counts[0].n<counts[1].n?counts[0].p:counts[1].p;
    finishWinner(winner,`手札切れで終了。表向きカードが少ない${winner.name}の勝ち！`);
  }
}

function finishWinner(winner, reason) {
  const youWon=winner.id==="you";
  finishResult(winner,reason,youWon?"🎉 もふもふ回避！ あなたの勝ち！":`${winner.face} ${winner.name}の勝ち！`);
}

function finishResult(winner,text,title) {
  game.ended=true; clearTimers();
  $("resultTitle").textContent=title;
  $("resultText").textContent=text;
  const snapshot=game.finalSnapshot || game.players.map(p=>({id:p.id,name:p.name,face:p.face,count:faceCards(p),out:p.out}));
  $("resultDetails").innerHTML=snapshot.map(p=>`<div class="result-row"><strong>${p.face} ${p.name}</strong><span>表向き ${p.count}枚${p.out?" ／ 脱落":""}</span></div>`).join("");
  $("resultAnimals").innerHTML="<span>🐾</span><span>✨</span><span>🐾</span>";
  $("resultAnimals").classList.remove("bounce");
  showScreen("resultScreen");
}

$("sortHandBtn").addEventListener("click",()=>{
  if(!game || game.ended) return;
  const you=getPlayer("you");
  sortHand(you);
  renderHand();
  flash("手札を自動整列しました");
});
$("truthBtn").addEventListener("click",()=>resolveJudge(true));
$("lieBtn").addEventListener("click",()=>resolveJudge(false));
$("startBtn").addEventListener("click",startGame);
$("retryBtn").addEventListener("click",startGame);
$("titleBtn").addEventListener("click",()=>{clearTimers();game=null;showScreen("titleScreen");});
$("howBtn").addEventListener("click",()=>$("howDialog").showModal());
$("gameHowBtn").addEventListener("click",()=>$("howDialog").showModal());
$("closeHowBtn").addEventListener("click",()=>$("howDialog").close());
$("howDialog").addEventListener("click",e=>{if(e.target===$("howDialog")) $("howDialog").close();});