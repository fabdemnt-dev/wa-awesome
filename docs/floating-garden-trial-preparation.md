# 庭園専用プロジェクト：配信設定・安全対策の準備

2026-10-02 UTC。基準は Draft PR #365 の `65ea361ca9dc002f3d31a15a7069d3ee28fe1eb0`。この追加は**配信準備と隔離CIの範囲**です。2026-10-02に追加分のDraft PR保存・隔離CI・必要な修正が承認され、既存Draft PR #365へ追加します。新しいFirebase project、課金、Auth、IAM、秘密鍵、App Check、Hosting channelは作成・変更していません。

## 方針とファイル

既存 `wa-awesome` と `wa-awesome-mofumofu-stg` を使わず、庭園専用の新しいFirebase projectを作る前提です。project ID、請求先、試験日、preview hostnameは未確定です。`wa-awesome-garden-stg` 等は候補であり、利用可能性や所有権を確認していません。

- `functions/floating-garden-trial/`：Node22、独立package/lock、5Callableだけのentry、trial認可、専用Rules template
- `lab/floating-garden/trial/`：本番・旧stagingへfallbackしない、正確なpreview origin限定client。sourceのruntimeは無効な初期値
- `scripts/prepare-floating-garden-trial.mjs`：ローカルbuildのみ。Firebase/gcloud/git/ネットワーク/資格情報APIを呼ばない
- `config/floating-garden-trial/example.json`：未入力・無効の設定例。これをそのままbuildしようとしても拒否
- `firebase.floating-garden-trial-emulator.json`：Rules試験だけのdemo project/TCP8183用。起動時Rulesは全拒否
- 新しいtrial testsとPR用CI定義：code/config/Rulesの安全条件を検査するだけ。deploy workflowではない

PR365のengine・online画面・server handler・CPU保存・rootのFirebase/Rules/既存staging設定は編集しません。build時に必要なpublic assetsとtrusted handler/coreを列挙コピーし、正本とbyte照合します。他ゲーム、`.env`、秘密値、node_modules、server sourceはpublicへ含めません。

## 実装した安全条件

1. **二重の期限と停止スイッチ**
   - static configとadmin-only `floatingGardenTrial/config` のproject/origin/開始/終了/maxRoomsが一致し、両方enabledの場合だけ利用
   - 固定UTC windowは最長7日。欠落、不正値、期間外、別project、別originはfail closed
   - runtime projectの環境変数不一致を拒否。Firestore read Rulesも同じadmin gateと期限を検査
   - gate停止・参加取消・期限切れを各transactionで再検査。進行中のrequestも再検査し、不明な操作を成功扱いしない

2. **匿名認証とは別の2人制限**
   - 認証済みUIDだけではcreate/join/snapshot/操作を許可しない
   - server-only gateに正確に2つの異なる `testerUids` が必要。そのUIDの `floatingGardenTrialTesters/{uid}` がactiveで、trial期間内の有効期限を持つ必要もある
   - gate/tester/usageのclient read/write、一覧は拒否。公開roomはさらに有効な本人membershipだけがgetできる
   - clientは自身のUIDだけを表示する。tokenは表示・ログ保存・共有しない。UIDを登録して権限を与える処理はこの準備にはない
   - App Checkの検証を必須にし、debug tokenと失敗時fallbackを拒否。App Checkだけを本人認可とは扱わない

3. **20部屋の原子的上限**
   - `floatingGardenTrial/usage.createdRoomCount` とroom/receiptを同じtransactionで確定
   - 20件目の競合でも超過を拒否。同じrequestIdの成功再送は追加計上しない
   - usage欠落や不正値は拒否。試験中の削除・初期化・TTL設定は禁止。これは課金上限ではない
   - 部屋自身の有効期限もtrial終了を越えない。元の24時間room期限が短ければそちらを維持

