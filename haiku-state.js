// ブラウザに一時保存されている手札があれば取得
const savedHand = sessionStorage.getItem('haikuSelectedHand');

const state = {
  roomId: "",
  myName: "",
  isSpectator: false,
  roomRef: null,

  myHand5: [],
  myHand7: [],
  // 保存データがあればそれを復元、なければ空っぽにする
  selectedHand: savedHand ? JSON.parse(savedHand) : [null, null, null],

  currentData: null,

  isSubmittingSelfPraise: false,
  isProcessingNextRound: false
};

export default state;
