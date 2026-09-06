import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowNextRound } from '../shadow-card-online-ui.js';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, terminate } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, ref, set, get, onDisconnect, goOffline, goOnline } from 'firebase/database';
import { createRequire } from 'node:module';
const functionRequire=createRequire(new URL('../functions/package.json',import.meta.url));
const {initializeApp:initializeAdminApp,getApps:getAdminApps,deleteApp:deleteAdminApp}=functionRequire('firebase-admin/app');
const {getAuth:getAdminAuth}=functionRequire('firebase-admin/auth');
const {getFirestore:getAdminFirestore,Timestamp:AdminTimestamp}=functionRequire('firebase-admin/firestore');
const ownedClients=new Set();
let ownedAdminApp=null;
if(!getAdminApps().length)ownedAdminApp=initializeAdminApp({projectId:'demo-shadow-card',databaseURL:'http://127.0.0.1:9000?ns=demo-shadow-card'});
const config={projectId:'demo-shadow-card',apiKey:'demo',appId:'demo',databaseURL:'http://127.0.0.1:9000?ns=demo-shadow-card'};
function client(name){const app=initializeApp(config,name);const auth=getAuth(app),fs=getFirestore(app),fn=getFunctions(app,'asia-northeast1'),rt=getDatabase(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectFirestoreEmulator(fs,'127.0.0.1',8080);connectFunctionsEmulator(fn,'127.0.0.1',5001);connectDatabaseEmulator(rt,'127.0.0.1',9000);const owned={app,auth,fs,fn,rt,call:(n,d)=>httpsCallable(fn,n)(d).then(x=>x.data)};ownedClients.add(owned);return owned}
async function denied(p){await assert.rejects(p)}
async function deniedWithCode(p,code){await assert.rejects(p,(error)=>{assert.equal(error.code,code);return true})}
function normalized(value){
  if(value&&typeof value.toMillis==='function')return{__timestamp:value.toMillis()};
  if(Array.isArray(value))return value.map(normalized);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalized(value[key])]));
  return value;
}
async function captureJoinState(roomId,locator){
  const adminDb=getAdminFirestore();
  const room=adminDb.collection('shadowCardRooms').doc(roomId);
  const [roomSnap,locatorSnap,secretSnap,members,seats]=await Promise.all([
    room.get(),
    adminDb.collection('shadowCardRoomLocators').doc(locator).get(),
    adminDb.collection('shadowCardRoomSecrets').doc(roomId).get(),
    room.collection('members').get(),
    room.collection('seats').get(),
  ]);
  const docs=(snapshot)=>snapshot.docs.map(doc=>({id:doc.id,data:normalized(doc.data())})).sort((a,b)=>a.id.localeCompare(b.id));
  return{room:normalized(roomSnap.data()),locator:normalized(locatorSnap.data()),secret:normalized(secretSnap.data()),members:docs(members),seats:docs(seats)};
}
test.after(async()=>{
  console.log('[cleanup] begin');
  for(const {rt} of ownedClients)goOffline(rt);
  console.log('[cleanup] RTDB disconnected');
  await Promise.allSettled([...ownedClients].map(({fs})=>terminate(fs)));
  console.log('[cleanup] Firestore terminated');
  await Promise.allSettled([...ownedClients].map(({app})=>deleteApp(app)));
  console.log('[cleanup] Client Apps deleted');
  if(ownedAdminApp){
    await deleteAdminApp(ownedAdminApp);
    console.log('[cleanup] Admin App deleted');
  }else{
    console.log('[cleanup] Admin App not owned; skipped');
  }
  console.log('[cleanup] complete');
});
test('next-round visibility follows game phase',()=>{
  assert.equal(shouldShowNextRound({phase:'round-result'}),true);
  assert.equal(shouldShowNextRound({phase:'finished'}),false);
  assert.equal(shouldShowNextRound({phase:'choosing'}),false);
});
test('two anonymous players complete private five-round match with presence and timeout',{timeout:120000},async()=>{const a=client('human-a'),b=client('human-b');await signInAnonymously(a.auth);await signInAnonymously(b.auth);assert.notEqual(a.auth.currentUser.uid,b.auth.currentUser.uid);
  const created=await a.call('shadowCardCreateRoom',{displayName:'A'});const joined=await b.call('shadowCardJoinRoom',{displayName:'B',inviteCode:created.inviteCode});assert.equal(joined.roomId,created.roomId);const roomId=created.roomId;
  let lobby=await a.call('shadowCardGetSnapshot',{roomId});assert.equal(lobby.members.length,2);assert.deepEqual(lobby.seats.map(s=>s.seatId),['seat0','seat1','seat2','seat3']);
  await set(ref(a.rt,`shadowCardPresence/${roomId}/${a.auth.currentUser.uid}`),{state:'online',lastChanged:Date.now()});await set(ref(b.rt,`shadowCardPresence/${roomId}/${b.auth.currentUser.uid}`),{state:'online',lastChanged:Date.now()});
  await denied(getDoc(doc(a.fs,`shadowCardRooms/${roomId}/privatePlayers/${b.auth.currentUser.uid}/rounds/1`)));await denied(getDoc(doc(a.fs,`shadowCardRooms/${roomId}/serverRounds/1`)));await denied(getDoc(doc(a.fs,`shadowCardRoomSecrets/${roomId}`)));await denied(getDoc(doc(a.fs,`shadowCardRoomLocators/${created.inviteCode.slice(4,10)}`)));
  await a.call('shadowCardStartGame',{roomId});let[sa,sb]=await Promise.all([a.call('shadowCardGetSnapshot',{roomId}),b.call('shadowCardGetSnapshot',{roomId})]);assert.equal(sa.privateRound.hand.length,4);assert.equal(sb.privateRound.hand.length,4);assert.equal(sa.result,null);assert.equal(sa.round.submittedSeats,2);
  await a.call('shadowCardSubmitChoice',{roomId,gameId:sa.room.gameId,roundNumber:1,handIndex:0,stateVersion:sa.game.stateVersion,requestId:'timeout-a'});const earlySweep=await a.call('shadowCardTestSweepTimeouts',{});assert.equal(earlySweep.swept,0);sa=await a.call('shadowCardGetSnapshot',{roomId});assert.equal(sa.result,null);await new Promise(r=>setTimeout(r,5500));const lateSweep=await a.call('shadowCardTestSweepTimeouts',{});assert.equal(lateSweep.swept,1);sa=await a.call('shadowCardGetSnapshot',{roomId});assert.ok(sa.result,'timeout sweep must publish a round result');assert.equal(Object.keys(sa.result.played).length,4);assert.deepEqual(Object.keys(sa.result.played).sort(),['seat0','seat1','seat2','seat3']);assert.equal(sa.result.played.seat0.cardId,sa.privateRound.hand[0]);
  for(let round=2;round<=5;round++){await a.call('shadowCardContinueGame',{roomId});sa=await a.call('shadowCardGetSnapshot',{roomId});sb=await b.call('shadowCardGetSnapshot',{roomId});const payloadA={roomId,gameId:sa.room.gameId,roundNumber:round,handIndex:0,stateVersion:sa.game.stateVersion,requestId:`a-${round}`};const payloadB={roomId,gameId:sb.room.gameId,roundNumber:round,handIndex:1,stateVersion:sb.game.stateVersion,requestId:`b-${round}`};await Promise.all([a.call('shadowCardSubmitChoice',payloadA),b.call('shadowCardSubmitChoice',payloadB)]);await a.call('shadowCardSubmitChoice',payloadA);await assert.rejects(a.call('shadowCardSubmitChoice',{...payloadA,requestId:`a-duplicate-${round}`}));sa=await a.call('shadowCardGetSnapshot',{roomId});assert.equal(Object.keys(sa.result.played).length,4);assert.equal(sa.round.revealed,true)}assert.equal(sa.game.phase,'finished');assert.equal(sa.game.roundNumber,5);
  const second=client('same-a-tab');const token=await getAdminAuth().createCustomToken(a.auth.currentUser.uid);await signInWithCustomToken(second.auth,token);assert.equal(second.auth.currentUser.uid,a.auth.currentUser.uid);await onDisconnect(ref(second.rt,`shadowCardPresence/${roomId}/${a.auth.currentUser.uid}`)).set({state:'offline',lastChanged:Date.now()});await set(ref(second.rt,`shadowCardPresence/${roomId}/${a.auth.currentUser.uid}`),{state:'online',lastChanged:Date.now()});goOffline(second.rt);await new Promise(r=>setTimeout(r,300));const seen=await get(ref(b.rt,`shadowCardPresence/${roomId}/${a.auth.currentUser.uid}`));assert.equal(seen.val().state,'offline');goOnline(second.rt);await set(ref(second.rt,`shadowCardPresence/${roomId}/${a.auth.currentUser.uid}`),{state:'online',lastChanged:Date.now()});assert.equal((await get(ref(b.rt,`shadowCardPresence/${roomId}/${a.auth.currentUser.uid}`))).val().state,'online');
});

