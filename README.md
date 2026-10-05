# Frieren Fetch — Cloudflare Workers

週刊少年サンデーの次号ページを水曜07:15 JST（火曜22:15 UTC）に確認し、既存のntfyトピックへ日本語で通知します。GitHub Actionsから段階的に移行するコードです。

Cronは `15 22 * * TUE` を使います。Cloudflareの曜日番号は1=日曜なので、GitHub Actionsの `2`（火曜）をそのまま移植しないでください。

## 構成と無料枠

- Workers Cron Trigger ×1、通常は月4〜5回。外部リクエストは通常2回/実行、取得リトライ込み最大4回。
- Workers標準のHTMLRewriterで `div.content__main` のテキストから「フリーレン」を検索します。既存の検索範囲を維持するため、掲載の確定情報ではなくページ内のキーワード検出です。
- KV、D1、Queues、有料プランは不要です。Freeプランで運用してください。
- Workers Free: 100,000リクエスト/日、CPU 10ms/実行、Cronはアカウント全体で5個まで。他Workerと共有する上限にも注意してください。
- 通信待ちはCPU時間に含まれません。ただし本番ページのCPU使用量は公開後のMetricsで確認が必要です。無料枠内での実測は未実施です。
- Cronは厳密な時刻保証ではありません。GitHubの60日非アクティブ停止への依存はなくなりますが、外部サイトやntfyの障害まで保証するものではありません。

参考: https://developers.cloudflare.com/workers/platform/limits/
https://developers.cloudflare.com/workers/configuration/cron-triggers/

## 初回公開（旧GitHubジョブを残したまま検証）

Node.js 22以降とCloudflareアカウントを用意します。Wranglerのインストール・公開はネットワーク接続のある端末で実行してください。

```sh
npm ci
npm test
npx wrangler login
# まずCronなしで公開。worker名は両設定ファイルで同じです。
npm run deploy:setup
npx wrangler secret put NTFY_TOPIC
npx wrangler secret put RUN_TOKEN
```

- `NTFY_TOPIC`: 現在ntfyアプリで購読しているトピック名をWranglerの入力欄に登録します。GitHub Secretsから値を読み出すことはできません。チャットやコードに書かないでください。
- `RUN_TOKEN`: パスワードマネージャーで生成した十分長いランダムな値を入力します。手動確認用のPOST `/run` を保護します。
- 既に `frieren-fetch` というWorkerがある場合は、先に既存用途を確認し、必要なら両設定ファイルのnameを変更してください。

### 本番Workerの通知テスト

公開時に表示されるworkers.devのURLに対して、認証付きPOSTを送ります。1回実行すると通知が1通送られます。

```sh
# bash。トークンは入力時に画面に表示せず、シェル履歴にも値を残しません。
read -r -p 'Worker URL: ' FRIEREN_WORKER_URL
read -r -s -p 'RUN_TOKEN: ' FRIEREN_RUN_TOKEN
printf '\n'
printf 'header = "Authorization: Bearer %s"\n' "$FRIEREN_RUN_TOKEN" |
  curl --config - --fail-with-body --request POST "$FRIEREN_WORKER_URL/run"
unset FRIEREN_RUN_TOKEN
```

`{"found":false,"notified":true}` または `{"found":true,"notified":true}` を確認し、スマホ側でも通知を確認します。無認証なら401、GETなら405です。ログにはトピック名や通知APIの応答本文を出しません。

### 定期実行への切り替え

1. 上記のWorker通知テストとCPU使用量（10ms上限内）を確認します。
2. `npm run deploy` で水曜07:15 JSTのCronを有効化します。反映には最大15分程度かかる場合があります。
3. Cloudflare管理画面のWorkerのCron設定と実行履歴で登録・実行を確認します。
4. GitHub側の **Keep Aliveを先に無効化** し、その後 **Frieren Checkを無効化** します。Keep Aliveを残すと本体が再有効化されます。

GitHub CLIを利用する場合:

```sh
gh workflow disable keepalive.yml --repo y-fujinuma/frieren-fetch
gh workflow disable frieren-check.yml --repo y-fujinuma/frieren-fetch
```

現在のPRでは旧ワークフローは変更しません。Cloudflareでの公開・検証・切り替えが済む前に停止しないでください。一時的に両方を有効にすると同じ週の通知が重複する可能性があります。

## エラーの扱い

取得タイムアウト・429・5xx・通信障害（応答本文の読み込み中断を含む）には最大3回のGETを試行します。404等の恒久的エラーは再試行しません。HTML以外の応答、対象要素の欠落・空欄、ntfy送信失敗は実行エラーとなり、「掲載なし」を送信しません。送信結果が不明なPOSTは重複を避けるため自動再送しません。次の週まで待たず必要に応じて手動実行してください。

Scheduled invocationのエラーはCloudflareの実行履歴で確認してください。障害時の別経路アラートや自動再実行はこの最小構成には含まれていません。

## ローカル検証

```sh
npm test
npm run dev
# ローカルのsecretは .dev.vars に登録（gitignore対象）
# 実トピックなら実際に通知されるためテスト用トピック推奨
curl 'http://localhost:8787/__scheduled?cron=15+22+*+*+TUE'
```

テストでは判定・チャンク境界・HTTP/通知失敗・認証ガード・Cronの曜日/JST変換に加え、GET再試行の復旧/上限とPOST非再送を検証します。Miniflare/workerdのHTMLRewriterでは実HTMLの解析・本文中断・本文読み込み中のタイムアウト・再試行間の判定リセットも検証します。Wranglerのdry-runビルドも確認済みです。本番CPU計測・通信テストは公開後に必要です。

## ロールバック

`npm run deploy:setup` でCloudflare Cronを停止した後、GitHubのKeep Aliveを有効化して手動実行します（本体の有効化と通知チェックが行われます）。
