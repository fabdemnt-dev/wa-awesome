# 庭園：使用中の試用へNPCを追加する更新設計

2026-10-05。公開中の試用への実行承認や、配信済みであることを示す文書ではありません。基盤CLIは計画の検査だけを行います。別の所有者用入口は、明示的に承認された1回の更新だけを、以下の条件で実行します。

## 所有者用の一回限りの実行入口

`scripts/floating-garden-active-update-execute-owner.mjs` は、既に読取り確認が成功した `garden-active-update-41c44301490e-iam-read-v2` だけを使います。準備の作り直し、依存関係のインストール、ログイン、認証情報や権限の変更は行いません。既存の読取り専用入口は変更せず、固定commitとSHA-256で検証して再利用します。

- 既定と `--plan` は説明のみ。実行には順番も含めて `--apply-approved-update --players-stopped --exclusive-maintenance` の3つが必要です。所有者が更新範囲を了承し、2人のゲーム操作と他の管理・デプロイ操作を止めた後に、レビュー済みの固定版を1回だけ実行します。
- 過去の確認値を成功扱いで再利用せず、既存2部屋・累計使用数2・上限20・同じ2人・固定期限を更新直前にも読み直します。既存部屋での正当な操作によるreceipt等の増加は許容し、その時点の全データを保持します。新しい部屋が増えていた場合は、一時停止する前に停止します。
- 準備フォルダーの隣に、排他的かつ永続化した実行済みガードを作ります。ダウンロード失敗、読取り失敗、途中終了を含め、ガードは消去・上書き・再利用しません。同時起動や2回目の起動は停止します。
- 実行承認を検証済みの旧・新manifestに結び付け、既存の段階別処理と永続journalを使います。元の準備や旧operationを置き換えず、新operation内に `ACTIVE-UPDATE-JOURNAL.jsonl` を追加します。
- 途中経過は `UPDATE_PROGRESS` / `UPDATE_VERIFIED`、最終結果は `UPDATE_RESULT` として、秘密・UID・生のprovider応答を含まない情報だけを出します。失敗時の `access` は読取りで確認した `open` / `closed` / `unknown` です。実行前の停止を「閉鎖済み」とは報告しません。
- 一度実行したコマンドを再実行したり、ガードやjournalを削除したりしません。結果を確認してから次の対応を判断します。成功確認後に2人の画面を再読込みします。自動で新しいNPC部屋を作る試遊は含みません。

入口はクラウド全体のロックではありません。Functions・Rules・Hostingにまたがる原子的なCASはなく、保守中の他の更新を停止する前提は変わりません。最後の再開後には正当なゲーム操作や部屋数増加が起きうるため、入口は更新前の2部屋を「再開後の現在の部屋数」として返しません。

## 対象と維持するもの

対象は `wa-awesome-garden-stg` の既存の2人用試用から、NPC専用プロトコルを持つ版への初回更新だけです。汎用デプロイヤー、停止済み試用の再開、2回目以降の更新には使いません。

- 既存の人間2人、20部屋上限、使用済み部屋数、全ての既存部屋・ゲーム・操作receipt・招待・rate limitを保持
- 開始 `2026-10-04T23:45:51.472Z`、終了 `2026-10-11T23:45:51.472Z`（日本時間10月12日08:45:51.472）を固定
- 既存のAuth、App Check、IAM、HMACのversion/binding、API、Functions設定を保持。秘密の値は読み出さない
- 5つの既存Functionsはsourceのみ、専用Firestore Rules、同じHosting siteの生成済みファイルだけを更新
- 部屋数カウンターへ書き込む処理、データ削除、権限の追加、APIの有効化、Functionの削除・再作成は含めない

実行時の実データ・設定を読み直すまで、これらが現在のクラウド状態と一致するとは断定しません。準備テストのUID・データは合成値です。

## 旧版が遅れて動く場合の互換性

従来の2人用roomは `floating-garden-match-1` のままです。NPC部屋は `floating-garden-online-npc-1` に分けます。エンジン本体の版は変更しません。

旧版の実際の生成ソースもroomの版を最初に確認するため、新NPC部屋へのjoin/start/submit、snapshot、receipt再送を拒否します。部屋のモードを後から変えるAPIはありません。旧版と新版の全生成ファイルを固定し、最初の読取りでNPCのない既存2人部屋だけであることを検査します。

