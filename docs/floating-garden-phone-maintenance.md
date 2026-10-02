# 庭園専用の固定URLに準備中ページを置く

対象は `wa-awesome-garden-stg`（プロジェクト番号 `120030709276`）だけです。
固定URLは `https://wa-awesome-garden-stg.web.app` です。ページの公開期限はありません。
ゲーム側の **最大7日・20部屋・参加者2人** の制限とは別です。

## この段階でできること

`scripts/deploy-floating-garden-maintenance.mjs` は、認証済みの利用者自身の Cloud Shell で実行する専用の補助ファイルです。
初期状態では計画を表示するだけです。明示的に `--deploy-stopped-live` を指定すると、次の順で進みます。

1. `gcloud` でプロジェクトID・番号と有効な Hosting API を読み取り、完全一致を確認
2. 隔離した一時フォルダーに、固定コミットの npm manifest / lockfile を取得して SHA-256 を検証
3. `npm ci --ignore-scripts --no-audit --no-fund` で公式 Firebase CLI **14.27.0** を用意
4. 専用 Hosting サイトを読み取り、なければ同名のサイトだけを一度作成して再確認。作成結果のID・URLを確認した後だけ、反映待ちの一覧読取りを15秒間隔・最大3分で再試行（作成・配信は再試行しない）
5. live チャンネルを読み取り、既存の未確認リリースがあれば停止
6. コードに埋め込まれた設定と静的HTMLを直前に再照合し、`--only hosting:wa-awesome-garden-stg` で配信
7. live リリースのバージョン・固定URL・root/404/旧ゲーム入口の配信済みHTML・安全用HTTPヘッダーを再読取りして確認

既存リリースに同じ識別メッセージがあり、root・404・旧ゲーム入口のHTML/HTTPヘッダーが一致する場合は、確認だけで終わります。この再実行経路では既存リリース全体のファイル一覧や設定までは監査していないため、その制限を表示します。
失敗した配信を自動再試行せず、削除や期限リセットもしません。

準備中ページは `index.html` と同内容の `404.html` のみです。SDK、ログイン処理、ゲーム通信、外部素材、フォーム、イベント処理は含みません。CSP は `default-src 'none'` です。

## 実行前の確認

- 利用者自身の Cloud Shell で対象プロジェクトが読めること
- Node 20以上と npm / gcloud が使えること
- 今回の固定URLへの静的ページ配信と、必要な場合の同名 Hosting サイト作成を承認していること
- レビュー済みのコミットとファイルの SHA-256 を、案内された値に固定すること

ダウンロードと実行は分け、SHA-256 検証に成功した場合だけ実行します。ブランチ名や `main` の最新ファイルを無条件で実行したり、`curl | bash` を使ったりしません。

```sh
curl --fail --silent --show-error --location 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/REVIEWED_COMMIT/scripts/deploy-floating-garden-maintenance.mjs' -o garden-maintenance.mjs &&
printf '%s  garden-maintenance.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-maintenance.mjs --plan
```

配信の承認後だけ、SHA-256 をもう一度検証してから実行します。

```sh
printf '%s  garden-maintenance.mjs\n' 'REVIEWED_SHA256' | sha256sum --check &&
node garden-maintenance.mjs --deploy-stopped-live
```

上の `REVIEWED_COMMIT` と `REVIEWED_SHA256` は説明用の置き換え欄です。実際の案内では検証済みの値を使用します。

## 変更しないものと停止時の扱い

この補助ファイルは API の有効化、ログイン開始、Auth の許可ドメイン、IAM、サービスアカウント、秘密情報、Firestore Rules、Functions を変更しません。すべてのFirebaseコマンドへ専用 `--config` を明示し、親フォルダーの `firebase.json` / `.firebaserc` や既存ゲームの設定を読み込みません。

完了報告に必要なのは固定URLと `Verified:` の行だけです。認証コード、アクセス・更新トークン、APIキー、デバッグログは共有しないでください。補助ファイルは認証情報を表示せず、既存の Cloud Shell 認証を使います。

`STOP:` で終わった場合は、その短い説明を確認してください。配信自体が途中まで成功している可能性があるため、手動でサイトやリリースを消したり、別プロジェクトで再実行したりしません。次は対象リリースを読み取り、未確認の結果を確定させます。

固定URLが残っていても、バックエンドやデータが消えるわけではありません。ゲームの開始・終了、権限、費用、リソース削除は別の確認が必要です。

## テストの境界

補助ファイルの自動テストは subprocess と HTTPS 応答を置き換えた安全な検証です。誤プロジェクト、API不足、manifest改変、未確認リリース、配信失敗、読み戻し不一致、設定のフック/rewrites混入、余分な素材、symlink を拒否します。実際のクラウド配信成功を代用するものではありません。
実配信は利用者の Cloud Shell で承認済みの手順を実行した後、リリース情報と公開ページの両方で確認します。

## 2026-10-02 の実配信後の確認修正

初回の静的配信自体は成功しましたが、補助ファイルの配信後チェックが、Hosting APIの `projects/PROJECT_ID/sites/SITE_ID/versions/VERSION_ID` という正常な版名を拒否しました。公開root・404・旧ゲーム入口のHTMLとHTTPヘッダー、およびliveの識別メッセージ・DEPLOY・FINALIZEDを読取りで確認しました。この停止への対応として再配信は不要です。

版名の比較は、専用project ID `wa-awesome-garden-stg` または番号 `120030709276` のprefix付きと、prefixなしの同じ専用siteだけを正規化します。別project・別site・別版・未知message・DEPLOY以外・FINALIZED以外は引き続き拒否します。
