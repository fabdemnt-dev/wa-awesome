# 星詠みの浮遊庭園：人間2人＋NPCオンライン試作

この変更は実装・テスト用です。オンライン入口のproduction接続は既定で無効です。既存CPU対戦、ローカル保存、自由配置、既存オンラインゲームのルールは変更しません。

## 範囲

- 新規入口：`lab/floating-garden/online/index.html`
- 人間は常に2人、匿名UIDで1人1席。新規部屋でNPCを0・1・2人から選択し、合計2〜4席で対戦。作成者が招待コードを共有し、人間2人が揃ってから明示的に開始
- NPCはP3・P4のサーバー所有席。匿名UID・追加アカウント・外部AIサービスは不要
- 引く／保管／譲る／招く／迎える／保護代替／配置／瞑想／石／仕上げ／最後の石／採点は既存の庭園ルールを使用
- 端末の仮置き・回転・比較は表示用。確定操作、タイル、力、手入れ回数、終局・順位はサーバーが決定
- 通信切断だけでCPU代行、譲渡承諾、招きパス、敗北、退席は行わない
- 同じブラウザーで匿名UIDを保つ場合の復帰に対応。ブラウザーデータ消去後の本人復旧、席の別端末移行、人間3〜4人、途中離脱の代行、再戦の合意は初版対象外
- CPU残数アシストとCPU保存はオンラインへ持ち込まない

## 正本と公開境界

`functions/floating-garden-online/` が庭園専用のCallableと状態を持ちます。ブラウザーは確定盤面を書き込みません。Firestoreの公開roomは参加者だけが取得し、serverGames・招待検証情報・操作receiptはクライアントから読み書きできません。

引いたタイル、保管、盤面、力、招き希望は現行ルールで公開です。山札の完全な順番とseedはサーバーだけに残ります。公開projectionは許可項目を明示し、未知の内部フィールドを自動で展開しません。オンライン山札はサーバーの暗号学的乱数でシャッフルします。

既存の純粋な `engine.js` / `match-engine.js` / `cpu.js` をFunctionsパッケージ内へstageします。ルールの正本は引き続き `lab/floating-garden/` です。

```sh
npm run prepare:floating-garden:core
npm run check:floating-garden:core
```

`--check` が失敗した生成物を配信しません。CPUの保存・seed再現方式は変更しません。

## 操作の安全性

各確定操作は認証UID、部屋、gameId、ルール版、現在のrevisionを検証します。席はサーバーのmembershipから決定し、クライアントの申告は信用しません。合法コマンドの検証後、完全状態・公開状態・操作receiptを1つのtransactionで確定します。

requestIdは同じ操作を再送するときに保持します。同じIDの別payloadは拒否し、成功後に応答だけ失われても同じ操作を2回適用しません。結果不明時は次の確定を止めて元の操作を確認します。古いrevisionやgameIdを現在の盤面へ読み替えて適用しません。

復帰時に新たに引く処理はありません。確定状態を取得し、無効になった仮置きを破棄します。比較中も相手の状態更新は届きます。古いsnapshotや旧ページ世代の非同期結果で画面を巻き戻しません。

部屋の有効期間は作成から24時間です。期限後は操作・参加者読込みを拒否します。期限フィールドは物理的な自動削除の保証ではありません。本番公開前に保持期間と後始末を設定・検証してください。

## ローカル検証

Node.js 22以上、Java 21、既存lockfileの依存関係を使用します。

```sh
npm ci --ignore-scripts
npm ci --prefix functions --ignore-scripts
npm run check:floating-garden:core
npm run test:floating-garden:online
npm run test:floating-garden
npm run test:floating-garden:rules
npm run test:floating-garden:transactions
npm run test:floating-garden:integration
npm ci --prefix tests/e2e --ignore-scripts
# システムChromiumがない環境だけ：tests/e2e/node_modules/.bin/playwright install chromium
npm run test:floating-garden:browser
npm run test:floating-garden:browser:emulator
npm test
git diff --check
```

専用Firebase configは `firebase.floating-garden-emulator.json`、projectは実リソースを持たない `demo-floating-garden`。Auth 9099、Firestore 8182、Functions 5103を使用します。integration/rulesテストは必要なemulatorがなければ失敗し、成功としてskipしません。実サービスの資格情報をテストへ渡しません。

