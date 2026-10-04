# 庭園専用 Cloud Shell 初期設定：段階2

対象は `wa-awesome-garden-stg` / `120030709276` だけです。
庭園のプログラムが後で使う専用アカウントと、必要なデータ操作権限を準備します。ゲームは配信せず、準備中ページと試験開始前の状態を保ちます。

## 今回作るもの

1. 鍵ファイルを作らない専用サービスアカウント
   - `garden-trial-runtime@wa-awesome-garden-stg.iam.gserviceaccount.com`
   - 表示名 `Garden trial runtime`、descriptionは空
2. 専用カスタムロール
   - `projects/wa-awesome-garden-stg/roles/gardenTrialRuntime`
   - 表示名 `Garden trial runtime`、descriptionは空、stageは `GA`
   - 権限は `datastore.databases.get`、`datastore.entities.get`、`datastore.entities.create`、`datastore.entities.update` の4つだけ
3. このアカウントにだけ、次の条件付きで上記ロールを付与
   - expression：`resource.name == "projects/wa-awesome-garden-stg/databases/(default)"`
   - condition title：`garden_trial_default_database`
   - condition descriptionは空

この条件は **東京の(default)データベース全体** が対象です。collectionごとの分離ではありません。Admin SDKによるアクセスはクライアント用Firestore Rulesを迂回します。4権限にはデータの削除、一覧取得、IAM管理、課金管理、配信権限を含めません。`datastore.databases.get` はトランザクション開始・取消に必要な権限です。

## 補助ファイルが確認すること

`scripts/bootstrap-floating-garden-runtime.mjs` を、利用者本人の認証済みCloud Shellで実行します。Node.js 20以上が必要です。

- 引数なし／`--plan`：説明だけ。クラウドへ接続しない
- `--inspect`：既存設定の読取りだけ
- `--create-approved-runtime`：上記の専用アカウント・ロール・条件付き付与を承認した後だけ使用

変更前にproject ID・番号・ACTIVE状態、必要APIが有効であること、Tokyoの(default) Native Firestoreを確認します。gcloudのprojectと課金・quota projectは明示し、認証差替え・impersonation・API endpoint上書きがあれば設定を直さず停止します。新しいログインやAPIの有効化は行いません。

既存のアカウント・ロール・条件があれば、名前、description、有効状態、4権限、条件の完全一致を確認します。削除済みロール、別の権限、他の人に付いた同じ専用ロール、ユーザー管理鍵、明示的なアカウント単位のIAM付与、公開project IAMなどの不一致があれば、上書き・削除・修復せず止まります。読み取りの失敗を「存在しない」とみなしません。

不足しているものだけを作ります。新規アカウントの作成結果を確認した後は、Google IAMへの反映のため **60秒待ちます**。待機中に追加入力は不要です。uniqueIdを固定して再確認し、途中で別アカウントへ置き換わっていれば停止します。

条件付き付与は公式gcloudの `add-iam-policy-binding` を使い、他のproject bindingとaudit設定が付与前後で維持されていることも確認します。既存のビルド用アカウントや他のゲームの権限を変更しません。広い既存権限を、この段階で推奨・再利用・撤去する判断もしません。

## Androidでの実行

案内された固定コミットとSHA-256を使います。ダウンロードとハッシュ確認が両方成功したときだけ実行します。`main`やブランチ最新版の無条件実行、`curl | bash`は使いません。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_COMMIT/scripts/bootstrap-floating-garden-runtime.mjs' -o garden-bootstrap-runtime.mjs &&
printf '%s  garden-bootstrap-runtime.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-runtime.mjs --create-approved-runtime
```

上の `REVIEWED_COMMIT` / `REVIEWED_SHA256` は説明用です。実際の案内には、公開ファイルの読戻し・独立レビュー・同headのCIを確認した固定値を入れます。

完了時には `RUNTIME_STAGE_VERIFIED` と、対象アカウント、ロール、4権限、条件が表示されます。その最後の表示を共有してください。

## STOPが表示されたら

変更は一部成功している可能性があります。変更モードをそのまま繰り返さないでください。`STOP`、`PARTIAL_STATE`と、それまでの短いstage行を残し、確認を待ってください。補助ファイルは変更要求を自動再送せず、自動の修復・削除・巻き戻しも行いません。これは補助ファイル自身の再試行制御であり、gcloud内部の通信処理まで置き換えるものではありません。

必要になった場合だけ、同じファイルのSHAを確認し、読取りモードで現在の状態を調べます。

```sh
printf '%s  garden-bootstrap-runtime.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-runtime.mjs --inspect
```

認証code、token、秘密値、debugログ、認証ファイルは共有しないでください。補助ファイルは確認への回答を送らず、HTTP・ファイルへのgcloudログを無効にします。予期しない規約・追加権限の要求には進まず、対象を確認します。

## この段階の限界

`RUNTIME_STAGE_VERIFIED` は、対象アカウント・ユーザー管理鍵なし・ロール・直接の条件付きproject bindingを読み戻した確認です。親階層、group経由、他resourceのpolicyを含む実効権限全体の監査や、実際のデータ操作試験を完了した意味ではありません。IAMの権限反映には数分かかる場合があります。

自動テストではgcloudをfixtureに置き換えています。誤project、無効／削除済みresource、不一致の権限、隠れたIAM条件、途中失敗、同時変更、別uniqueIdへの差替え、無関係なbindingの保持、秘密のない出力を検査します。実Cloud Shellでの成功を代用しません。

HMAC秘密値の生成・登録は、後の段階で利用者本人だけが行います。この補助ファイルは秘密値を生成・取得・入力・送信しません。App Check、reCAPTCHA、Functions／Rules／Hosting配信、ビルド用権限、2UIDの参加登録、7日タイマーにも触れません。

## 公式資料

- [サービスアカウント作成](https://docs.cloud.google.com/sdk/gcloud/reference/iam/service-accounts/create)
- [ユーザー管理鍵のメタデータ一覧](https://docs.cloud.google.com/sdk/gcloud/reference/iam/service-accounts/keys/list)
- [削除済みを含むカスタムロール一覧](https://docs.cloud.google.com/sdk/gcloud/reference/iam/roles/list)
- [カスタムロール作成](https://docs.cloud.google.com/sdk/gcloud/reference/iam/roles/create)
- [条件付きproject IAM付与](https://docs.cloud.google.com/sdk/gcloud/reference/projects/add-iam-policy-binding)
- [Firestoreのデータベース単位アクセス条件](https://firebase.google.com/docs/firestore/manage-databases)
- [Firestore IAM権限の意味](https://firebase.google.com/docs/firestore/security/iam)

確認日：2026-10-02。
