# 庭園：ゲームを始めない接続確認

## 2026-10-04：本人の接続確認成功

キー訂正版の本人配信後、root・404・旧ゲームpath・接続ページと全アセットの10pathを独立したHTTP読取りで照合し、承認済みバイトと安全ヘッダーの一致を確認しました。その後 **2026-10-04 03:25:55 JST**、本人のAndroid Chromeで「接続確認が完了しました」、匿名UID表示、停止段階なしを確認しました。Enterprise App Check→匿名Authの順で成功した1ブラウザーの結果です。UIDそのものはこの公開文書へ記録しません。

同じChromeの認証保存を維持します。別ブラウザー/端末の成功、参加登録、Firestore/Callable、ゲーム成功とは別です。ゲームの7日間は未開始で、接続確認ページの期限 **2026-10-04 12:00 JST** も変更していません。期限は既存UIDやブラウザーのAuth保存を消すものではありません。

ゲームの必須条件は正確な異なる2UIDです。本人が別の通常ブラウザーで2席の制御試験を行うこともできます。別タブは別UIDとは限らず、成功済みChromeのデータ消去や試行済み印のリセットは行いません。同一端末のブラウザー切替試験を、2台同時前景の検証として記録しません。

以下は準備・診断・公開の経緯です。「未確認」と記載した箇所は、その時点の検証範囲を表します。

## 当初の準備と公開範囲

対象は `wa-awesome-garden-stg` / `120030709276` の既存Hosting siteだけです。rootと404は元の準備中画面のまま、`https://wa-awesome-garden-stg.web.app/connection-check/` に接続確認を追加します。この文書だけでは公開完了を意味しません。公開後のrelease・ファイル・HTTP応答の確認結果を別途報告します。

## 期間と確認内容

- 接続確認の有効期間：2026-10-03 **11:15 JST** 〜 **2026-10-04 12:00 JST**（UTC 2026-10-03 02:15 〜 2026-10-04 03:00）
- この期限はゲームの7日間とは別です。ゲームの期間・設定・参加者・部屋は作成しません
- 「接続確認を開始」を押したときだけ、reCAPTCHA Enterprise / App Checkの検証後に匿名Authを確認します
- 表示するものは成功／失敗、期限、そのブラウザー自身の匿名UID、および失敗時の固定された段階名・許可済みコードです。認証token、秘密値、SDKの生エラーは表示しません
- Firestore、Functions、ゲームのSDK・処理・通信は含みません。IAM、Rules、Auth設定、API、App Check設定も変更しません

期限はこのページのclientによる接続停止です。Firebase project、公開識別子、作成済み匿名アカウントを削除したり、他のclientからの認証をサーバー側で一律禁止したりする期限ではありません。固定URLも消えません。期間終了後にこのページで再認証を始めず、SDKの自動更新を止めます。7日試験の制限をこのclient時計だけに依存させません。

既存の従量課金が適用されます。確認時にはreCAPTCHA assessment、App Check、Authの通信が発生します。月300円の通知は料金上限ではありません。

## 確認済みの設定と未確認事項

2026-10-03、既存ログインのFirebase Consoleを読取り、対象アプリのFraud Defense（旧称reCAPTCHA Enterprise）、保存済みTTL1時間、しきい値0.5、debug token登録0件、Firestore適用済み、匿名Auth有効を確認しました。設定の保存・変更はしていません。公開Web App情報は専用Hostingの正規 `/__/firebase/init.json` と照合しています。

Web Appは `1:120030709276:web:015f4e996b7c42a4e801d9`。同じFirebase app名 `floating-garden-trial-wa-awesome-garden-stg` と `browserLocalPersistence` を使い、後のゲームでも同じブラウザーのUIDを使える構成です。公開site key / Firebase Web App識別子は認証tokenやHMAC秘密値ではありません。

