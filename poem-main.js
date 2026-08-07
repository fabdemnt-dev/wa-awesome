import './firebase-config.js';
import './poem-state.js';
import './poem-audio.js';
import './poem-export.js';
import './poem-render.js';
import './poem-room.js';
import './poem-game.js';
import './poem-action.js';
import './poem-wordsets.js'; // 保存済みワードセットの読み込み

// DOMが確実に読み込まれてからイベントリスナーを登録する
document.addEventListener('DOMContentLoaded', () => {
  const joinBtn = document.getElementById("join-btn");
  if (joinBtn) {
    joinBtn.addEventListener("click", function() {
      if (typeof window.joinRoom === 'function') {
        window.joinRoom();
      } else {
        alert('joinRoom関数が読み込まれていません');
      }
    });
  }
});
