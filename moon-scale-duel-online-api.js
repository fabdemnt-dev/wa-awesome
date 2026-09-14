import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { functions } from './moon-scale-duel-online-firebase.js';

const call = (name, data) => httpsCallable(functions, name)(data).then((response) => response.data);

export const api = {
  createRoom: (data) => call('moonScaleDuelCreateRoom', data),
  joinRoom: (data) => call('moonScaleDuelJoinRoom', data),
  snapshot: (data) => call('moonScaleDuelGetSnapshot', data),
  startGame: (data) => call('moonScaleDuelStartGame', data),
  submitCard: (data) => call('moonScaleDuelSubmitCard', data),
  submitCopyTarget: (data) => call('moonScaleDuelSubmitCopyTarget', data),
  readyNextRound: (data) => call('moonScaleDuelReadyNextRound', data),
  extendNextRoundWait: (data) => call('moonScaleDuelExtendNextRoundWait', data),
  abortAfterWait: (data) => call('moonScaleDuelAbortAfterWait', data),
  requestRematch: (data) => call('moonScaleDuelRequestRematch', data),
  cancelRematch: (data) => call('moonScaleDuelCancelRematch', data),
};