4. **小規模な実行設定**
   - asia-northeast1、1vCPU・256MiB、minInstances0/maxInstances1、concurrency1、timeout30秒を各関数に設定
   - 5関数なので全体で1台という意味ではない。コールドスタート、待機・429、Firestore再試行の可能性がある
   - runtime service accountは `garden-trial-runtime@PROJECT_ID.iam.gserviceaccount.com` を明示。既存ゲームやdefault Editorの権限を流用しない
   - HMAC secret `FLOATING_GARDEN_INVITE_HMAC_KEY` をcreate/joinだけへbind。demo鍵は外部環境に流用しない

5. **clientの期限・復帰**
   - dedicated projectに属する正確なHTTPS preview origin1つだけ。queryによる上書き、未知host、localhost、production、旧stagingを拒否
   - 元のcontroller/mountで操作・同ID再送を維持。trialの復帰記録はproject別namespace
   - App Check attestation後に匿名Authを開始。永続Authを確認し、UID変更は拒否
   - 期限終了時はlistenerとtoken refreshを止め、UIを停止。以前commitしたかもしれないrequestを消さない

## ローカル準備コマンド

依存関係は既存lockfileと独立trial lockfileを使用します。

```sh
npm ci --ignore-scripts
npm ci --prefix functions --ignore-scripts
npm ci --prefix functions/floating-garden-trial --ignore-scripts
npm test
npm run test:floating-garden:trial:rules
npm run test:floating-garden:trial:entry
npm run check:floating-garden:core
```

配信先がまだ未割当の段階では、script/SDK/APIを含まない停止画面のbuildだけを準備できます。

```sh
node scripts/prepare-floating-garden-trial.mjs --closed-preview NEW_CONFIRMED_PROJECT_ID NEW_OUTPUT_DIRECTORY
```

実hostname・Web App・App Check・期間が確認できた後に、設定例のコピーを埋めてbuildします。既存の出力フォルダは上書きしません。

```sh
node scripts/prepare-floating-garden-trial.mjs --config CONFIRMED_CONFIG.json NEW_OUTPUT_DIRECTORY
```

出力にはdedicated Functions package、publicだけのtree、専用Rules、`firebase.trial.json`、source hashes、`REVIEW-PLAN.json`、停止状態のadmin記録案が含まれます。CLI実行はありません。レビュー用commandに常に明示projectと専用configを含め、Hostingはpreviewだけ、`--no-authorized-domains` を必須にします。preview commandの期限引数は、そのまま実行できない再計算placeholderです。承認後の実行直前に純粋helper `previewExpiryMinutes` へ現在時刻を渡して残り分数を切り捨て計算し、CLI対応の `m` 単位で指定します。保存時の数値を後日そのまま再利用しません。Firebaseの期限は配信時からの相対値なので、返されたexpireTimeも確認します。固定backend/client期限はHostingの遅延や延長に依存しません。

`ADMIN-RECORDS-REVIEW.json` はimporterではありません。enabled:false、testerUids:[]、tester.active:falseなので、そのままでは誰も遊べません。

## 実行前チェックリストと必要な承認

### A. 承認済みのコード保存・隔離検証

- 追加分は既存の専用branch/Draft PR #365へ保存し、trial用CIと既存回帰を実行する。必要なCI修正と再実行まで承認済み
- 元の4CI成功はPR365基準headについての結果。新しいtrial用workflowと既存回帰を最終headで確認し、結果とfixture境界を検証記録へ残す
- mainへのmergeは禁止。rootの既存workflowはFunctions変更からproduction全Functions/Rulesをdeployする

### B. 新project・試験規模・課金の具体的な確認

実在・空き・権限を読み取り確認してから、次をまとめて提示します。

- 新projectの正確なID/名称/所有先。既存請求先の識別情報とBlaze紐付けの対象
- 新しいdefault Firestoreの東京 `asia-northeast1`。locationは後から気軽に変更できないため開始前に確認
- 7日の開始/終了、2人、最大20部屋、正常利用の目安0〜200円・余裕300円。**300円は厳密上限ではない**
- 新projectだけの必要APIs、Web App、Auth匿名provider、専用Hosting previewの対象。SMS/Analytics、別ゲーム資源は追加しない
- 予算通知や対応サービスのspend capを設定するなら正確な金額/通知先/対象を別途確認。既存予算が設定済みとは主張しない