合成テストは実端末のattestation成功を証明しません。2台の本人端末、実reCAPTCHA評価、実認証、実配信のCSP/HTTPS動作は、公開後の本人の確認を待ちます。

## 2026-10-03：接続先CSPの限定修正

初回公開のroot・旧ゲーム404・接続ページと全アセットは、公開後の読取りで承認済みのバイトとヘッダーに一致しました。その後、本人のChromeで開始を1回押すと接続失敗になり、Firebase Consoleでは匿名ユーザーの作成成功を確認できませんでした。

固定の[公式Firebase 10.8.0 App Check SDK](https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js)が使う交換先は `https://content-firebaseappcheck.googleapis.com/v1` です。初回CSPが許可した `https://firebaseappcheck.googleapis.com` とは別のホストであり、SDKの交換要求が遮断される不具合を確認しました。ネットワークを隔離した実SDKの合成検証でも、初回CSPではAuth前に失敗し、ホスト1個の置換で合成認証まで進みます。これは確実な遮断要因の検証であり、本人端末の最初の失敗箇所を端末ログで特定したという意味ではありません。

承認された修正は `/connection-check/**` の `connect-src` 内で上記ホストを**追加ではなく置換**することだけです。公開する7ファイル、他のヘッダー、期限、しきい値0.5、TTL1時間、domain検証、Firestore適用、ゲームの期間は変えません。API有効化で使うサービス名 `firebaseappcheck.googleapis.com` は正しいため、その設定は変更しません。

修正版helperは、固定の旧release `garden-connection-static-v1:d73fa35889621062065889b52242b37b052a81c375f78c208f80c5e4ddff3e2d` も識別します。旧releaseからの移行前には、旧ファイルの全バイトと旧CSPを含む安全ヘッダーを厳密に照合します。未知のrelease、ファイルやヘッダーの不一致、途中のversion変更は停止します。同じ修正版が既に公開済みなら再公開しません。

初回の依存準備が成功した本人は、CLIを再インストールしません。レビュー・全CI・固定commitの読戻し確認後に案内された新helperを別名で保存し、同じ既存toolingディレクトリで読取り確認します。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_FIX_COMMIT/scripts/deploy-floating-garden-connection-check.mjs' -o garden-connection-check-csp-fix.mjs &&
printf '%s  garden-connection-check-csp-fix.mjs\n' 'REVIEWED_FIX_SHA256' | sha256sum --check &&
node garden-connection-check-csp-fix.mjs --inspect --tooling-dir "$HOME/garden-connection-tools-20261003-1a3912"
```

成功確認後、案内された同じ新helperとSHAで `--deploy-connection-check` を1回実行します。結果不明なら再送せず、その新helperの `--inspect` で確認します。旧helperは修正版releaseを識別しないため、以後の読取り・停止にも修正版を使います。

公開後の照合が成功してから、本人が**同じChrome**でページを再読込みし、開始を1回だけ押します。試行済み状態で認証を復元できない場合は停止します。試行済み印やブラウザーデータを消したり、別ブラウザーで試したりしません。修正・合成テスト・再公開だけでは実機App Check成功とは扱いません。

## 2026-10-03：安全な失敗段階表示

CSP修正版の本人公開後、root・旧ゲーム404・全接続アセットのバイトと安全ヘッダーは独立した読取りで一致しました。それでも本人の同じChromeで接続確認が失敗しました。本人の許可を得た04:49 UTCのFirebaseユーザー一覧読取りでは「まだユーザーがいません」と表示されました。これだけではSDK読込み、App Check、匿名認証のどこで失敗したかを特定できません。

本人承認の診断版は、失敗した**段階名**と、固定allowlistに一致する**短いコード**だけを1行で表示します。任意の例外文、HTTP応答本文、stack、cause、customData、認証tokenは表示・記録・送信しません。コードを安全に確認できない場合は `connection/unknown` と表示します。診断のための追加通信、ログ送信、保存領域は作りません。失敗後の表示は後着の応答や別の失敗で上書きしません。

段階にはSDK読込み、App Check初期化・要求、Auth初期化・復元、同時実行の確認、試行済み印の確認、匿名ログイン、最終検証があります。表示は失敗の位置を絞るためのものです。例えば公式SDKの `appCheck/throttled` は複数のサーバー拒否を同じコードにまとめるため、コードだけで評価点不足・設定不一致・回数制限などの根本原因を断定しません。`anonymous-signup` 中にはSDK内のユーザー照合も含まれます。

App Check→匿名Authの順序、1回制限、4つの既存15秒待機枠、試行済み印、同じブラウザーの認証保存、有効期限 **2026-10-04 12:00 JST** は維持します。CSP・他の安全ヘッダー・App Check設定・Firestore適用・ゲーム期間は変更しません。UID未確認でも試行済み印を消しません。

この版のhelperは、現行CSP修正版release `garden-connection-static-v1:2303007a968a8e063f49275d120631a5fa08f91cf1a28ae771dda6ad8055123d` の固定された旧公開バイトと全安全ヘッダーを照合してから置き換えます。新しいファイルを古いreleaseの正解とみなすことはありません。未知のreleaseや不一致、途中のversion変更は停止します。同じ診断版の公開済み状態は再公開しません。

全テスト・独立レビュー・固定headのCIが通った後、案内された値を使います。まず読取りだけを行い、結果を確認します。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_DIAGNOSTIC_COMMIT/scripts/deploy-floating-garden-connection-check.mjs' -o garden-connection-check-diagnostic.mjs &&
printf '%s  garden-connection-check-diagnostic.mjs\n' 'REVIEWED_DIAGNOSTIC_SHA256' | sha256sum --check &&
node garden-connection-check-diagnostic.mjs --inspect --tooling-dir "$HOME/garden-connection-tools-20261003-1a3912"
```

