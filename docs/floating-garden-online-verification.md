# 庭園オンライン試作：実装・検証記録

2026-10-02 UTC。**オンライン試作。ゲームの本番公開は無効です。**

## Draft PR / CI 検証

専用ブランチとDraft PRによるソース共有、GitHub Actions上の隔離テスト、必要な修正・再実行が承認されています。mainへのマージ、本番デプロイ、資格情報や権限の変更は対象外です。

新規 `Floating Garden Emulator Tests` workflowはNode.js 22・Java 21・Chromiumと `demo-floating-garden` のローカルemulatorを使用します。実Callable試験、実UI fixture試験に加え、差し替えなしのappとFirebase transportを2つのブラウザーcontextで接続する試験を含みます。最終結果は[PR #365](https://github.com/fabdemnt-dev/wa-awesome/pull/365)の最新commitに対応するChecksを確認してください。

### 初回GitHub Actionsで確認できたこと

[初回run](https://github.com/fabdemnt-dev/wa-awesome/actions/runs/36952219797)では全体640件、庭園Rules7件、実transaction4件、実Auth→Callable HTTP→Firestore9件、実Chromium UI fixture1件が成功しました。既存Test・Shadow Card・Deep Miningのworkflowも成功しています。

差し替えなしのappを使う2ブラウザーも135操作、両者の同一採点、匿名UID保持、応答消失後の同じrequestIdでの復帰、offline/reconnect、キーボード・幅・拡大の検査まで到達しました。初回run全体は最後の外部通信assertionで失敗しています。意図的な切断後にWebChannel SDKが試みる既知の接続診断画像（通信自体は遮断済み）を、未知の宛先と区別していなかったためです。テストの分類だけを限定修正し、診断画像も引き続き遮断します。他の未知のURLとlive backendへの通信は失敗扱いのままです。

390pxと1180pxの実際の画面画像を目視し、盤面・操作欄・最終結果の表示を確認しました。物理端末、タッチ、読み上げの検証とは別です。

## 基準revision

- GitHub main：`291c7d7d6ff37c4500b785c65da493b796ba5ad7`（PR364）
- 実装前と最終確認でmainとの比較は identical
- 作業用の独立したコピーを使用。ローカル基準commit `8625f67` は、既存checkoutの19変更ファイルをGitHubのblob SHAで照合して作った同内容のsnapshotです。GitHub上のcommitではありません
- 既存庭園の16ファイルは全て基準とbyte単位で一致。CPUのローカル保存を含め、既存画面・ルールは未変更

## 実装したこと

- 人間2人の独立したオンライン画面、部屋作成・招待コード参加・ホスト開始
- 自分の席に応じた盤面・譲渡の受諾／拒否・招き／迎える・保管・仮置き／回転・瞑想／石・最後の石・共通結果
- Firebase Callableによる認証済み席の決定、合法手・gameId・revisionの検証、Firestore transactionによる原子的な状態確定
- サーバー限定の暗号学的山札、明示的な公開snapshot、参加者だけのFirestore読込み、クライアントの状態書込み禁止
- requestIdとpayloadの固定、同じ操作の再送・結果不明・二重送信・古い画面への防御
- 匿名UIDを維持した同じブラウザーの復帰、BFCache・複数タブ競合への停止、確定後または期限切れの明示的な端末記録解除
- CPUルールをbyte単位で一致させるstage／checkスクリプトと専用CI
- オンライン画面のproduction接続は無効。ローカルの `demo-floating-garden` だけを使用

## 成功した検証

### 全体回帰

`npm test`：**640件成功、0失敗、0skip**。

- 既存574件
- 新規backend 33件：全コマンド、2/3/4席の純粋エンジン同値性、8回の2人完走、秘密情報、競合・重複・期限・招待・認可・rate limit
- 新規client 32件：5回の2人完走、全コマンド、結果不明の再送／再読込、UID不一致、古いsnapshot、offline/cache、保存拒否、実mountのイベントハンドラー（軽量DOM）
- clientと実backend handlerの接続試験1件：in-memory transaction fixtureを使用。部屋作成／操作の成功応答消失、同じIDで復帰、受贈与中と進行途中の再読込、2人の共通最終結果

### Firebase emulator

- 庭園Firestore Rules：**7件成功**。本人のみのget、非参加者・失効・無効membershipの拒否、一覧と直接書込みの拒否、server-only情報、listenerの権限失効
- 既存Firestore Rules：**12件成功**。新しい庭園Rulesを追加した状態で既存の俳句・ポエム等の認可を回帰
- 実Firestore transaction：**4件成功**。並行create/join/startの同一結果、3人目の参加競合、同じ席の操作競合、135操作の完走、リプレイ一致、得点、期限・無効化

transaction試験は実Firestoreと本番handlerを使いますが、caller contextは注入です。Authトークンの検証やCallable HTTPを通した試験ではありません。

### 静的検証

- 追加・変更JavaScriptの `node --check` 成功
- `npm run check:floating-garden:core` 成功。正本とFunctions内の2ルールファイルが完全一致
- `git diff --check` 成功
- `tests/poem-start.test.mjs` の変更は新規Functionsモジュールに対応する既存VM fixtureのstubを1行追加したもの。既存テストのassertionは変更していません

## 初期ローカル環境で未完了だった検証

1. **Auth＋Functions＋Firestoreを通る完全なCallable試験**
   - AuthとFirestoreの起動、5つのCallableの検出まで進行
   - Functions workerがUnix socketを開く箇所で `EPERM listen /tmp/fire_emu_….sock`
   - 同じローカル試験を許可された昇格経路でも1回試したが同じ制限で停止
   - `test:floating-garden:integration` は維持。部分transaction試験へ置き換えて成功扱いにはしていません
2. **実Chromium画面試験**
   - インストール済みChromiumを起動する段階で `socket() failed: Operation not permitted`
   - 同じ試験の昇格実行でも停止。画面・クリック処理には到達していません
   - 実画面用 `test:floating-garden:browser` は追加して構文確認のみ。実際のレイアウト、native dialog、キーボード、320/390/768/1180px、200%拡大、touch／読み上げは未確認
3. **物理端末2台の対戦**
   - 未実施。2つのプログラム上の参加者の試験と混同しません

制限の回避、トンネル、外部ホスト・staging公開、本番接続は行っていません。

## 公開前に残ること

- Unix socketとブラウザーを通常どおり使える許可済み環境で、完全Callable試験と実画面試験を完走
- 物理端末2台、切断・再接続、狭い画面と入力操作を確認
- 本番秘密鍵、期限後の後始末、費用・監視、正しいorigin／project／region、対象限定デプロイの順序を確認
- 公開・本番設定・権限変更は別途承認を得る。現在のmain向けworkflowはfunctions変更から本番自動デプロイへつながるため、未検証のままmainへマージしない

3〜4人、席の別端末移動、CPU代行、途中退席・再戦の合意、production gateの解除は今回含めていません。