### C. セキュリティ・資格情報の実行時確認

- 新HMAC secret、専用runtime service account、必要なFirestore操作権限と当該secretだけのaccess権限。新規鍵・IAM付与は具体的な対象でその場の承認が必要
- project所有者/Editorの継承や、本番サービスアカウントの流用を求めない。必要最小権限を検証し、不足なら停止して示す
- App Check provider/keyの正確なpreview domain、新projectのenforcement設定。保護を弱めて通さない
- `ReCaptchaEnterpriseProvider` はSDK名であり、年間最低利用契約プランを選ぶ指示ではない。既存組織の無料枠・現在の料金tierを確認
- credential値の入力・送信は安全なhandoff。chatにsecret/token/passwordを求めず、手順書やartifactにも含めない
- preview deployの既定のAuth domain自動同期を禁止。domain追加が実際に必要ならその対象を確認
- 正確な2UIDの期間限定参加登録はアクセス付与。対象者と範囲を確認してから行う。この準備に自動登録機能はない

### D. 対象限定の配信確認

新projectと設定が検証できた後に、5関数、専用Rules全文、正確なpreview channel/期限、試験データ、rollback/停止方法を一括提示して配信の承認を得ます。CallableのHTTP endpointはネットワークから到達可能で、利用はAuth/App Check/2UIDで制限します。必要なCloud Run invoker公開設定も、対象5endpointの具体的なIAM変更として確認します。root all-Functions deploy、live Hosting deploy、`--force`、main mergeは使用しません。Firebase CLIが予期せぬAPI有効化、IAM追加、削除、資格情報/権限promptを出した場合は停止します。実行元の既存Console/CLI等の認証ルートも確認し、新しいdeploy token、CI secret、Workload Identityの権限付与が必要なら別途具体的に確認します。本番用CI資格情報は流用しません。

最初は停止画面のpreviewだけを配信して返された正確なhostnameを確定し、その後App Check/CORS/clientを同じoriginで検証します。backend/Rulesが稼働してもgateは停止状態を保ち、2UIDとusageを確認してから参加を有効化します。

## 7日後の停止と後始末

- コード上の期限は再配信なしで全ゲーム利用を拒否し、clientも停止する。previewの失効だけに頼らない
- 管理者がgateをdisabledにし、両testerを無効にして、実際の拒否を確認。終了時刻と停止状態を記録する
- 呼び出し拒否でも不正リクエストの処理・保存物・ログ等の費用はゼロ保証でない。承認した停止/削除対象を実行して残存資源も確認する
- room/member/serverGame、receipt、invite、rate、tester、gate、usageの棚卸しと保存要否を確認。subcollectionは親doc削除だけで消えるとは扱わない
- usage/gateを利用中に削除・resetしない。利用停止を先に確認する
- Functions、Hosting preview/release、build source bucket、Artifact Registry images、secret versions、ログ、Auth users、App Check keyも別資源として確認。Functions削除だけで全保存物は消えない
- 永続削除やcredential/IAM変更には具体的な対象の実行時確認が必要。この準備は破壊的cleanup script、TTL、scheduler、project削除を自動実行しない
- preview URLは秘密の場所ではない。期限、停止、テスター認可は別の条件

## 未検証

実App Check成功系、HostingのCORS/TLS、実Android2台、touch/background/別ネットワーク、cloudのIAM・課金・APIs・provider設定・価格tierは未検証です。Auth/Functions HTTP・trial画面は隔離emulator CIで検証し、代替部分と最終headの結果を検証記録・PRに明示します。既知のローカルFunctions/Chromium IPC制限を回避して試験することはしていません。今回通したローカルunit/Rules/aggregateの実測件数は別の検証記録に記載します。
