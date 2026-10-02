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
- 試験用接続とCLI discoveryの回帰。正確なloopback Origin・demo project・emulator marker、配信ソース不変、直接SDK接続、秘密値を含めない診断を検査する
- trial用CIはNode22/Java21で独立packageを実installし、全体回帰、entry、専用Rules/Firestore競合、生成済みtrial画面の2ブラウザー試験を実行する
- 個々のCI結果は、[Draft PR #365](https://github.com/fabdemnt-dev/wa-awesome/pull/365)の最終headとChecksを参照。前のheadの成功を流用しない

### ブラウザー試験の境界

配信用の生成済みindex.htmlをlocalhostで開き、試験外OriginではSDK読込み・Auth・emulator通信を始めず停止することを実ブラウザーで確認する。

成功系は別の試験専用HTML/entryを使い、既存のbootstrapTrialへ明示的なテスト用locationを注入する。bootstrap/config/transport/controller/画面/ルールのproduction sourceは変更しない。2つの独立したブラウザー保存領域から、本物の匿名Auth emulator、Callable HTTP、Firestore transaction/listener/RulesへSDKを直接接続する。create/join/start、譲渡・招き・採点、同UID reload、commit後の応答消失と同ID再送、offline/reconnectを検査する。

代替するのはtests/helpers内の明示した環境部分だけ。

- SDK constructorsでprojectをdemo-floating-garden-trialと固定loopback portsへ限定。通常のAuth/Firestore/Callable通信はbrowserから直接流し、全体応答をためるstreaming proxyを挟まない
- App Checkは合成。Functions fixtureも合成App Check contextを付けるが、本物のAuth middlewareと元のtrial認可は省略しない
- Functions fixtureは、生成済みmarker・CLI emulator marker・demo project・loopback hostsと、実際のbrowserから来た正確なloopback Originを確認してから、試験用のrequest Originだけを静的trial設定へ合わせる
- 試験専用entryは配信用public bundleとは分離する。生成済みproduction entry/public source/独立Functions entryのbyte一致を別途検査する

したがって、成功系でproduction app.jsがdefault-window-locationから起動する経路、実HTTPS/CORS、Enterprise attestation、IAM、Secret Manager、実Android2台は未検証。配信用entryの拒否動作・CORS設定・App Check必須化は実SDK entry試験で確認する。Callableの成功応答を意図的に捨てる試験だけは有限のHTTP応答を取得してから遮断するが、ゲーム結果・Auth・Firestore応答を合成しない。

参加取消は、受信済みの公開情報を即時消去することと、新しいサーバー認可を分けて検査する。同じ本物のAuth tokenで新しいREST document GETを送り、取消前/再登録後の200と取消中の403を要求する。既存listenerも、公開roomの既存expiry値を一時的に1ms変更した更新を受け取らずpermission-deniedになることを確認し、roomは元へ戻す。token・header・browser storage dumpはartifactへ残さない。

### 試験構成を変更した理由

初期の合成HTTPS originとPlaywright中継では、SDK接続先の不一致、取消タイミング、Firestoreのlong-pollの扱いを切り分ける必要があった。独立したsource調査で、Playwrightの中継は応答body終了まで待ち、browser取消だけでは裏側のfetchを止めないことを確認した。固定Firebase10.8が送る5秒のTO hintをemulator1.19.8は使わず、buffered idle pollの既定値は30秒で、中継のtimeoutと重なっていた。ただし、記録されたconnection-resetが特定の画面更新停滞の直接原因だったとまでは断定しない。

不確かな再試行や待ち時間延長を足す代わりに、このstreaming proxyを取り除いた。browserのsecurity flagsやpermissionは変更せず、上記の直接接続と明示した試験境界で検証する。production sourceや認可条件を緩める修正は行わない。

## まだ検証していないこと

実App Check provider、実Android2台、cloudのproject/APIs/IAM/secret/billing/予算設定、実Hosting redirect/期限の反映は未検証です。Auth/Functions HTTPと実ブラウザーについては上記の専用emulator試験で確認し、結果は最終headのCIで判定します。前のPR365の4CI成功を、この新しい準備コードのCI成功として流用していません。

既知のFunctions/Chromium IPC制限を回避する試行はしていません。Rules emulatorだけを公式CLI・demo project・loopbackで使用し、完了後に停止しています。新たなネットワーク権限やcloud資格情報は作成していません。

## 成果物と次の確認

- 実行準備/承認/停止・後始末：`docs/floating-garden-trial-preparation.md`
- 条件付き0〜200円/7日・余裕300円（hard capではない）：`docs/floating-garden-trial-costs.md`
- 無効な入力例：`config/floating-garden-trial/example.json`
- build/レビューplan：`scripts/prepare-floating-garden-trial.mjs`

Draft PR #365への追加保存と隔離CI・必要な修正は承認済み。次は新project ID/請求先/期間を読み取り確認で具体化し、実際の作成・配信を行う前に対象を明示する。具体的な鍵・権限・セキュリティ設定が判明してから必要な実行時確認を行う。現在の承認はcloud作成・課金・資格情報・IAM・deployを含まない。
