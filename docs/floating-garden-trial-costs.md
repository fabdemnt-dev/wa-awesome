# 庭園・7日試験の費用シナリオ

2026-10-02 UTCの公式資料に基づく概算です。**新project、請求先、予算、支出制限、残り無料枠は未設定・未確認**です。正常な小規模利用なら0〜200円程度、余裕300円という説明はできますが、300円は支払上限でも停止保証でもありません。

## 想定

- 2人、7日、最大20部屋/20戦。1戦135操作程度
- 操作後のsnapshot取得やcreate/join/start/reloadを含め、5関数の**合計**6,000呼出し。関数ごと6,000回ではない
- 1vCPU/256MiB、1呼出しの課金対象時間を平均1秒相当と仮定。cold start、認可、transactions、失敗/再送も測定して見直す
- 新しいtester gate/Rules/listener再接続の読取りも考慮し、合計読み取り15万、書込み2万以内を仮置き。実測値ではない。7日に分散すればFirestore日次無料枠に収まりやすいが、集中やRules評価で超える可能性がある
- 5関数を各3回deploy、平均5分でbuild合計75分
- Artifact Registry合計1〜5GiBを7日、Firestore保存1GiB未満、Hosting転送1GB未満、通常の小さなログ/応答
- 有料backup/PITR/TTL削除、Artifact Analysisスキャン、SMS、年間利用契約は追加しない
- 換算は説明用の1USD=150円、税別。実際はGoogleのJPY SKU、税、当該月の利用量による

## 主な費用

| 項目 | 無料枠除外での概算 | 条件・根拠 |
|---|---:|---|
| Functions/Cloud Run計算・requests | 約23円 | 6,000×(1vCPU秒×$0.000024+0.25GiB秒×$0.0000025)+6,000/百万×$0.40。東京Tier1、request-basedの仮定 |
| Cloud Build | 約68円 | 75分×$0.006。e2-standard-2の共有無料枠が残れば0円 |
| Artifact Registry保管 | 約3〜17円 | 1〜5GiBを7日。削除しなければ終了後も保管費が続く |
| Secret1version | 約2円/7日 | 月$0.06の日割り相当。共有無料枠があれば通常0円。access量も別確認 |
| Firestore/Auth/Hosting/Logging | 通常は0〜少額 | 各無料枠と利用の分布次第。SDK/Rulesの実読取りを確認する |

したがって、共有無料枠が残れば0〜数十円、使い切っていても上の正常利用なら概ね100〜200円が目安です。Functions応答転送、build source保存等の小額費目も考慮します。東京の転送を北米無料枠と混同しません。

[Cloud Run料金](https://cloud.google.com/run/pricing)、[Cloud Build料金](https://cloud.google.com/build/pricing)、[Artifact Registry料金](https://cloud.google.com/artifact-registry/pricing)、[Secret Manager料金](https://cloud.google.com/secret-manager/pricing)、[Firestore料金](https://firebase.google.com/docs/firestore/pricing)、[Hosting料金](https://firebase.google.com/docs/hosting/usage-quotas-pricing)、[Firebase料金](https://firebase.google.com/pricing)、[Logging料金](https://cloud.google.com/products/observability/pricing)

### App Checkに伴う別条件

新clientはReCaptchaEnterpriseProviderを使いますが、このSDK名は有料の年間Enterprise契約を選ぶ指示ではありません。公式料金上のreCAPTCHA無料10,000 assessmentsは組織全体で共有されます。現在のtier/無料枠が未確認なので、0〜200円には「その無料枠内に収まる」という条件が必要です。

Premium側で10,001〜100,000 assessmentsの段階へ入る場合、公式表示の月$8（説明用換算で約1,200円）が追加となり、300円を超えます。開始前に料金tierと残枠を確認し、未知なら勝手に有料契約・upgradeを行いません。[reCAPTCHA公式料金](https://cloud.google.com/security/products/recaptcha)

## 制御の意味と限界

- maxInstances1は**各関数**。5関数全体が1台になるわけではなく、金額制限ではない
- minInstances0でも呼出し処理・cold start・保存等が無料になるわけではない
- 例として5台×1vCPU/256MiBが7日ずっと課金対象処理を続けると、計算だけで約11,170円。無料枠/requests/DB/転送を除く例であり、最大請求額ではない
- 2UID許可、App Check、20部屋、rate limit、期限は乱用を減らすが、無効リクエストの処理費や保存をゼロにはしない
- 通常budget alertは通知。サービス別spend cap（Preview）は現在存在するが、反映遅延の超過分も請求され、project全サービスの一括hard capではない。月初の再開にも注意
- projectを分けても同じ請求先のCloud Run/Build/Secret等の無料枠・支払先は共有される
- preview終了、利用期限、Functions停止、データ/Artifact/secret/source cleanupは別。後始末の承認と実行が必要

[spend capsの公式制限](https://firebase.google.com/docs/projects/billing/spend-caps)、[最大インスタンス設定](https://docs.cloud.google.com/run/docs/configuring/max-instances)、[Functionsのbuildと保存](https://docs.cloud.google.com/functions/docs/building)

**試験開始の実行承認では、正確なproject・請求先・期間・費用目安・停止方法を提示します。既存アカウントに300円予算やhard capが設定済みとは扱いません。**