`test:floating-garden:transactions` は実Firestoreと本番用handlerを使う部分試験です。callerの認証contextはテストが注入し、Auth／Callable HTTP／CORS／App Checkは検証しません。完全な `test:floating-garden:integration` の代替成功とは扱いません。`test:floating-garden:browser` は実Chromiumの画面と操作を検証しますが、そのサービスはローカルのin-memory transaction fixtureです。

`test:floating-garden:browser:emulator` は差し替えなしの `app.js` / `firebase.js` を2つの独立したChromium contextで開き、実Auth・Callable HTTP・Firestore listenerを通して操作する統合試験です。使うのは同じrunner内のdemo emulatorだけです。App Checkはこの試作では無効で、production App Checkの検証は行いません。

実ブラウザー2contextと物理端末2台の試験は別物です。自動テストが通ったことだけで、スマホ・タッチ・読み上げ・別端末ネットワークを検証済みとは扱いません。

## 公開前の必須確認

1. 専用テスト、既存回帰、Firebase Rules、実Callableを使う2UIDの完走・復帰を確認
2. 本番project、origin、region、招待用秘密鍵、期限／cleanup、課金上限、監視、rollbackを確認
3. backend／Rulesを対象限定で準備し、対応クライアントの配信を確認した後に公開gateを有効化
4. 通信失敗、応答消失、リロード、複数タブ、古い画面からの操作を実ブラウザーで再確認
5. 物理端末2台、狭い画面、200%拡大、キーボード、読み上げを確認

**重要：現在の `deploy-firestore-rules.yml` はmainのfunctions関連変更から本番Functions全体を自動デプロイします。実装レビューのためのmainマージを行わないでください。公開・本番変更は別途承認が必要です。** 同workflowのhaikuクライアント確認は庭園の準備完了を証明しません。RTDBは今回追加していません。

この試作の専用CIはエミュレーター試験のみで、本番デプロイや秘密鍵作成を行いません。


## NPCモードの互換性と確定単位（2026-10-05）

- createの任意フィールド `npcCount` は整数0〜2だけを受け付けます。省略は従来の2人戦。0を選ぶUIは従来と同じpayloadを送信します。
- 2人戦の公開room形とroomの版 `floating-garden-match-1` は変更しません。NPC部屋のみ `npcCount` を追加し、`playerCount` は3または4、roomの通信・保存プロトコル版は `floating-garden-online-npc-1` になります。エンジン本体のmatch.versionは従来どおりです。既存部屋の人数を変更するAPIはありません。
- 待合室のplayersは参加済みの人間だけ。開始時にNPC席を追加します。membershipの有効な席は0と1だけで、NPC用membershipは作成しません。
- 人間の合法操作と、その直後から次の人間の判断までのNPC操作を同じtransactionに保存します。1回の操作あたりNPCは最大32コマンド。上限・不正手・期限超過では全体を確定しません。
- NPCは公開snapshotと合法コマンドだけを受け取ります。山札順・seedを参照せず、同じ状態では同じ手を選ぶため、transaction再実行・receipt再送で二重進行しません。
- room.revisionは受理した人間の操作ごとに1増加し、match.revisionはNPCを含むエンジンコマンドごとに増加します。クライアントはmatch.revisionが1より大きく進む更新も扱います。
- 全コマンドを既存のprivate serverGamesへ保存し、初期状態から最終状態を完全再生できます。getSnapshot・再接続だけでは手番を進めません。切断した人間の操作は自動選択しません。

既存のowner起動ヘルパーは承認済みの旧commitと60ファイルのhashを維持しています。新しいNPCソースを旧承認に紛れ込ませる更新はしません。そのpin検査はHEADとの同一性ではなく、実際にヘルパーが取得する旧commitのバイト列を検証します。CIはこの検証のため履歴を取得します。

### 試用へ追加する前の確認

この変更はソース準備です。現在の2UID・20部屋・既存の終了時刻や部屋を変更していません。公開時には最新commitのCI、3/4席の実画面、生成したclient/server/Rulesの互換性を確認し、対象を限定した別の承認が必要です。既存のHosting-only更新ヘルパーでbackend変更を配信しないでください。NPC追加を理由に人間枠・試用期限・部屋数・IAM・App Check設定を広げません。

NPC専用room版は、更新前の古い呼出しを安全に拒否するための境界です。更新前のコードも同じrulesVersion欄を最初に検査するため、遅れて実行されたjoin/start/submitやreceipt再送が新NPC部屋へ書き込めません。既存2人部屋への正当な古い操作は継続でき、部屋作成数が再開後に増えることもあります。残数を更新前の値へ戻してはいけません。30秒のtimeoutを古い処理の終了証明とは扱いません。