30秒待つだけでは旧処理の終了を証明できません。[Cloud Runのtimeoutは応答を終了しても処理を停止するとは限りません](https://docs.cloud.google.com/run/docs/configuring/request-timeout)。この更新は時間経過による終了判定に依存しません。再開後に旧版の正当な2人部屋作成が確定することは許容し、使用済み数の単調増加と20上限を確認します。旧カウンターを復元して残数を増やしません。

## 更新順序と確認

1. 旧・新の実generatorから作ったpacket、全ファイル、SOURCE-SHA256、同一の非公開reviewを検査する。差分は追加1ファイルと変更8ファイルに限定する。
2. Functionsの実source、Cloud Runのready revision/100% traffic、FunctionsとRun双方のIAM、Rules、Hosting、Auth/App Check等を読み取る。既知の庭園schemaの全root collectionとmembers/serverGamesをtransactionで確認する。未知root、上限超過、未対応の型や状態は停止する。
3. 読取り時からデータが変わっていないことを単一Firestore transactionで照合し、gateと既存2人のactiveだけを閉じる。使用済み数やゲームには書き込まない。閉じた状態と全保持対象を再確認する。
4. 5つのFunctionsのsourceを順に更新し、それぞれ完了と実sourceを確認する。設定・IAM・trafficも照合する。
5. 専用Rulesのrulesetを作り、既存releaseを更新して内容を照合する。
6. Hostingの新versionへ正確なgzipファイルをアップロードする。ページ分割された全ファイルを照合し、余分・不足・重複・hash不一致・未完了ファイルがない場合だけfinalize/releaseする。実際の公開ファイルも照合する。
7. データ、設定、source、IAM、Rules、Hosting、旧版を隔離する版の境界を再確認する。保持対象が停止時から変わっていないことをtransactionで照合し、同じ2人だけを同じ期限で再開する。
8. 再開後の状態を読み直す。再開直後の正当なゲーム操作や部屋作成は許容し、カウンターを巻き戻さない。

各provider書込みの直前にもpacket、閉鎖状態、設定、適用済みFunctionsを再確認します。書込み前のjournalはローカルへ追記してfsyncします。実行承認は旧・新manifest digest、一時停止、5 Functions、専用Rules、同じHosting、同じ2人の再開、全データとIAMの保持、他の更新者を止めた保守時間に限定します。ソースをGitHubへ保存する承認だけでは実行しません。

## 途中で失敗した場合

- 各更新は1回だけ送信する。Google Auth/Gaxiosによる401/403時の自動再送やHTTP retryも抑止し、応答不明を成功扱いしない。
- 段階、完了済みFunction数、読取りで確認できたアクセス状態を報告し、自動でやり直さない。
- 一時停止の確定・閉鎖を読み返せた後は、再開まで閉じた状態を確認して進める。一時停止や再開transactionの応答が失われた場合は、書込みが実際には確定済みの可能性がある。追加の書込みをせず、読取りで `open` / `closed` / `unknown` を区別する。初期検査や停止前の失敗を、閉鎖済みと偽って報告しない。
- 再開後に新NPC部屋が作られたら、旧backendへ戻して遊べる状態にはしない。障害時の再閉鎖や修復は、実状態を確認して別途範囲を承認する。
- 旧版の初回deploy/resume/activateヘルパーは使用中の試用更新に転用しない。既存の安全検査とpinは緩めない。

## 確認できることの限界

Functions・Rules・Hosting全体を一度に原子的に更新するAPIではありません。provider側の一部更新には、読取り時点のETag等を指定するCASがありません。書込み直前の確認と排他的な保守時間が必要で、全providerにまたがる原子性は主張しません。

Functionsのsource再buildでは、providerのruntime/security patchによってコンテナimageが変わることがあります。runtimeの設定や権限を維持することと、imageがbyte単位で同一であることは別です。

Rulesのrelease読取りはcontrol planeの確認です。[Firestoreは新しいquery/listenerで最大1分、既存listenerで最大10分の反映時間を説明しています](https://firebase.google.com/docs/firestore/security/get-started)。全利用者への反映完了を返す検査とは扱いません。今回の差分は従来の2人制限にmembership seatが整数0/1である条件を加えるもので、反映途中に従来より権限を広げません。

## テスト

- `npm run test:floating-garden:active-update`：実旧・新generator、manifest検査、providerとの組合せ、ZIP/gzipとREST payload、各段階の失敗・応答消失、journal、権限・データ差分拒否
- `npm run test:floating-garden:active-update:transactions`：demo projectの実Firestore emulatorとAdmin SDKで停止・保持・再開のCAS、並行変更、応答消失を検査。クラウドproviderは注入したローカル応答
- `npm run test:floating-garden:online`：旧生成handlerとの互換性、2/3/4席、NPCの原子的な進行、非公開情報・認可・再送・競合の回帰

ネットワークbridgeは固定したgoogle-auth-library 9.15.1、実際に解決されるGaxios 6.7.1で再送抑止を試験します。実Cloud APIでの更新はこれらのローカル試験には含まれません。
