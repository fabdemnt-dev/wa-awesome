import{app,db}from'./firebase-config.js';
import{getAuth,signInAnonymously,connectAuthEmulator}from'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import{connectFirestoreEmulator}from'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import{getFunctions,connectFunctionsEmulator}from'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import{getDatabase,connectDatabaseEmulator}from'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
export const auth=getAuth(app);export const functions=getFunctions(app,'asia-northeast1');export const rtdb=getDatabase(app);
if(location.hostname==='localhost'||location.hostname==='127.0.0.1'){connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectFirestoreEmulator(db,'127.0.0.1',8080);connectFunctionsEmulator(functions,'127.0.0.1',5001);connectDatabaseEmulator(rtdb,'127.0.0.1',9000)}
export async function ensureAnonymousUser(){return(await signInAnonymously(auth)).user}
