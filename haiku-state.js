// ブラウザに一時保存されている手札があれば取得
const savedHand = sessionStorage.getItem('haikuSelectedHand');

const state = {
  roomId: "",
  myUid: "",
  myName: "",
  isSpectator: false,
  roomRef: null,

  myHand5: [],
  myHand7: [],
  redrawUsed: false,
  // v2引き直し成功を同一ルーム・同一節の古いhand Snapshotから保護する。
  redrawSuccessKey: "",
  // 保存データがあればそれを復元、なければ空っぽにする
  selectedHand: savedHand ? JSON.parse(savedHand) : [null, null, null],

  currentData: null,

  isSubmittingWords: false,
  isSubmittingPhrase: false,
  submittedPhraseKey: "",
  isSubmittingSelfPraise: false,
  isSubmittingVote: false,
  isProcessingNextRound: false,

  // 「選んだ札だけ引き直す」機能用：引き直し対象として選んでいる札のid一覧
  // （句をつくるためのselectedHandとは完全に別の選択状態として管理する）
  redrawSelected5: [],
  redrawSelected7: [],
  isProcessingRedraw: false
};

export default state;