Cloud Shellの再作成でtoolingフォルダがなくなった場合は、同じinspectを繰り返しません。フォルダ不在を確認した後だけ、同じSHAのhelperで公式依存を再準備し、inspectします。既存フォルダを削除・上書きしません。

読取り成功の確認後だけ、同じ固定helperで1回公開します。

```sh
printf '%s  garden-connection-check-diagnostic.mjs\n' 'REVIEWED_DIAGNOSTIC_SHA256' | sha256sum --check &&
node garden-connection-check-diagnostic.mjs --deploy-connection-check --tooling-dir "$HOME/garden-connection-tools-20261003-1a3912"
```

公開後の照合成功を待ち、案内があってから本人の**同じChrome**で再読込みします。開始ボタンが有効なら1回だけ押し、結果と短い診断行の画像を伝えます。試行済みで止まった場合やボタンが無効な場合は、そのまま停止します。ブラウザーデータや試行済み印を消さず、別ブラウザーへ変えず、代理で実認証を試しません。以前の失敗のコードを後から復元する機能ではありません。

診断版へ移行後のinspect・停止にも、診断版helperを使います。CSPだけの旧helperには戻りません。

## 2026-10-04：公開サイトキーの転記訂正

診断版の本人確認は `app-check-request / appCheck/recaptcha-error` で停止しました。庭園の既存reCAPTCHAキー一覧をJSONで読み取り、公開設定と文字列比較した結果、双方40文字で、**20文字目だけ**が数字の `1`（文字コード49）と小文字の `l`（文字コード108）で異なることを確認しました。画像の目視やOCRによる判定ではありません。

- 誤った公開値：`6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw`
- 実在する既存キー：`6Lc_LNwtAAAAADRAHvql0FwxirR3c5jZlxS9QpYw`

