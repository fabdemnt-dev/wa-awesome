export function speakPoem(text) {
  if (!('speechSynthesis' in window)) {
    return alert('お使いのブラウザは音声読み上げに対応していません。');
  }
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  window.speechSynthesis.speak(utterance);
}
