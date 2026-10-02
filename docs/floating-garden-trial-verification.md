# 専用環境準備：検証記録

2026-10-02 UTC。対象は新しい庭園専用project用の準備コードです。ローカル準備後、2026-10-02にDraft PR #365への追加保存・隔離CI・必要な修正が承認されました。cloud設定・deployは行っていません。

## 基準

- [PR365](https://github.com/fabdemnt-dev/wa-awesome/pull/365) head `65ea361ca9dc002f3d31a15a7069d3ee28fe1eb0` を読み取り再確認
- 基準treeは `eb52a9c01c7a8d98fa1550e86d791b81680c9a19`
- 作業コピーのlocal baseline commitは `63a61e5ff4509a0241785d6438229cbb14e7b274`。そのGit treeが上記remote treeと完全一致することを確認。元checkoutには触れていない
- 既存のtracked pathはpackage.jsonのテストscript追加を除き全て不変。CPU保存、オンラインprototype、shared Rules、root Firebase config、既存staging、asset symlinkを維持

## ローカル準備時の検証（公開前）

- `npm test`：**696成功、0失敗、0skip**（既存642＋新規54）
- 新規内訳：backend28、client22、bundle4
- 専用Rules/emulator：**10成功、0失敗、0skip**
  - tester/gate、期限、member/private情報、一覧・直接書込み拒否、listener失効
  - 実Admin SDK→Firestore transactionによる同ID再送と20部屋上限の競合も含む
  - callerのAuth/App Check contextは合成。実Callable HTTPや本物のattestation成功とは扱わない
- 独立package-lockは `npm ci --dry-run --offline --ignore-scripts` の整合確認成功
- 正本engineとstaged core完全一致、全新JSの構文チェック、workflow YAML parse、`git diff --check` 成功
- local Nodeは24.19.0。配信用packageとCI定義はNode22、Java21。公開前の時点ではNode22の新CIは未実行

## レビューで追加した回帰

- committed結果の応答消失後にFirebase Auth/App Check middlewareがdetail無しunauthenticatedを返しても、元requestIdとpendingを消さない
- Authの12秒wait timeout後も実sign-inのsingle-flightを保持し、遅い応答で二重匿名UIDを作らない
- trialの終了・tester取消に加え、room/member/game/receipt/inviteのexpiryをtransaction終盤でも検証
- 既存2projectの公開Web App識別子を新設定へ混入した場合はSDKロード前に拒否
- Hosting rootは本当のindex.htmlへredirectし、相対assetsが壊れるrewriteを避ける
- 配信channelとconfig originをgarden-7dayに一致させる
- preview期限はFirebase CLIが対応する分単位。保存時のdurationを後日流用できないplaceholderにして、承認後の実行直前に再計算させる
- 停止画面だけのpreviewはscriptもbackendもredirectも持たない

## 追加保存時の検証と専用CI

- bundle検証を4件から7件へ拡張。全出力allowlist、source hash、credential/runtime canaryの除外、backend importの閉包、危険な入力時の出力拒否を確認
- 実SDK entry検証9件。実際のFirebase Functions 6.6.0/Admin 12.7.0で生成済みentryを読み、5関数だけ、実行上限、service account、create/joinだけのsecret bindingを確認
- entry試験では本物のCallable middlewareへインメモリHTTP requestを渡す。App Check欠落の401、正確なCORS、無効設定/別project/期間外/Auth不足の拒否を確認。socket/http/fetchは全て試験中禁止し、ネットワーク利用0を検査
- 同一origin試験中継とCLI discoveryの回帰9件を追加。許可経路・拒否経路、reload時の実Firestore request取消だけの分類、SDK設定と実SDKのURL構築（通信なし）、marker/demo/loopbackの拒否、生成ソース不変、限定したREST読取り経路、秘密値を含めないエラー診断、offline切替前の中継取消フラグ設定順を確認
- trial用CIはNode22/Java21で独立packageを実installし、全体回帰、entry、専用Rules/Firestore競合、生成済みtrial画面の2ブラウザー試験を実行する
- 個々のCI結果は、[Draft PR #365](https://github.com/fabdemnt-dev/wa-awesome/pull/365)の最終headとChecksを参照。前のheadの成功を流用しない

### ブラウザー試験の境界

生成されたtrialのapp/bootstrap/config/firebase/controller/画面はbyteを変更せず使用する。2つの独立したブラウザー保存領域が本物の匿名Auth emulatorでUIDを取得し、Callable HTTP・trial認可・Firestore transaction/listener/Rulesを通す。ゲームのcreate/join/startから譲渡・招き・採点、同UID reload、commit後の応答消失と同ID再送、offline/reconnectを確認する。

配信前のため、次だけは`tests/helpers/`内の明示したfixtureで置き換える。

- syntheticな専用preview originへのリクエストを、実Hostingへ送らずローカルの生成済みpublic assetsで返す
- SDK constructorsでprojectを`demo-floating-garden-trial`へ限定し、同一HTTPS origin上の試験用経路から、許可したloopback emulatorだけへ本物のHTTP request/responseを中継する。browserのsecurity flagsやpermissionは変更しない
- App Checkは合成marker。Functions fixtureもこのmarkerを付けるが、本物のAuth middlewareと元のtrial認可は省略しない
- browser runnerは専用flag、Functions fixtureは生成済みfixture markerとCLI自身のemulator markerを要求する。demo project、loopback Auth/Firestore、正確なOriginも必須。生成された配信用entry/公開bundleへコピーしない

参加取消後の読取り検査は、既存のSDK watch targetが受信済みの状態を再利用する場合と、新規サーバー認可を分ける。同じ本物のAuth tokenで新しいREST document GETを送り、取消前/再登録後の200と取消中の403を確認する。既存listenerも、公開roomの既存expiry値を一時的に1ms変更した更新を受け取らず、permission-deniedになることを要求し、roomは元へ戻す。既に受信・表示された公開情報が取消と同時に消えるとは主張しない。

これは本物のEnterprise attestation、Hosting/TLS、live CORS/PNA、配信用entryとApp Checkの成功系全体、IAM、Secret Manager、実Android2台の証明ではない。配信用entryの拒否動作と設定は独立した9件で検査する。許可先以外のbrowser通信は拒否し、token・header・browser storage dumpをartifactへ残さない。

### 初回CIで修正した試験接続

初回trial CIでは全体699件・entry9件・Rules10件が成功し、browser fixtureの開始で失敗した。Firebase CLIが関数定義読み込み時に任意のshell変数を引き継がないため、CLI自身のemulator markerと生成済みfixture markerを検証する形へ修正。また、合成HTTPS originからloopbackへ直接通信するfixtureはbrowserのaddress-space制約に拒否されたため、browser権限を変更せず、明示した同一origin試験中継へ変更する。production sourceや認可条件を緩める修正は行わない。

## まだ検証していないこと

実App Check provider、実Android2台、cloudのproject/APIs/IAM/secret/billing/予算設定、実Hosting redirect/期限の反映は未検証です。Auth/Functions HTTPと実ブラウザーについては上記の専用emulator試験で確認し、結果は最終headのCIで判定します。前のPR365の4CI成功を、この新しい準備コードのCI成功として流用していません。

既知のFunctions/Chromium IPC制限を回避する試行はしていません。Rules emulatorだけを公式CLI・demo project・loopbackで使用し、完了後に停止しています。新たなネットワーク権限やcloud資格情報は作成していません。

## 成果物と次の確認

- 実行準備/承認/停止・後始末：`docs/floating-garden-trial-preparation.md`
- 条件付き0〜200円/7日・余裕300円（hard capではない）：`docs/floating-garden-trial-costs.md`
- 無効な入力例：`config/floating-garden-trial/example.json`
- build/レビューplan：`scripts/prepare-floating-garden-trial.mjs`

Draft PR #365への追加保存と隔離CI・必要な修正は承認済み。次は新project ID/請求先/期間を読み取り確認で具体化し、実際の作成・配信を行う前に対象を明示する。具体的な鍵・権限・セキュリティ設定が判明してから必要な実行時確認を行う。現在の承認はcloud作成・課金・資格情報・IAM・deployを含まない。
