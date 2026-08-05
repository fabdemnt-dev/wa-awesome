import './firebase-config.js';
import './poem-state.js';
import './poem-audio.js';
import './poem-export.js';
import './poem-render.js';
import './poem-action.js';

// 参加ボタンのイベントリスナー登録
document.getElementById("join-btn")
  ?.addEventListener("click", function() {
    if (typeof window.joinRoom === 'function') {
      window.joinRoom();
    } else {
      alert('joinRoom関数が読み込まれていません');
    }
  });
