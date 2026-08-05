// 【音声読み上げ機能（ポエム用）】
window.speakPoem = function(text) {
  if (!('speechSynthesis' in window)) {
    return alert('お使いのブラウザは音声読み上げに対応していません。');
  }

  // 連続でボタンが押された場合に前の音声を止める
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP'; // 日本語設定
  utterance.rate = 1.0;   // 読み上げ速度 (0.1 〜 10)
  utterance.pitch = 1.0;  // 声の高さ (0 〜 2)

  window.speechSynthesis.speak(utterance);
};
