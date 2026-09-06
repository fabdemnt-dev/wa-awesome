import{httpsCallable}from'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';import{functions}from'./shadow-card-online-firebase.js';
const call=(name,data)=>httpsCallable(functions,name)(data).then(r=>r.data);
export const api={createRoom:d=>call('shadowCardCreateRoom',d),joinRoom:d=>call('shadowCardJoinRoom',d),startGame:d=>call('shadowCardStartGame',d),submitChoice:d=>call('shadowCardSubmitChoice',d),continueGame:d=>call('shadowCardContinueGame',d),snapshot:d=>call('shadowCardGetSnapshot',d)};
