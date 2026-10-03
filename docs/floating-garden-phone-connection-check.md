# 庭園：ゲームを始めない接続確認

対象は `wa-awesome-garden-stg` / `120030709276` の既存Hosting siteだけです。rootと404は元の準備中画面のまま、`https://wa-awesome-garden-stg.web.app/connection-check/` に接続確認を追加します。この文書だけでは公開完了を意味しません。公開後のrelease・ファイル・HTTP応答の確認結果を別途報告します。

## 期間と確認内容

- 接続確認の有効期間：2026-10-03 **11:15 JST** 〜 **2026-10-04 12:00 JST**（UTC 2026-10-03 02:15 〜 2026-10-04 03:00）
- この期限はゲームの7日間とは別です。ゲームの期間・設定・参加者・部屋は作成しません
- 「接続確認を開始」を押したときだけ、reCAPTCHA Enterprise / App Checkの検証後に匿名Authを確認します
- 表示するものは成功／失敗、期限、そのブラウザー自身の匿名UIDだけです。認証token、秘密値、SDKの生エラーは表示しません
- Firestore、Functions、ゲームのSDK・処理・通信は含みません。IAM、Rules、Auth設定、API、App Check設定も変更しません

期限はこのページのclientによる接続停止です。Firebase project、公開識別子、作成済み匿名アカウントを削除したり、他のclientからの認証をサーバー側で一律禁止したりする期限ではありません。固定URLも消えません。期間終了後にこのページで再認証を始めず、SDKの自動更新を止めます。7日試験の制限をこのclient時計だけに依存させません。

既存の従量課金が適用されます。確認時にはreCAPTCHA assessment、App Check、Authの通信が発生します。月300円の通知は料金上限ではありません。

## 確認済みの設定と未確認事項

2026-10-03、既存ログインのFirebase Consoleを読取り、対象アプリのFraud Defense（旧称reCAPTCHA Enterprise）、保存済みTTL1時間、しきい値0.5、debug token登録0件、Firestore適用済み、匿名Auth有効を確認しました。設定の保存・変更はしていません。公開Web App情報は専用Hostingの正規 `/__/firebase/init.json` と照合しています。

Web Appは `1:120030709276:web:015f4e996b7c42a4e801d9`。同じFirebase app名 `floating-garden-trial-wa-awesome-garden-stg` と `browserLocalPersistence` を使い、後のゲームでも同じブラウザーのUIDを使える構成です。公開site key / Firebase Web App識別子は認証tokenやHMAC秘密値ではありません。

合成テストは実端末のattestation成功を証明しません。2台の本人端末、実reCAPTCHA評価、実認証、実配信のCSP/HTTPS動作は、公開後の本人の確認を待ちます。

## 2026-10-03：接続先CSPの限定修正

初回公開のroot・旧ゲーム404・接続ページと全アセットは、公開後の読取りで承認済みのバイトとヘッダーに一致しました。その後、本人のChromeで開始を1回押すと接続失敗になり、Firebase Consoleでは匿名ユーザーの作成成功を確認できませんでした。

固定の[公式Firebase 10.8.0 App Check SDK](https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js)が使う交換先は `https://content-firebaseappcheck.googleapis.com/v1` です。初回CSPが許可した `https://firebaseappcheck.googleapis.com` とは別のホストであり、SDKの交換要求が遮断される不具合を確認しました。ネットワークを隔離した実SDKの合成検証でも、現CSPではAuth前に失敗し、ホスト1個の置換で合成認証まで進みます。これは確実な遮断要因の検証であり、本人端末の最初の失敗箇所を端末ログで特定したという意味ではありません。

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

このhelperは専用siteの存在を要求し、サイトを新規作成しません。既存の準備中release、同じ接続確認release、または上記の固定された旧接続確認release以外は上書きしません。ゲーム・他project・rootのFirebase設定・preview channelへ切り替えません。配信はexact siteだけ、1回です。

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

CSP修正版へ移行済みの場合は、修正版を取得したファイル名と既存toolingを使います。初回公開時の旧helperへ戻りません。

```sh
printf '%s  garden-connection-check-csp-fix.mjs\n' 'REVIEWED_FIX_SHA256' | sha256sum --check &&
node garden-connection-check-csp-fix.mjs --stop-connection-check --tooling-dir "$HOME/garden-connection-tools-20261003-1a3912"
```

現行helperを最初から一般手順の `garden-connection-check.mjs` という名前で取得した場合に限り、次の対応するファイル名・toolingを使います。

```sh
printf '%s  garden-connection-check.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-connection-check.mjs --stop-connection-check --tooling-dir "$HOME/garden-connection-tools-20261003"
```

停止モードは期限後にも使えます。未知のreleaseは変更しません。Firestore gate、Authユーザー、Secret、IAM、Functionsを削除・変更しません。
