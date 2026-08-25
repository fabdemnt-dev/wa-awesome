# wa-awesome

わ〜鯖で俳句やポエムを楽しむためのWebアプリです。

## 機能

- 俳句
- ポエム
- ルーム作成・参加
- 御印（リアクション）
- 音声読み上げ
- エクスポート

## 利用方法

GitHub Pagesで公開しているページを開き、ルームを作成または参加して遊べます。

## 注意

このリポジトリは個人利用・友人間での利用を目的としています。
コードやコンテンツの無断転載・再配布はご遠慮ください。

## 共有パスワード付きワードセットの設定

パスワード付きワードセットは、パスワードを知っている人だけが編集・削除できるよう、Firebase Authentication、Cloud Functions、Firestore Rulesを使います。初回のみ、Firebase Consoleで次の設定が必要です。

1. **Authentication** の「Sign-in method」で **匿名** を有効にします。
2. Firebaseプロジェクトを **Blaze（従量課金）** プランへ切り替え、請求先を設定します。Cloud Functionsにはこの設定が必要です。少人数利用では無料利用枠内に収まる場合がありますが、Firebase Consoleで予算アラートも設定してください。
3. GitHub Actionsの `FIREBASE_SERVICE_ACCOUNT_JSON` がCloud Functionsをデプロイできる権限を持つことを確認します。
4. `main` へ反映すると、GitHub Actionsが `firestore.rules` と `functions/` をFirebaseへデプロイします。デプロイ完了後、パスワード付きセットを新規作成して、別ブラウザで正しいパスワードと誤ったパスワードを試してください。

パスワードそのものはFirestoreの公開ワードセットに保存しません。サーバー側に保存したbcryptハッシュで照合します。以前の簡易ハッシュ方式で保存されたセットは、最初に正しいパスワードで編集すると安全なハッシュへ移行します。