本人承認の訂正は、対象Web AppのApp Check登録と接続ページを、この既存キーに合わせる1文字だけです。21文字目は数字の `0` のままです。キーの新規作成、domain検証、しきい値0.5、TTL1時間、Firestore適用、CSP、試行済み印、有効期限、ゲーム期間は変更しません。キー一覧ではSCORE、庭園ドメインのみ、allowAllDomains/allowAmpTrafficはfalse、testingOptionsなしを確認しています。

2026-10-04 01:59 JST、Firebase ConsoleでApp Checkの訂正を保存し、ページ再読込み後の値をDOMで読み戻しました。40文字の完全一致と、20文字目108・21文字目48、TTL1時間・しきい値0.5を確認しました。接続ページの公開と実機成功は、この設定保存とは別に確認します。

訂正版helperは、現在公開されている診断版 `garden-connection-static-v1:9bcca9cdf43f3b17e3afbf64f84ea0dcb9737d882688ce92c364cb035aea3ca9` の**誤記を含む旧バイトそのもの**と安全ヘッダーを固定して照合します。正しいキーに書き換えた候補を旧公開の正解には使いません。移行元はこの診断版または元の準備中だけです。それ以前のCSP修正版・初回版はinspectと停止だけを許可し、直接移行しません。

全検証・独立レビュー・固定headのCI成功後、案内された訂正版helperを別名で取得し、同じ既存toolingでまず読取り確認します。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_KEY_FIX_COMMIT/scripts/deploy-floating-garden-connection-check.mjs' -o garden-connection-check-key-fix.mjs &&
printf '%s  garden-connection-check-key-fix.mjs\n' 'REVIEWED_KEY_FIX_SHA256' | sha256sum --check &&
node garden-connection-check-key-fix.mjs --inspect --tooling-dir "$HOME/garden-connection-tools-20261003-1a3912"
```

旧診断版の読取り照合が成功し、案内された後だけ、同じSHAで `--deploy-connection-check` を1回実行します。不確実な結果では再送せず、同じ訂正版のinspectを使います。移行後のinspect・`--stop-connection-check`にもこの訂正版を使います。

設定訂正・合成検証・公開照合だけでは実機の成功を意味しません。公開確認後、本人の同じChromeで再読込みし、開始が有効なら1回だけ確認します。試行済み状態なら停止し、印やブラウザーデータを消しません。診断版は今回の失敗時点で匿名Authより前に停止していますが、以前の端末状態まで推測してリセットしません。

## 公開担当者の手順

補助ファイルは既存認証のあるCloud Shell用です。新しいログイン・OAuth・鍵・tokenを作成しません。必要API・権限が不足、認証の差替え、未知の既存release、予期しない設定があれば止めます。

引数なし／`--plan`はオフライン説明だけです。`--prepare-local-deps`だけが、固定SHAの公式npm manifest/lockfileからFirebase CLI14.27.0を `npm ci --ignore-scripts` で新しい作業フォルダへ用意します。`--inspect`はその準備済みCLIを使った読取りだけです。

レビュー、固定headのCI、公開helperの読戻しを確認した値で実行します。以下の置換欄をそのまま実行しません。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_COMMIT/scripts/deploy-floating-garden-connection-check.mjs' -o garden-connection-check.mjs &&
printf '%s  garden-connection-check.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-connection-check.mjs --plan
```

未使用の作業フォルダ名を1つ選び、以後は同じ値を使います。既存フォルダは上書きしません。

```sh
node garden-connection-check.mjs --prepare-local-deps --tooling-dir "$HOME/garden-connection-tools-20261003"
node garden-connection-check.mjs --inspect --tooling-dir "$HOME/garden-connection-tools-20261003"
```

依存準備と読取りの成功を確認した後だけ、承認済みのHosting限定公開へ進みます。

```sh
printf '%s  garden-connection-check.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-connection-check.mjs --deploy-connection-check --tooling-dir "$HOME/garden-connection-tools-20261003"
```

