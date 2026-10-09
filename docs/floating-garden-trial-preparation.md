# 庭園専用プロジェクト：配信設定・安全対策の準備

## 2026-10-04：現在の残条件

以下の古い準備記録は、その時点の検証範囲を残したものです。現在は専用projectと接続確認ページの準備が進み、本人のAndroid ChromeでApp Check→匿名Auth→UID表示が成功しました。ゲーム・Functions・専用Rulesの配信、参加登録、7日間の開始を完了した意味ではありません。[接続確認の記録](floating-garden-phone-connection-check.md)を参照してください。

PR365の `24a9304c92df83909d37d6b5ef891d72dd0ac544` は5CI成功、直近の試験で135操作・397件のSDK通知到着・観測した破棄0を確認しました。古いcache通知で操作可能表示が残る別の不具合は修正済みです。以前2回起きた相手の通知停滞は原因未確定で、CI専用の到着・破棄診断は実ゲームへ配信されません。一般利用の準備完了とは扱わず、残条件を揃えた後の監督付き限定試行を提案します。

続く `2950ce3ac648ab14a602f631d80d9ed0aa11fc85` では、CSPの隔離Chromium試験と専用trialの135操作が成功しましたが、[旧onlineのブラウザー試験](https://github.com/fabdemnt-dev/wa-awesome/actions/runs/37168296476)で更新待ちが20秒で停止しました。保存された2画面は53手と52手で、どちらも同期済み表示でした。この旧経路のapp・transport・試験・workflowは前headから不変で、新CSPも適用されません。CSPが原因とは扱わず、この経路にも同じ安全なSDK到着・破棄診断を追加して調べます。4CI成功・1失敗のまま公開可能とは判断しません。

- 必須なのは異なる正確な**2UID**です。別人であるかはコードでは検査しません。本人のChromeとFirefoxのような別ブラウザーの保存領域で2席を試すことはできますが、2台同時前景・異なる回線の試験を代替しません。Chromeの成功済み認証を消して別UIDを作りません。
- 接続確認ページは **2026-10-04 12:00 JST / 03:00 UTC** までです。ゲームの開始期限ではなく、既存UIDもその時刻に自動削除されません。別UIDの確認が間に合わなければ、期間を黙って延長せず、必要な接続確認期間を具体的に決めます。
- 先に配信bundle・ヘッダー・停止方法と既存cloud権限を確認し、その後に正確な開始S・終了Eを決めます。E−Sは最長604800000ms。client/Functions/Rules/gate/usageに同じ日時を使い、最初の実ゲームQAも7日・20部屋に含めます。試行後にusageを初期化しません。
- game clientは開始前にSDK起動を拒否します。開始後にadmin gateを停止したままUIDを表示することもできますが、その取得時間も固定期間を消費します。先に接続確認で2UIDを揃える手順を優先します。
- 既存の実行アカウントと、既知のビルド用 `120030709276-compute@developer.gserviceaccount.com`（既存Editor）を混同しません。既存権限の読取りだけで新ロールを追加せず、不足が確認された場合にprincipal/resource/permissionの差分を示します。以前のCloud Shell成功を、現在の認証やtoolingの確認として流用しません。

固定siteのgame用Hosting生成設定にはCSPを追加し、準備中/接続確認からの切替時にCSPが欠落するのを防ぎます。Firebase10.8.0の5module、reCAPTCHA、対象AppのEnterprise交換、匿名Auth/refresh、Firestore Listen、Tokyoの5Callableの必要なURLに限定します。`default-src`、`base-uri`、`form-action`、`frame-ancestors`はnoneを維持し、既存のstyle属性1種類だけをhashで許可します。previewと停止画面は変えません。生成設定の検査と隔離Chromiumの許可/拒否試験は、実reCAPTCHAの動的資源や実ゲーム成功の証明ではありません。正確な公開ヘッダー差分もゲーム公開前の確認に含めます。

実行承認は、対象5Callable、対応する5 Cloud Runサービスだけの `allUsers` → `roles/run.invoker`、専用default DBのRules全文、正確なsiteのゲーム公開、2UIDの期間限定登録、gate有効化、停止手順を具体化してまとめます。endpointの到達可能性とApp Check/Auth/2UIDによる利用認可は別です。月300円は通知基準で、拒否要求や残存資源も含めた請求上限ではありません。新しいIAM、期間延長、自動削除、main mergeを準備の返事から推測して実行しません。

gameのHosting公開より前に、対象Functions/Rulesの読戻しに加え、admin gateが `enabled:false`、参加配列が空、testerが未登録または停止状態であることを読み戻します。その停止状態を維持して公開バイト・ヘッダーを照合し、同じ具体的な承認に含めた2UIDの登録とgate有効化は別の最後の手順として実行します。停止中の公開を、参加可能になったことと混同しません。

固定Firebase CLI14.27.0は、新Callableの公開invokerを設定し、Functions配信後にArtifact Registry cleanupを確認します。未設定のcleanupとnon-interactiveの組合せでは、Functionsが配信済みでも失敗exitになり得ます。結果不明時は再送せず、5関数・対応Cloud Runサービス・build・Rules・Hostingを段階ごとに読み戻します。`--dry-run`や`--non-interactive`を、API/IAMを含む包括的な読取り専用保証と考えません。`--force`や `functions:artifacts:setpolicy --none` を無断で使わず、未知の変更要求で止めます。[公式cleanupの説明](https://firebase.google.com/docs/functions/manage-functions)

限定試行では最初の1部屋で相互反映と完走を確認し、同UIDの再読込み・背景/切断復帰を順に試します。前景・接続正常なのに30秒反映されない場合を運用上の調査開始目安とし、両席の次操作を止めます。この目安はコードの保証値やCI待機条件の変更ではありません。時刻と安全な画面表示を記録し、同じブラウザーで既存の「再接続」を1回使ってpendingの同じrequestIdを維持します。復帰不能・再発・二重適用・UID不一致ならgateと両testerを停止し、停止画面へ戻します。ブラウザーデータ消去や別部屋への逃避はしません。

## 当初の準備記録

2026-10-02 UTC。基準は Draft PR #365 の `65ea361ca9dc002f3d31a15a7069d3ee28fe1eb0`。この追加は**配信準備と隔離CIの範囲**です。2026-10-02に追加分のDraft PR保存・隔離CI・必要な修正が承認され、既存Draft PR #365へ追加します。新しいFirebase project、課金、Auth、IAM、秘密鍵、App Check、Hosting channelは作成・変更していません。

## 方針とファイル

既存 `wa-awesome` と `wa-awesome-mofumofu-stg` を使わず、庭園専用の新しいFirebase projectを作る前提です。固定配信先として `wa-awesome-garden-stg` / `https://wa-awesome-garden-stg.web.app` の組だけを選択済みです。選択はproject/siteの実在・所有権や配信完了の証明ではありません。請求先、試験日、Web App/App Checkとcloud設定は別途確認します。固定URLを維持してもゲーム利用は最長7日・20部屋・正確な2UIDのままです。

- `functions/floating-garden-trial/`：Node22、独立package/lock、5Callableだけのentry、trial認可、専用Rules template
- `lab/floating-garden/trial/`：本番・旧stagingへfallbackしない、正確な試験origin限定client。sourceのruntimeは無効な初期値
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
   - dedicated projectに属する正確なHTTPS origin1つだけ。固定配信を許すのは上記のproject/siteの組のみで、他projectのlive hostやfirebaseapp.com aliasへ一般化しない。従来の明示preview設定も維持。queryによる上書き、未知host、localhost、production、旧stagingを拒否
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

固定配信先の停止画面は次のコマンドでローカル準備できます。script/SDK/Auth/外部resourceを含まず、CSPで接続を禁止します。indexと同一内容の404で旧entry/deep linkも停止表示にし、redirect/rewrites/hooksは含みません。

```sh
node scripts/prepare-floating-garden-trial.mjs --closed-live wa-awesome-garden-stg NEW_OUTPUT_DIRECTORY
```

`--closed-live` は専用project以外を拒否し、`firebase.maintenance.json`（Hostingのみ）、`public/index.html`、`public/404.html`、`REVIEW-PLAN.json`、`FILES-SHA256.json` の5ファイルだけを生成します。同じ入力の出力はbyte単位で同一です。review commandは明示project・専用config・`--only hosting:wa-awesome-garden-stg` で対象を固定します。このscriptは実行せず、backendの停止や削除も行いません。従来の `--closed-preview NEW_CONFIRMED_PROJECT_ID NEW_OUTPUT_DIRECTORY` は期限付きgarden-7day previewを必要とする場合に残します。

実hostname・Web App・App Check・期間が確認できた後に、設定例のコピーを埋めてbuildします。既存の出力フォルダは上書きしません。

```sh
node scripts/prepare-floating-garden-trial.mjs --config CONFIRMED_CONFIG.json NEW_OUTPUT_DIRECTORY
```

出力にはdedicated Functions package、publicだけのtree、専用Rules、`firebase.trial.json`、source hashes、`REVIEW-PLAN.json`、停止状態のadmin記録案が含まれます。CLI実行はありません。レビュー用commandに常に明示projectと専用configを含め、固定URLの場合は別のHostingのみの `firebase.hosting-only.json` を使い、`--only hosting:wa-awesome-garden-stg` のreview commandだけを生成します。互換性のため設定名 `previewOrigin` は維持しますが、固定URLの場合もこの1つのoriginがclient/CORS/Rules/admin gateで一致する必要があります。従来のpreviewはgarden-7day channelだけ、`--no-authorized-domains` を必須にします。preview commandの期限引数は、そのまま実行できない再計算placeholderです。承認後の実行直前に純粋helper `previewExpiryMinutes` へ現在時刻を渡して残り分数を切り捨て計算し、CLI対応の `m` 単位で指定します。保存時の数値を後日そのまま再利用しません。Firebaseの期限は配信時からの相対値なので、返されたexpireTimeも確認します。固定backend/client期限はHostingの遅延や延長に依存しません。

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
- 新projectだけの必要APIs、Web App、Auth匿名provider、専用Hosting siteと固定URL（従来previewを使う場合はその対象）。SMS/Analytics、別ゲーム資源は追加しない
- 予算通知や対応サービスのspend capを設定するなら正確な金額/通知先/対象を別途確認。既存予算が設定済みとは主張しない

### C. セキュリティ・資格情報の実行時確認

- 新HMAC secret、専用runtime service account、必要なFirestore操作権限と当該secretだけのaccess権限。新規鍵・IAM付与は具体的な対象でその場の承認が必要
- project所有者/Editorの継承や、本番サービスアカウントの流用を求めない。必要最小権限を検証し、不足なら停止して示す
- App Check provider/keyの正確な配信domain、新projectのenforcement設定。保護を弱めて通さない
- `ReCaptchaEnterpriseProvider` はSDK名であり、年間最低利用契約プランを選ぶ指示ではない。既存組織の無料枠・現在の料金tierを確認
- credential値の入力・送信は安全なhandoff。chatにsecret/token/passwordを求めず、手順書やartifactにも含めない
- preview deployの既定のAuth domain自動同期を禁止。domain追加が実際に必要ならその対象を確認
- 正確な2UIDの期間限定参加登録はアクセス付与。対象者と範囲を確認してから行う。この準備に自動登録機能はない

### D. 対象限定の配信確認

新projectと設定が検証できた後に、5関数、専用Rules全文、正確な固定site（またはpreview channel/期限）、試験データ、rollback/停止方法を一括提示して配信の承認を得ます。CallableのHTTP endpointはネットワークから到達可能で、利用はAuth/App Check/2UIDで制限します。必要なCloud Run invoker公開設定も、対象5endpointの具体的なIAM変更として確認します。root all-Functions deploy、専用site以外のlive Hosting deploy、`--force`、main mergeは使用しません。Firebase CLIが予期せぬAPI有効化、IAM追加、削除、資格情報/権限promptを出した場合は停止します。実行元の既存Console/CLI等の認証ルートも確認し、新しいdeploy token、CI secret、Workload Identityの権限付与が必要なら別途具体的に確認します。本番用CI資格情報は流用しません。

固定URLでは最初に停止画面のHostingだけを配信し、正確なsite/URLと停止内容を検証します。従来previewを選ぶ場合は停止画面previewの返されたhostnameを確定します。その後App Check/CORS/clientを同じoriginで検証します。backend/Rulesが稼働してもgateは停止状態を保ち、2UIDとusageを確認してから参加を有効化します。

## 7日後の停止と後始末

- コード上の期限は再配信なしで全ゲーム利用を拒否し、clientも停止する。固定URL自体に有効期限はない。previewを選んだ場合もHosting失効だけに頼らない
- 固定URLを停止画面へ戻すにはレビュー済み `--closed-live` bundleを専用siteだけへ配信する。これはbackendのgate変更・削除の代わりにはならない
- 管理者がgateをdisabledにし、両testerを無効にして、実際の拒否を確認。終了時刻と停止状態を記録する
- 呼び出し拒否でも不正リクエストの処理・保存物・ログ等の費用はゼロ保証でない。承認した停止/削除対象を実行して残存資源も確認する
- room/member/serverGame、receipt、invite、rate、tester、gate、usageの棚卸しと保存要否を確認。subcollectionは親doc削除だけで消えるとは扱わない
- usage/gateを利用中に削除・resetしない。利用停止を先に確認する
- Functions、Hosting preview/release、build source bucket、Artifact Registry images、secret versions、ログ、Auth users、App Check keyも別資源として確認。Functions削除だけで全保存物は消えない
- 永続削除やcredential/IAM変更には具体的な対象の実行時確認が必要。この準備は破壊的cleanup script、TTL、scheduler、project削除を自動実行しない
- 固定URLもpreview URLも秘密の場所ではない。期限、停止、テスター認可は別の条件

## 未検証

実App Check成功系、HostingのCORS/TLS、実Android2台、touch/background/別ネットワーク、cloudのIAM・課金・APIs・provider設定・価格tierは未検証です。Auth/Functions HTTP・trial画面は隔離emulator CIで検証し、代替部分と最終headの結果を検証記録・PRに明示します。既知のローカルFunctions/Chromium IPC制限を回避して試験することはしていません。今回通したローカルunit/Rules/aggregateの実測件数は別の検証記録に記載します。

## 2026-10-04: 所有者が実行する配信・停止手順のローカル準備

以下は未実行の追加手順です。ソース保存、ローカル試験、接続確認の成功はゲーム配信・参加登録・開始の承認にはなりません。GitHubのGoogle API Key検出については、検出値が専用Firebase Web設定と一致すること、および本人提示の正しいproject URLと画像で25 APIに制限されていることを確認しました。Generative Language APIやAgent Platform/Vertex AI APIは含まれません。現時点で権限付き秘密鍵の流出や緊急失効の必要性を示す材料はありませんが、全サービスの無害性や不正利用ゼロを保証する判断ではありません。最初に示された別projectの画像は庭園の根拠に使っていません。キー値は再掲せず、警告解除・鍵失効・設定変更は行いません。今回の6ファイルのソース保存は承認済みです。実配信・アクセス設定・参加登録・試験開始は別の確認事項です。

### 確認済みの前提と残る境界

- 専用接続ページでChromeとFirefoxのApp Check・匿名Authがそれぞれ成功し、別々の2IDであることを非公開で照合済みです。ブラウザの保存情報を消しません。これは実ゲーム2席の動作確認ではありません。
- 所有者の読み取り結果で、既存API、専用runtime、HMACのversion 1と権限を確認しました。ビルド用Computeアカウントには既存の無条件Editor権限があり、この手順は追加のビルド権限を要求しません。実行前にも現在値を読み取り、不足や変更は自動修復せず停止します。
- Functions・Cloud Run・Artifact Registryは当該読み取り時点で空でした。新しい配信はこの専用プロジェクトのみに限定します。既存プロジェクトやmainへは適用しません。
- 7日の正確な開始・終了時刻はまだ選択していません。実値の入力と承認は実行前に一度まとめます。

### 追加したローカル手順

`prepare-floating-garden-trial-operation.mjs` は、正確に7日間の期間、非公開の2ID、個別承認フラグを検証し、リポジトリ外の新規0700ディレクトリにgame/stopped両bundleを作ります。非公開入力は0600の `private-review.json` だけに保存し、配信対象、GitHub、診断出力へIDをコピーしません。manifestで各ファイルのSHA-256を固定します。

`operate-floating-garden-trial.mjs` は既定と `--plan` がオフライン説明だけです。実行モードは、内容とハッシュを確認したソース、既存の所有者認証、pinned Firebase CLI 14.27.0、既存lockfileのSDKを使用します。Firebase CLIやSDKのログには非公開情報が残り得るため、debugファイルの提出を求めません。表示する失敗は固定の段階名だけです。

1. 変更前に専用project、既存API、runtime/HMAC、空のFunctions/Run、deny-all Rules、既知のHosting、未登録の4管理記録を確認します。新しいAPIや権限を自動追加して通しません。
2. 停止状態のgate、usage、2testerを一度だけ作成します。以下の5関数を指定して配信し、東京・Node.js 22・専用runtime・HMAC binding・実行上限・Run最新revision/IAM・世代を固定した配信source ZIPの全バイトを読み戻します。
   - floatingGardenCreateRoom
   - floatingGardenJoinRoom
   - floatingGardenStartMatch
   - floatingGardenGetSnapshot
   - floatingGardenSubmitAction
3. 専用Rules全文と専用Hostingの全配信バイト・HTTP status・安全ヘッダーを確認します。ここまではgateを閉じたままです。
4. 選んだ開始が30分以内なら待機し、開始時に再検証して正確な2IDのみ有効にします。配信完了が開始に間に合わない、待機・最終確認が1分以上遅れる場合は停止状態で終了し、期限をずらしたり無断で開始したりしません。より先の開始は別途明示したactivation操作が必要です。
5. 変更前の記録をファイルと親ディレクトリまで同期し、未確定・失敗・中断後は変更コマンドを再実行しません。`--inspect` で現在値を読み、必要な復旧だけ別途判断します。CLI内部の通信再試行とは別の制御です。

### 実行前に一括確認する内容

- 対象 `wa-awesome-garden-stg`、配信先 `https://wa-awesome-garden-stg.web.app`、東京の5関数と専用Rules、上記2ブラウザだけの期間限定参加登録、選択した開始・終了時刻。
- 5 callableのCloud Run `roles/run.invoker` に `allUsers` を付与すること。ネットワーク到達性を公開し、利用可否はAuth/App Check・2ID・固定期間・Rulesで判定します。
- Firebase CLIが既存Pub/Sub・Eventarc service identity生成APIを呼ぶこと、および初回作成直後の容量不足で、その対象関数だけを内部で削除・再作成し得ること。新しい個人用token、service-account key、追加runtime権限は作りません。
- Functions配信に伴うsource bucket、build、Artifact Registry保存物。自動削除ポリシーは設定せず保持します。CLIのcleanup警告が出ても、5関数すべての独立読み戻しに成功しなければ先へ進みません。警告を成功の証拠にはしません。
- 保存物を保持するため終了後も保存費用等が残り得ます。20部屋・maxInstances・7日間は厳密な課金上限ではありません。削除する場合は、対象と復元不能性を別途確認します。
- 終了または本人が求めた停止時のgate/tester無効化と停止Hosting配信。ゲーム開始後の最初の2席の操作確認は別の確認段階です。

### 停止の順序と保持するもの

`--stop` は期限後も使えます。まず既知のgate/testerのフラグだけを無効化し、読み戻します。片方のtesterやgateが欠けていても作り直さず、usageは欠落・不正値を含めそのまま保持します。無関係なHosting更新や配信不能があっても、既知のbackendアクセスの停止を先に行います。その後、既知のHosting releaseだけをscriptなしの停止画面へ戻し、旧ゲームと接続ページの各パスが停止404になることを確認します。

room、receipt、usage、Authユーザー、Functions、build source、Artifact、secret、service account、IAMは削除しません。期限だけでHostingや保存物が自動削除されるとは扱いません。途中で結果が不明になった場合は、同じ変更の再送ではなく読み取り確認で止めます。