test('expired locator rejects join without mutating invite state',{timeout:30000},async()=>{
  const host=client('expired-locator-host'),guest=client('expired-locator-guest');
  await signInAnonymously(host.auth);await signInAnonymously(guest.auth);
  const created=await host.call('shadowCardCreateRoom',{displayName:'Locator Host'});
  const locator=created.inviteCode.split('-')[1];
  await getAdminFirestore().collection('shadowCardRoomLocators').doc(locator).update({expiresAt:AdminTimestamp.fromMillis(Date.now()-1000)});
  const before=await captureJoinState(created.roomId,locator);
  await deniedWithCode(guest.call('shadowCardJoinRoom',{displayName:'Locator Guest',inviteCode:created.inviteCode}),'functions/not-found');
  assert.deepEqual(await captureJoinState(created.roomId,locator),before);
});

test('expired room rejects join without mutating invite state',{timeout:30000},async()=>{
  const host=client('expired-room-host'),guest=client('expired-room-guest');
  await signInAnonymously(host.auth);await signInAnonymously(guest.auth);
  const created=await host.call('shadowCardCreateRoom',{displayName:'Room Host'});
  const locator=created.inviteCode.split('-')[1];
  await getAdminFirestore().collection('shadowCardRooms').doc(created.roomId).update({expiresAt:AdminTimestamp.fromMillis(Date.now()-1000)});
  const before=await captureJoinState(created.roomId,locator);
  await deniedWithCode(guest.call('shadowCardJoinRoom',{displayName:'Room Guest',inviteCode:created.inviteCode}),'functions/not-found');
  assert.deepEqual(await captureJoinState(created.roomId,locator),before);
});
