import './diagnostic-log.js';
// 【エントリーポイント】
// ここで各機能のファイルを読み込んで、アプリ全体を結合します

// 1. Firebaseの初期設定
import './firebase-config.js';

// 2. 状態管理（State）と汎用ツール群
import './haiku-state.js';
import './haiku-utils.js';

// 3. 各機能モジュールの読み込み
import './haiku-audio.js';  // 音声読み上げ機能
import './haiku-export.js'; // 出力機能
import './haiku-render.js'; // UI描画処理
import './haiku-room.js';   // 入室・ロビー・参加者管理
import './haiku-functions.js'; // サーバー側の配札・引き直し
import './haiku-game.js';   // 素材投稿・ゲーム進行
import './haiku-action.js'; // 手札・投稿・投票操作
import './haiku-wordsets.js'; // 保存済みワードセットの読み込み

// 参加ボタンにイベントリスナーを登録
document.getElementById("join-btn")
  ?.addEventListener("click", window.joinRoom);
