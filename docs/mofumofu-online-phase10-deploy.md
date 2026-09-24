# もふもふ大集合！オンライン版 Phase 10 production作業表

Phase 9では実行しない。すべての変更前に対象projectと現在値を保存し、1工程ずつ検証する。

## 固定production値

- project ID: `wa-awesome`
- project number: `1074804319870`
- Web App ID: `1:1074804319870:web:923f0ec866812f98ae5a2f`
- RTDB URL: `https://wa-awesome-default-rtdb.asia-southeast1.firebasedatabase.app`
- GitHub Pages origin: `https://fabdemnt-dev.github.io`
- reCAPTCHA Enterprise App Check site key: `6LeU8sstAAAAAOEyP56nWLD633TiAWaLmvcskE6e`
- 初期公開フラグ: `ONLINE_PUBLIC_ENABLED=false`

## 順序付き作業

1. `firebase use`、Console、Web App設定でproject ID／number／Web App ID／RTDB URLを再確認する。stagingと異なることを記録する。
2. Anonymous AuthenticationとAuthorized domain `fabdemnt-dev.github.io` の現在値を画面保存する。変更が必要な場合は変更前値も保存する。
3. Functionsの現在の環境変数・Secret version・11 Functions（10 Callable＋cleanup scheduler）・runtime／regionを保存する。Secret本文はログやファイルへ出さない。
4. `MOFUMOFU_RTDB_URL` を固定production RTDB URLへ設定する。
5. `MOFUMOFU_ONLINE_IP_HMAC_KEY` が32 bytes以上のproduction専用ランダムSecretであることを確認し、未作成時だけ作成する。
6. App Check provider、Web App紐付け、TTL 3600秒、許可domainを再確認する。ここではenforcementをONにしない。
7. Firestore TTLの現在policyを保存し、次表のcollection group／`deleteAt`を個別設定する。

| collection group | 保持期限 |
|---|---|
| mofumofuOnlineRooms | 待機30分、進行24時間、終了6時間 |
| members / privateHands / serverState | 親roomと同じ |
| mofumofuOnlineRoomInvites / mofumofuOnlineRoomSecrets | 親roomと同じ |
| mofumofuOnlineActionRequests | 24時間 |
| mofumofuOnlineRateLimits | 20分 |

8. `scripts/mofumofu-online-phase10-preflight.sh` で現在Rules、対象ファイルSHA-256、対象Function一覧を時刻付きdirectoryへ保存する。
9. 10 Callableと`cleanupMofumofuOnline`だけを限定deployする。Firestore Rules、RTDB Rulesも各サービス限定で個別deployする。
10. cleanup schedulerが60分間隔・`Asia/Tokyo`・`asia-northeast1`で有効か確認する。
11. production clientを反映するが、`ONLINE_PUBLIC_ENABLED=false`を維持する。
12. production直接URLでAuth、App Check初期化、正規App Check token、create／join／start／resume、Firestore／RTDB同期を確認する。debug provider/tokenは禁止する。
13. Functionsの呼出数、4xx/5xx、latency、App Check invalid/missing、Firestore／RTDB拒否、cleanup結果を確認する。
14. 実測が正常な場合だけ`MOFUMOFU_ENFORCE_APP_CHECK=true`を設定して10 Callableを再deployする。cleanup schedulerにはclient App Checkを要求しない。
15. enforcement ON後に正規client成功、tokenなし／不正token拒否、resume／presence／NPC代理を再確認する。異常時は即rollbackする。

限定deploy対象:

```sh
firebase deploy --only functions:createMofumofuRoom,functions:joinMofumofuRoom,functions:startMofumofuGame,functions:resumeMofumofuRoom,functions:authorizeMofumofuPresence,functions:makeMofumofuOffer,functions:judgeMofumofuOffer,functions:runMofumofuNpcTurn,functions:startMofumofuNpcProxy,functions:runMofumofuNpcProxyAction,functions:cleanupMofumofuOnline
firebase deploy --only firestore:rules
firebase deploy --only database
```

## rollback

- client: 直前の正常commitをGitHub Pagesへ再反映する。一般導線は`ONLINE_PUBLIC_ENABLED=false`へ戻す。
- Functions: 保存した直前commitから同じ11 Functionsだけを限定deployする。`MOFUMOFU_ENFORCE_APP_CHECK`の変更前値も復元する。
- Firestore／RTDB Rules: preflight保存版をrootへ戻し、保存SHAと一致後に各Rulesだけを限定deployする。
- App Check enforcement: ConsoleでFunctions／Firestore／RTDB／Authenticationの変更対象だけを変更前状態へ戻す。
- runtime config: clientの直前正常commitと、保存したFunctions環境変数の変更前値を復元する。Secret本文はrollback資料へ保存しない。
- main反映後: revert commitを作成して通常pushし、force/resetで履歴を書き換えない。

TTLは削除時刻を保証しないため、Callable内の期限判定とcleanupを維持する。rollback後は直接URL、metrics、Rules拒否、`ONLINE_PUBLIC_ENABLED=false`を再確認する。
