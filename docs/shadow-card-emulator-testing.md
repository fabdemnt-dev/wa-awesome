# 影札の交渉 オンライン版 Emulator検証手順

本手順は本番Firebaseへ接続しない。オンライン版は、この手順の全試験が合格するまで完成扱いにしない。

## 固定する実行環境

- Node.js: 20.x（検証時は20.20.2）
- Java: 21以上
- Firebase CLI: 14.27.0
- firebase-functions: 6.6.0（`functions/package-lock.json`準拠）
- firebase-admin: 12.7.0（`functions/package-lock.json`準拠）
- Firestore Emulator: 1.19.8
- Realtime Database Emulator: 4.11.2

`npm ci`と`npm --prefix functions ci`でlockfileどおりに導入する。グローバルFirebase CLIではなく、`npx firebase`でリポジトリ内のCLIを使う。

## 初回準備

```sh
node --version
java -version
npm ci
npm --prefix functions ci
npm --prefix .emulator-minimal/functions ci
cp .env.shadow-card-emulator.example .env.shadow-card-emulator.local
set -a
. ./.env.shadow-card-emulator.local
set +a
```

`.env.shadow-card-emulator.local`はGitへ追加しない。サンプル値だけで試験でき、本番秘密鍵は使用しない。

## 安全確認

実行前に以下がすべて成立することを確認する。

```sh
test "$FIREBASE_PROJECT_ID" = demo-shadow-card
test "$GCLOUD_PROJECT" = demo-shadow-card
test -n "$FIREBASE_SKIP_UPDATE_CHECK"
```

コマンドには必ず`--project demo-shadow-card`または`--project demo-minimal`を指定する。`demo-`プロジェクトはEmulator専用で、存在する本番プロジェクトIDを指定しない。`firebase use`、`firebase deploy`、`gcloud`は実行しない。

## 一括実行

```sh
bash scripts/run-shadow-card-emulator-tests.sh
```

実行順序は、純粋ロジック、最小Callable、4種Emulator統合試験。最小Callableが失敗した場合は統合試験へ進まない。

## 個別実行

```sh
npm run test:shadow-card:local
npm run test:shadow-card:rules
npx firebase --config .emulator-minimal/firebase.json emulators:exec --only functions --project demo-minimal "node .emulator-minimal/call.mjs"
npm run test:shadow-card:integration
```

統合試験ではAuth、Firestore、Realtime Database、Functionsを同時起動する。選択期限はEmulator時だけ1秒へ短縮し、タイムアウト処理を確認する。本番既定値90秒は変更しない。

## 期待結果

- 最小Callable: HTTP 200と`{"result":{"ok":true,"uid":null}}`
- 異なる匿名UIDを2件発行
- 招待コードで2人が同一ルームへ参加
- 4席が`seat0`〜`seat3`で固定され、人間2席・NPC2席になる
- 各人の手札は4枚で、相手・NPC・サーバー用データは読めない
- NPC2席は人間の提出前にサーバー側で選択済み
- 未公開中は結果が存在せず、解決後だけ4枚を公開
- 同一requestIdの再送は冪等、別requestIdでの二重提出は拒否
- 1ラウンド目は短縮期限による自動選択、2〜5ラウンドは両者同時提出
- 5ラウンド目に`phase: finished`
- Presenceは切断後`offline`、同じUIDで再接続後`online`

## 失敗時のログ

- `firebase-debug.log`: CLI、Functions定義、起動Node、HTTP呼び出し
- `firestore-debug.log`: Transaction、Rules拒否、Indexエラー
- `database-debug.log`: Presence Rules、接続・切断
- テスト出力: 失敗したassertionとCallableエラーコード

`PERMISSION_DENIED`が秘匿確認で出るのは期待結果。Function開始前の失敗、`ECONNREFUSED`、`UNAUTHENTICATED`、想定外の`PERMISSION_DENIED`、Index不足、ポート使用中は失敗として扱う。

試験後、Emulatorプロセスが終了し、9099、8080、9000、5001番ポートが解放されたことを確認する。本番Consoleや実データの変化を検証結果として使用しない。
