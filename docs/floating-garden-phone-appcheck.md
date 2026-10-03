# 庭園専用 App Check：段階4（スマホ手順）

対象は `wa-awesome-garden-stg` / project number `120030709276`、Web App `1:120030709276:web:015f4e996b7c42a4e801d9` だけです。既存の準備中ページを維持し、ゲーム配信・2UID登録・7日間の試験開始は行いません。

この文書とhelperは準備用です。ソースの保存・合成テスト合格だけでは、実際のクラウド設定が済んだことにはなりません。既に本人が承認した範囲を本人のCloud ShellとFirebase Consoleで実行するための手順です。dotはここで実クラウド操作を行いません。

## 設定する範囲

1. reCAPTCHA EnterpriseのWeb用 `SCORE` keyを1個。表示名は `Garden trial App Check`、登録するdomainは `wa-awesome-garden-stg.web.app` の1件だけ。domain検証を有効にし、testing、AMP、WAF、IP overrideは使わない
2. 上記Web AppのApp Check providerをreCAPTCHA Enterpriseとして登録。公開site keyは1で確認した同じもの。判定しきい値は `0.5`、token TTLは `1時間 / 3600秒`
3. 庭園projectのCloud FirestoreにApp Check enforcementを有効化

reCAPTCHAのdomain指定は、そのdomainのsubdomainも許可する製品仕様です。「リストが1件」は厳密なhostname限定を意味しません。生成clientとbackendの既存のexact Origin確認も維持します。`web.app`全体、`firebaseapp.com`、localhost、wildcard、別サイトを追加しません。

Firestore enforcementはproject内のFirestore service全体が対象です。このWeb Appだけ、庭園collectionだけ、`(default)` databaseだけの限定設定ではありません。他のアプリがこの専用projectのFirestoreを利用していないことを確認し、未知のアプリ・既存利用があれば保存前に止めます。共有の`wa-awesome`やもふもふprojectでは操作しません。

5つのCallableはソース上すでに `enforceAppCheck: true` です。その設定の配信と実通信確認は後の段階です。ConsoleでFunctions全体の別スイッチや他のFirebase製品のenforcementを追加しません。

## 実行前の確認

