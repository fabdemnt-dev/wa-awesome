# 庭園専用 Cloud Shell 初期設定：段階3

対象は `wa-awesome-garden-stg` / `120030709276` だけです。
招待コードの改ざんを検出する秘密値を、利用者本人のCloud Shellで作成し、東京のSecret Managerへ登録します。

**この変更モードは本人操作専用です。dotやテスト環境から実行しません。秘密値をチャットへ送る手順もありません。**

## 作成するもの

- Secret：`projects/wa-awesome-garden-stg/secrets/FLOATING_GARDEN_INVITE_HMAC_KEY`
- 保管方式：global secret resourceのuser-managed replication、`asia-northeast1`の1か所だけ
- 初版：version `1` が `ENABLED`
- 値：本人Cloud ShellのOpenSSLで生成する256bitのランダム値を、64文字の小文字16進表記で保存。改行は含めない
- 直接のアクセス付与：`garden-trial-runtime@wa-awesome-garden-stg.iam.gserviceaccount.com` に、このsecretだけの `roles/secretmanager.secretAccessor`

この段階で新しく付ける直接の権限は上記runtimeだけです。継承された管理者権限、group経由、impersonationなどを含む全経路の排他性を保証するものではありません。後に5つのFunctionsでruntimeを共用する場合、IAM上はその5関数から到達可能です。環境へbindする予定がcreate/joinだけでも、関数単位の完全分離にはなりません。

Secret Managerの保管・利用は既存Google Cloud請求先の従量課金です。月300円は通知基準で、請求上限や自動停止ではありません。この段階ではゲーム通信や7日間の試験を開始しません。

## 実行前と秘密値の扱い

`scripts/bootstrap-floating-garden-hmac.mjs` はNode.js 20以上と、本人の認証済みgcloud、`/usr/bin/openssl`を使います。追加インストール、新しいログイン、API有効化は行いません。

- 引数なし／`--plan`：説明だけ。クラウドにも生成器にも接続しない
- `--inspect`：メタデータの読取りだけ。秘密値の生成・取得はしない
- `--user-create-new-hmac`：了承済みの本人Cloud Shell操作だけに使用

変更前に、正確なproject ID・番号・ACTIVE状態、必要API、既に準備したruntimeのuniqueId・鍵なし・ロール・DB条件を再確認します。認証、通信先、proxy、TLS、デバッグなどの不審な上書きは、勝手に解除せず停止します。gcloudのprojectと課金・quota projectは固定します。

対象secretがないことを成功した一覧読取りで確認し、生成直前にも再確認します。**secretが既にあれば、版が0個でも変更モードを停止します。** 読取り失敗を「存在しない」とみなしません。作成コマンド自身も既存secretでエラーになる方式を使います。

生成値は本人プロセスの一時メモリにだけ置き、生成器の成功と64文字の形式を確認した後、gcloudの標準入力へ渡します。値をファイル、引数、環境変数、画面、チャットへ出しません。生成器のstderrと、登録処理のstdout/stderrは表示しません。gcloudのHTTP・ファイルログも無効にします。

保持したBufferは終了時・失敗時に上書き消去します。ただし、Node、gcloud、OS内部にできるすべてのコピーの安全な消去まで保証するものではありません。

## 本人による実行

レビュー済みの固定コミットとSHA-256を使ってください。ダウンロードと照合の両方が成功した場合だけ、本人操作の変更モードへ進みます。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_COMMIT/scripts/bootstrap-floating-garden-hmac.mjs' -o garden-bootstrap-hmac.mjs &&
printf '%s  garden-bootstrap-hmac.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-hmac.mjs --user-create-new-hmac
```

`REVIEWED_COMMIT` / `REVIEWED_SHA256` は説明用です。実際の案内では、公開ファイルの読戻し、独立レビュー、同headのCIを確認した固定値を使います。ブランチ最新版の無条件実行や `curl | bash` は行いません。

成功すると `HMAC_STAGE_VERIFIED` と、secret名・Tokyo・version `1 / ENABLED`・直接のruntime accessorが表示されます。共有するのはその最後の表示だけです。秘密値そのものは表示されません。

## 途中で止まったとき

**この操作は一括トランザクションではありません。** 公式gcloudのcreateコマンドは、secret作成と初版登録を別APIで実施します。失敗時には、空のsecretだけ、またはsecretと初版までが残る可能性があります。

`STOP` / `PARTIAL_STATE` が出たら、その短い行を伝えて確認を待ってください。変更モードを繰り返さず、削除、再生成、新版追加、アクセス付与のやり直しを手作業で行わないでください。このhelperには自動の修復・巻き戻し・変更再送はありません。gcloud内部の通信再試行までは制御・保証していません。

必要な場合は、同じ固定SHAを照合した上で、読取りモードだけを使います。

```sh
printf '%s  garden-bootstrap-hmac.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-hmac.mjs --inspect
```

既存secretの検査では、版の状態と直接のIAMを読みます。値の取得は行いません。認証code、token、秘密値、デバッグログ、認証ファイルは共有しないでください。

## 検証の意味と範囲

登録コマンドが成功した後、secretとversionの名前、東京だけのreplication、初版1個のENABLED状態、createTime/etag、runtime uniqueId、secret単位の直接IAMを再読取りします。IAM付与前はsecretとversionのetagも比較します。付与後はsecretのcreateTimeと厳格な設定、versionのcreateTime/etagを比較します。IAM付与でsecret側のetagが不変であることは前提にしません。別resourceへの差替えや余分な版・権限・rotation・alias・expirationなどがあれば停止します。秘密値を再取得して比較する検査はしません。

`HMAC_STAGE_VERIFIED` はこれらのメタデータが一致したという意味です。値の読戻し、Functionsでの実使用、継承を含む実効IAMの全監査を意味しません。最初の読戻しより前の並行変更も含め、完全なトランザクション分離は保証しません。

自動テストは、生成器とgcloudを合成ダミー応答へ置き換えます。実HMAC値、実gcloud、実クラウド書込みは使いません。秘密のある経路を実環境で試してCIの代わりにすることもありません。

このhelperはApp Check、reCAPTCHA、build IAM、Functions／Rules／Hosting配信、2UID登録、試験日時を変更しません。

## 公式資料

- [secret作成と標準入力](https://docs.cloud.google.com/sdk/gcloud/reference/secrets/create)
- [secret resourceとreplication](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets)
- [version一覧](https://docs.cloud.google.com/sdk/gcloud/reference/secrets/versions/list)
- [versionメタデータ](https://docs.cloud.google.com/sdk/gcloud/reference/secrets/versions/describe)
- [secret単位のIAM付与](https://docs.cloud.google.com/sdk/gcloud/reference/secrets/add-iam-policy-binding)

確認日：2026-10-02。