このhelperは専用siteの存在を要求し、サイトを新規作成しません。各旧releaseはその版自身の固定バイトとヘッダーで検証します。キー訂正版への移行は誤記を含む診断版（`9bcca9cd…`）または準備中からに限定します。同じキー訂正版なら再公開しません。それ以前のCSP修正版・初回版はinspectと停止だけが可能です。ゲーム・他project・rootのFirebase設定・preview channelへ切り替えません。配信はexact siteだけ、1回です。

配信前に既存releaseを再読取りし、途中の変更を検出します。ただしHosting deployにatomicなcompare-and-swapはなく、並行公開との完全な排他性は保証しません。同時に別端末から公開しないでください。配信後は返されたversionとlive release、および公開ファイル・HTTP応答を照合します。

`STOP`や部分状態の警告が出たら、短い表示だけを伝えて確認を待ちます。配信は実際には完了している可能性があるので、変更モードを再送しません。同じSHAの`--inspect`で状態を確認します。CLI内部の通信再試行までは制御していません。期限を延長したり、新しい確認期間を自動で作ったりしません。

## 2台のスマホでの確認

1. 公開確認の案内後、使うスマホの通常ブラウザーで接続確認URLを開きます。プライベートモードを使わず、後のゲームでも同じスマホ・ブラウザーを使います
2. 有効期限と「ゲームは開始しません」の表示を確認します。ページを開くだけではFirebase SDKを読み込みません
3. 「接続確認を開始」を1回押します
4. 成功したら、そのブラウザーのUIDだけを登録担当者へ伝えます。画面に出ない認証情報を調べたり送ったりしません
5. 同じブラウザーを再読込みして確認すると、保存済み匿名認証がある場合は同じUIDを使います

確認成功は参加登録ではありません。2UIDと本人の対応を確認し、開始／終了・backend配信を別途承認してから登録します。

不確実な匿名ログインを繰り返して別UIDを作らないため、最初の匿名ログイン前に、このブラウザーのlocalStorageへ非秘密の「試行済み」印だけを記録します。結果不明の後にUIDを復元できなければ停止します。印を消したり、ブラウザーデータを消したり、別ブラウザーでやり直したりせず、表示結果を伝えてください。Web Locksが使えないブラウザーも停止します。認証tokenを独自のファイルやUIへ保存・表示しません。認証とApp CheckにはFirebase SDK標準のブラウザー保存領域を使います。

## 停止

有効期限にこのclientは停止します。接続確認の公開自体を取り下げる場合は、対象を確認して承認された担当者が、同じ固定helperの次のモードを使います。既存の準備中HTML・HTTPヘッダーに戻すHostingのみの操作です。

キー訂正版へ移行済みの場合は、訂正版を取得したファイル名と既存toolingを使います。旧診断版helperは新releaseを識別できないため使いません。

```sh
printf '%s  garden-connection-check-key-fix.mjs\n' 'REVIEWED_KEY_FIX_SHA256' | sha256sum --check &&
node garden-connection-check-key-fix.mjs --stop-connection-check --tooling-dir "$HOME/garden-connection-tools-20261003-1a3912"
```

以下はキー訂正前の診断版がまだ公開されている場合だけの旧手順です。

```sh
printf '%s  garden-connection-check-diagnostic.mjs\n' 'REVIEWED_DIAGNOSTIC_SHA256' | sha256sum --check &&
node garden-connection-check-diagnostic.mjs --stop-connection-check --tooling-dir "$HOME/garden-connection-tools-20261003-1a3912"
```

現行helperを最初から一般手順の `garden-connection-check.mjs` という名前で取得した場合に限り、次の対応するファイル名・toolingを使います。

```sh
printf '%s  garden-connection-check.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-connection-check.mjs --stop-connection-check --tooling-dir "$HOME/garden-connection-tools-20261003"
```

停止モードは期限後にも使えます。未知のreleaseは変更しません。Firestore gate、Authユーザー、Secret、IAM、Functionsを削除・変更しません。