- API/runtime/HMACの前段が確認済みであること。HMAC値・認証token・credentialは開いたりコピーしたりしない
- [庭園projectのreCAPTCHA](https://console.cloud.google.com/security/recaptcha?project=wa-awesome-garden-stg)でproject IDを確認。現在の料金tierと当月の利用状況を本人が確認する。SDKのEnterpriseという名称は有料の年間契約を選ぶ指示ではない
- 無料枠は他projectと共有され得る。料金表示・同意・upgradeが想定と異なる、または利用量が分からない場合は止める。月300円は通知基準で、請求上限や自動停止ではない
- 本人の認証済みCloud ShellとNode.js 20以上を使う。新しいログイン、token発行、IAM変更、API有効化、追加インストールを求められたら止める

## A. reCAPTCHA metadataの確認

`scripts/bootstrap-floating-garden-appcheck.mjs` の引数なし／`--plan`はオフライン説明だけです。`--inspect`はメタデータ読取りだけです。実行時のproject・quota/billing projectは固定し、現在のgcloud project設定は書き換えません。

固定コミットのファイルをダウンロードしてSHA-256を照合します。まず次の読取り段階だけを実行します。

```sh
curl --fail --silent --show-error --proto '=https' 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_COMMIT/scripts/bootstrap-floating-garden-appcheck.mjs' -o garden-bootstrap-appcheck.mjs &&
printf '%s  garden-bootstrap-appcheck.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-appcheck.mjs --inspect
```

`REVIEWED_COMMIT`と`REVIEWED_SHA256`は説明用です。実案内には独立レビュー・同headのCI・公開ファイル読戻しまで確認した固定値を使います。ブランチ最新版の無条件実行、`curl | bash`はしません。

- `RECAPTCHA_KEY_ABSENT`：成功した完全な一覧にkeyがない。次の作成段階へ進める状態
- `RECAPTCHA_METADATA_VERIFIED`：既存keyが指定のmetadataと一致。**作成は不要**。`PUBLIC_SITE_KEY`をBへ使う
- `STOP`：その短い行を伝えて確認を待つ。読取り失敗を「存在しない」と扱わない

helperはkey一覧とdescribe、別resourceであるIP override一覧も確認します。専用projectに複数key、異なる設定、未知のfield、testing設定（空のobjectでも）、IP overrideがあれば停止します。既存keyを書き換えたり、削除・再作成したりしません。

## A2. 不在時だけ、承認範囲のkey作成

metadataが不在と確認できた場合に、同じダウンロード済みファイルを再照合して本人が実行します。

```sh
printf '%s  garden-bootstrap-appcheck.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-bootstrap-appcheck.mjs --create-approved-key
```

このモードも既存keyが完全一致なら再利用し、作成しません。新規の場合は直前の一覧でも不在を再確認し、固定のSCORE/domain設定でcreateを1回だけ要求します。新keyをdescribeし、全key一覧・describe・IP override一覧を再読取りします。metadata一致後の `PUBLIC_SITE_KEY` は公開識別子で、HMAC秘密値や認証tokenではありません。公開識別子だけを同じFirebase projectの登録に使います。

reCAPTCHAはサーバ側でkey IDを割り当てるため、このhelperにはcreateのatomic lockやidempotency tokenがありません。並行操作があれば重複keyができる可能性があり、後の一覧で検出したら止まります。別端末から同時に作成しないでください。

## B. Firebase ConsoleでWeb Appを登録

1. [庭園のFirebase Console](https://console.firebase.google.com/project/wa-awesome-garden-stg/overview)を開く。project設定でID・番号とWeb App IDが上記と完全一致することを確認する。アプリを新規作成しない
2. Security → App Check → Appsで、そのWeb Appだけを選ぶ。表示が違う・別アプリが出る場合は保存せず止める
3. **保存や入力をする前に、登録済みかを確認する。** 登録済みならprovider・site key・TTL・しきい値を読取りで確認し、完全一致なら変更せず次の確認へ進む。不一致・読取不能なら止める。以下の登録・保存は、未登録と確認できた上記Web Appだけに行う
4. reCAPTCHA Enterpriseを選び、Aで検証した `PUBLIC_SITE_KEY` を登録する。reCAPTCHA v3やdebug providerへ置き換えない
5. 詳細設定でtoken TTLを1時間、risk scoreしきい値を0.5として保存する。0.5以上を受け入れる設定。0やdebugで通す対応はしない
6. 保存後に同じWeb Appを開き直し、provider・site key・TTL・しきい値を確認する。すでに同じ設定なら保存し直さない。既存設定が異なれば上書きせず止める
7. そのアプリのdebug token管理を確認する。登録済みなら値を表示・コピーせず止める。新しいdebug tokenは作らない

UIで必要項目を確認できない場合、推測した設定で進めません。Firebase REST用にaccess tokenを端末へ表示・コピーする手順はありません。helperはFirebaseのregistrationやdebug-token inventoryを自動検証しないため、Aの成功だけでBが済んだと扱いません。

## C. Cloud Firestoreのenforcement

1. 同じ庭園projectのApp Check → APIs（製品一覧）でCloud Firestoreを開く
2. 専用projectに未知の利用アプリがないことを再確認して「Enforce / 適用」を保存する。projectのFirestore全体の未検証client requestが拒否される変更
3. 画面を開き直してCloud FirestoreがEnforcedと表示されることを確認する。すでにEnforcedなら操作し直さない

反映には最大15分かかる場合があります。この段階ではゲームを公開して検査せず、適用表示を確認します。準備中ページにはFirebase SDKがなく、ページを開いてもApp Check token取得や実機attestation成功を検証できません。メトリクスが空でも、検証成功や不具合とは断定しません。

Admin SDKや管理者アクセスをclient用App Checkだけで遮断できるとは扱いません。Firestore Rules、Auth、正確な2UIDの認可、期限・回数制限は別々に維持します。

## 完了として伝える内容

- reCAPTCHA：`RECAPTCHA_METADATA_VERIFIED`の短い結果、公開site key
- Firebase：対象Web App、reCAPTCHA Enterprise、TTL1時間、しきい値0.5を保存後に確認したこと
- Firestore：同じprojectでEnforced表示を確認したこと
- debug token：登録なしを確認したこと

画面が必要なら設定箇所だけにし、本人email、請求先、認証code/token、秘密値、ブラウザの認証情報は送らないでください。

これは**設定metadataの完了**です。実機2台でのattestation、生成本番clientのHTTPS/CORS通信、Functionの実稼働は未検証です。それらはゲーム配信・build IAM・tester登録の別承認後に確認します。

## 止まった場合

`STOP` / `PARTIAL_STATE`が出たら短い表示だけを伝え、変更モードを繰り返しません。不確実なcreateは実際には成功している可能性があります。必要なら固定SHAの`--inspect`だけを使い、削除・再作成・設定変更・IAM追加・保護緩和をしません。helper自身は変更再送・巻戻しを行いません。gcloud内部の通信再試行まで制御・保証するものではありません。

## 検証と公式資料

自動テストはgcloudを合成応答へ差し替えます。実クラウドへのread/write、実attestation、秘密値や認証tokenの生成・取得は行いません。ローカル/CI合格はライブ設定の成功証明ではありません。

- [gcloud key create](https://docs.cloud.google.com/sdk/gcloud/reference/recaptcha/keys/create)、[list](https://docs.cloud.google.com/sdk/gcloud/reference/recaptcha/keys/list)、[describe](https://docs.cloud.google.com/sdk/gcloud/reference/recaptcha/keys/describe)、[IP override list](https://docs.cloud.google.com/sdk/gcloud/reference/recaptcha/keys/list-ip-overrides)
- [reCAPTCHA Key schema](https://docs.cloud.google.com/recaptcha/docs/reference/rest/v1/projects.keys)、[domain/subdomainの仕様](https://docs.cloud.google.com/recaptcha/docs/create-key-website)、[ProtoJSONの省略default](https://protobuf.dev/programming-guides/json/#presence-and-default-values)
- [App Check Enterprise登録](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider)、[provider config schema](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.recaptchaEnterpriseConfig)
- [enforcement](https://firebase.google.com/docs/app-check/enable-enforcement)、[project service設定の範囲](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.services)
- [reCAPTCHA料金](https://cloud.google.com/security/products/recaptcha)

公式仕様確認日：2026-10-03 UTC。Consoleの表示位置が違う場合は、対象・値を確認できるまで保存しません。
