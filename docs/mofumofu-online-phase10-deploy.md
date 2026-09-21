# もふもふ大集合！オンライン版 Phase 10 deploy手順

Phase 7では実行しない。本番値・Console設定を確認できたPhase 10でのみ使う。

## 必須実値とConsole確認

- 正規Firebase Web AppのRTDB URL（推測せずConsoleから転記）
- Functions runtime環境変数 `MOFUMOFU_RTDB_URL` に同じ正規RTDB URL
- reCAPTCHA Enterprise site keyとApp Check Web App登録
- Anonymous Authenticationが有効
- `fabdemnt-dev.github.io` がAuthorized domainsに登録済み
- Secret Managerの `MOFUMOFU_ONLINE_IP_HMAC_KEY`（32 bytes以上のランダム値）
- `MOFUMOFU_ENFORCE_APP_CHECK=true` は実機token確認後に設定
- Firestore TTL policyは次表を個別確認してから設定

| collection group | field | 保持期間 |
|---|---|---|
| mofumofuOnlineRooms | deleteAt | 待機30分、進行24時間、終了6時間 |
| members / privateHands / serverState | deleteAt | 親roomと同じ |
| mofumofuOnlineRoomInvites / mofumofuOnlineRoomSecrets | deleteAt | 親roomと同じ |
| mofumofuOnlineActionRequests | deleteAt | 24時間 |
| mofumofuOnlineRateLimits | deleteAt | 20分 |

TTLは削除の猶予を許す仕組みであり、Callableの期限判定は別途維持する。

## preflight、限定deploy、rollback

repository rootで `scripts/mofumofu-online-phase10-preflight.sh` を実行する。これはSHA-256と完全版Rulesを時刻付きdirectoryへ保存し、差分と対象Function名を表示する。内容をレビュー後、次の限定コマンドだけを個別に実行する。

```sh
firebase deploy --only functions:createMofumofuRoom,functions:joinMofumofuRoom,functions:startMofumofuGame,functions:resumeMofumofuRoom,functions:authorizeMofumofuPresence,functions:makeMofumofuOffer,functions:judgeMofumofuOffer,functions:runMofumofuNpcTurn,functions:startMofumofuNpcProxy,functions:runMofumofuNpcProxyAction,functions:cleanupMofumofuOnline
firebase deploy --only firestore:rules
firebase deploy --only database
```

問題時はpreflightが保存した `firestore.rules` と `database.rules.json` をrepository rootへ復元し、SHAを照合して、Rulesだけを各 `--only` で戻す。Functionsは直前のGit commitをworktreeへ展開し、同じ限定Function一覧で戻す。main、他ゲームnamespace、全サービス一括deployは対象外。

オンライン導線は実機検証が終わるまで `online-entry.js` の `ONLINE_PUBLIC_ENABLED=false` を維持する。
