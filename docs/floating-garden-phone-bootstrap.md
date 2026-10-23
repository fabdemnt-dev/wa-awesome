# 庭園専用 Cloud Shell 初期設定：段階1

対象は `wa-awesome-garden-stg` / `120030709276` のみです。
これは既存の準備中ページを保ったまま、必要APIを準備し、実際のビルド用アカウントを読み取る手順です。ゲームは配信せず、試験の7日間も開始しません。

## 承認範囲

この段階では、次の13APIのうち未有効なものだけを、安定版 `gcloud services enable` の1回の要求に含めます。

- `cloudfunctions.googleapis.com`
- `cloudbuild.googleapis.com`
- `artifactregistry.googleapis.com`
- `run.googleapis.com`
- `eventarc.googleapis.com`
- `pubsub.googleapis.com`
- `storage.googleapis.com`
- `secretmanager.googleapis.com`
- `iam.googleapis.com`
- `firebaseappcheck.googleapis.com`
- `recaptchaenterprise.googleapis.com`
- `firebaserules.googleapis.com`
- `logging.googleapis.com`

**実行には、この13個に加えてGoogleが必須として自動で有効化する依存API、および付随するGoogle管理用identity・標準service-agent権限まで承認していることが必要です。** 安定版には依存APIだけを抑止するオプションがありません。13個だけの承認を、自動依存先の承認とみなしてはいけません。Preview / beta の別手順には切り替えません。

指定するAPI名は上のリストだけです。前後の有効API一覧を読み、新しく有効になった名前をすべて表示します。追加名が自動依存先か、同時に別の人が行った変更かは、一覧だけでは断定できません。追加名をもう一度有効化する操作や、削除による巻き戻しは行いません。

Google Cloud / Firebase は既存Blazeの従量課金です。月300円の予算は通知基準であり、請求上限・自動停止ではありません。

## 補助ファイルの安全境界

`scripts/bootstrap-floating-garden-apis.mjs` は利用者本人の、すでに認証済みの Cloud Shell で実行します。

- 引数なし・`--plan`：ローカルの説明表示だけ。クラウドへ接続しない
- `--inspect`：読取りだけ。APIが無効ならアカウント名を推測しない
- `--enable-approved-apis-and-required-dependencies`：上記の明示承認後だけ使う変更モード

毎回、ACTIVEなproject ID / numberの完全一致を先に確認します。すべてのgcloud操作に対象projectと課金・quota projectを明示します。既存設定に認証の差替え・impersonation・API endpointの上書きがあれば、変更せず止まります。別projectのAPI・IAM・Auth・DBを操作しません。

変更モードは未有効APIを1回だけ要求します。そのコマンドが成功した後だけ、読み戻しの反映を10秒間隔、最大2分待ちます。変更コマンドが失敗・タイムアウトした場合、自動で再送しません。既にすべて有効なら変更しません。

続いてTokyoの `get-default-service-account` を読み、実際に返されたresourceからアカウントを検証します。番号からアカウントを作って補完したり、ビルドを開始してアカウントを作ったりしません。Cloud Buildがアカウントをまだ返さない場合は停止します。

IAMは、この実際のビルド用アカウントに直接付いたprojectのroleとcondition全文だけを表示します。親階層・group経由・個別bucket / repositoryの権限までは監査していません。追加権限は付与しません。

gcloudのログイン、インストール、認証tokenの取得・表示、秘密値の生成・取得、APIキー作成、runtime作成、IAM変更、App Check設定、Functions / Rules / Hosting配信、参加UID登録は行いません。標準入力は閉じ、確認への回答を送りません。quietによる既定回答の自動選択を使いません。予期しない利用規約・権限・ログイン要求で止まった場合は、その先へ進めず確認します。

## Androidからの実行

Cloud Shellで、案内された固定コミットのファイルをダウンロードし、SHA-256を検証します。ブランチ最新版や `main` を実行せず、`curl | bash` も使いません。Node.js 20以上が必要です。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_COMMIT/scripts/bootstrap-floating-garden-apis.mjs' -o garden-bootstrap-apis.mjs &&
printf '%s  garden-bootstrap-apis.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-apis.mjs --plan
```

`REVIEWED_COMMIT` / `REVIEWED_SHA256` は説明用です。実際の案内には、公開・読戻し・テストを確認した固定値を使います。

依存APIを含む上記範囲への承認後、同じファイルをもう一度照合して実行します。

```sh
printf '%s  garden-bootstrap-apis.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-apis.mjs --enable-approved-apis-and-required-dependencies
```

`API_STAGE_VERIFIED` は、13APIが有効で実際のdefault build accountを読めたという意味です。runtime / secret / App Check / ゲーム配信の完了ではありません。

## 止まったとき

`STOP` が出た場合、変更は一部または全部成功している可能性があります。変更モードをそのまま再実行しないでください。短いSTOP行と、出ていればAPIS_NEWLY_OBSERVED_ENABLED / ADDITIONAL_API_NAMES行を伝えてください。変更前のENABLED_APIS_BASELINEも失わないようにします。必要なら同じSHAを検証して `--inspect` だけで状態を確認します。

```sh
printf '%s  garden-bootstrap-apis.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-apis.mjs --inspect
```

結果の共有はこの補助ファイルの短い要約行だけで十分です。認証code、token、秘密値、gcloudのdebugログ、認証ファイルは共有しないでください。

## 次の段階

- 鍵ファイルのない専用runtimeと、(default) DB限定の4権限を設定
- 招待用HMACの値を、利用者本人が非表示のまま東京のSecret Managerへ登録。既存secret / versionがあれば追加・上書きせず停止
- 固定hostだけのreCAPTCHA Enterprise / App Check登録とFirestore enforcement

ビルド用アカウントへの不足権限、ゲーム配信、public invoker、2UID登録、試験日時は別の対象確認です。古いpreview向けphone helperをこの固定URLのゲーム配信に再利用しません。

## 検証と公式資料

自動テストはgcloudの応答・コマンド列を置き換えた検証であり、実際のCloud Shell / IAM / Google APIの成功を代用しません。誤project、無効project、余分な引数、API一覧の破損、変更の再送禁止、反映待ち、追加APIの報告、実際のbuild resourceとconditionの検証を対象にします。

- [stable services enable](https://docs.cloud.google.com/sdk/gcloud/reference/services/enable)
- [batchEnableの原子的操作と最大20サービス](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/batchEnable)
- [default build accountコマンド](https://docs.cloud.google.com/sdk/gcloud/reference/builds/get-default-service-account)
- [default build accountのJSON形式](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.locations/getDefaultServiceAccount)
- [gcloud設定とdisable_promptsの意味](https://docs.cloud.google.com/sdk/gcloud/reference/config/set)

確認日：2026-10-02。端末接続が切れた、タイムアウトした、成功応答を読み取れなかった場合は、APIの原子的保証だけで結果を決めつけず、必ず現況を読み直します。
