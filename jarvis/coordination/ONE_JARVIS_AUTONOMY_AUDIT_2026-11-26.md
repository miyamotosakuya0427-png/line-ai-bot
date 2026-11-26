# ONE JARVIS 自律実行・永続化ギャップ監査（2026-11-26）

## 監査範囲と安全境界

対象は GitHub `miyamotosakuya0427-png/line-ai-bot`、Render `one-jarvis`、Neon `one-jarvis` production、および Descript / HeyGen / vidIQ / Metricool の読み取り状態。fal と Google Sheets の実接続は今回未確認。

本監査は読み取り専用。LINE本番、Render設定、環境変数、Neon production のDDL/DML、課金、生成、アップロード、公開、PRマージには触れていない。秘密値・接続文字列・トークンは取得・記録していない。

## GitHub 状態

- main HEAD: `3bfd3781ae7dc9d4be8d868383a1aaa388d50673`
- one-jarvis-foundation HEAD: `95b2570e41149c8cbde512c33db9b7cffe184b09`
- Render live commit: `f3d6203c236257fc1248d03d092d4202eaf8bd66`
- foundation は live commit より3コミット先行。差分は Apps Script / server / video workflow 関連。
- ブランチ数90、Open PR 65件。
- GitHub branch API の protected フラグは main / one-jarvis-foundation とも false。Rulesets詳細は連携権限不足（HTTP 403）で未確認。
- PR #78: Draft / Open、head `9ae4370eb2f67f4b730b52a0c0479618a5f00f07`、base `integration/one-jarvis-stage5-dispatcher-state-machine`、37 files / 224 commits。最新headに対するJARVIS tests、ONE JARVIS tests、Task Registry PostgreSQL 16は3/3成功。
- PR #83: Draft / Open、head `2e523483adb81c8873d6582601d3c9902bc4a06d`、base `audit/one-jarvis-integration-master-plan`。CI 2/2成功。
- PR #82: Draft / Open、head `54f018ddac42ddf244fffeea540b3edab3ba0e78`。CI 3/3成功。
- PR #27 / #28 / #29 はすべてOpen Draft。音声レビュー関連の変更は主に video-batch metadata / review state / dashboard であり、実音声バイナリの耐久保存を証明しない。

## Render one-jarvis

- Free / Singapore / 1 instance / Node / branch `one-jarvis-foundation`
- Auto Deploy off。healthCheckPath は空。
- Render Postgres instance は0件。
- 最新Live deployは commit `f3d6203c236257fc1248d03d092d4202eaf8bd66`（2026-11-15）。
- 2026-11-25 08:00Z〜2026-11-26 00:00Z の CPU / memory / HTTP / instance metrics は全て空。Render events も空。
- service metadata に永続ディスク情報は含まれず、永続ディスクは未確認。Freeプランのローカルファイル保存を耐久保存と見なしてはならない。

## Neon production

- Project `super-fog-73704467`、PostgreSQL 18、region `aws-ap-southeast-2`。
- production branch `br-floral-field-a71odam5` は default / ready / protected=false。
- schema tree は `public` のみ。テーブルは `jarvis_jobs`、`jarvis_job_attempts`、`jarvis_approvals`、`jarvis_audit_events`、`schema_migrations`。
- `public.schema_migrations` の履歴は `001` の1件。上記4運用テーブルの行数はすべて0。
- PR #78 のTask Registry migrationsは `CREATE SCHEMA IF NOT EXISTS jarvis` を起点に `jarvis.events`、`jarvis.coordination_leases`、worker / scope grant / fenced resource / outbox / revocation 等を作る設計。productionには `jarvis` schemaが存在せず、`public` の既存テーブルとは別構造。両者を同一のmigration履歴として扱わない。
- public objects は `neondb_owner` 所有。テーブルRLSは全て無効、Policy 0件、非内部trigger 0件。
- `jarvis_audit_readonly` は public 5テーブルに SELECT のみ。public USAGE=true / CREATE=false、TEMP=true（継承状態）、superuser / createdb / createrole=false。productionロール一覧は `jarvis_audit_readonly` と `neondb_owner` の2件。
- snapshots 0件、automatic snapshot schedule 0件。production branch protectionもfalse。
- Neon Object Storage と Neon Function Triggers はこのregionで利用不可（region_unavailable）。これはCloudflare R2の可否を意味しない。Cloudflare R2の実アカウント接続・実バケットは未確認。

## Task Registry / Worker 実装ギャップ

PR #78 の `jarvis/server.js` では Task Registry / Execution Kernel / Task Dispatcher を構築できる。一方、次の点が残る。

1. `worker.startPolling()` が起動する既存Workerは `jobStore` のpoller。Task Registryの `dispatchNext()` を周期的に呼び出していない。
2. `createTaskDispatcher` に `dispatchNext()` は存在するが、server startupでTask Registry用pollerは登録されていない。現状のTask dispatchは認証済みの明示的API呼出しに依存する。
3. `dispatchTask()` は権限・scope grant・leaseを検証した後にdepartment handlerを呼び出すが、handler実行直前に全ての高リスクaction classに対するowner approvalを強制する共通ゲートは確認できない。Approval Gateを完成させるまで自動pollerを有効化しない。
4. `JARVIS_STORAGE_MODE=postgres` のstartup pathは `eventStore.migrate()` を呼び、`jarvis` schema / event storeを作成する。さらに `postgres-operational-stores.init()` はindex・trigger・migration recordを作成する。これはruntime startup時の自動DDLである。production deploy前に、runtimeをschema check-onlyへ分離し、migrationを独立した明示承認付き工程にする必要がある。
5. Task Registry / Execution Kernel 自体はread-only schema checkを行い、必要なmigrationを自動適用しない。ただしschemaが不足するとstartup / feature initializationが失敗する。

## 音声・動画資産 / R2

- PR #82 の `asset-gateway.js` にはCloudflare R2 S3 adapter（PutObject / HeadObject / GetObject）、MIME signature検証、SHA-256計算、アップロード後metadata照合、ダウンロード時のSHA-256再計算が実装されている。
- PR #82のテストはfake object storeを使うunit test。PR #82はAsset Gateway / test / migrationの3ファイルで、server runtimeへの実接続、R2 bucketへの実upload/download/restoreは確認できない。
- PR #27の `saveNarrationAsset` はfileName / MIME / duration / SHA-256等のmetadataをJSONL journalへ保存する。音声バイナリ本体をR2等へ保存する処理ではない。
- video-batch storeは絶対パスのfilePathを要求し、append + fsyncを行うが、Render側の耐久ディスクは未確認。metadata journalと実バイナリ保存を混同しない。
- 実ファイル保存、MIMEのサーバー側検査、保存後の再取得、サーバー側SHA-256再計算、append-only asset ledgerとの原子的連携は未実証。

## 外部制作・分析サービス

- Descript: project 3件、最近のjobs 0件。
- HeyGen: video library 0件。
- vidIQ: 接続チャンネル「時をかける日本史 世界史」1 subscriber / 0 views / 0 public videos。
- Metricool: YouTube brandあり。2026-11-26〜2026-12-03のscheduled posts 0件。
- fal: 今回は再確認していない。以前の残高ブロックを今回の状態として扱わない。
- Google Sheets: server codeにSheets URL/token設定の入口はあるが、今回の接続試験は未実施。設定値は読み取っていない。

## 次工程の判断

最優先は本番DB変更ではなく、隔離PostgreSQL 16/18で以下を証明すること。

1. runtime startupから自動DDLを切り離す設計とテスト。
2. `public` legacy schema と `jarvis` Task Registry schemaの明示的な共存・移行計画。
3. Task Registry専用pollerの設計。ただし owner approval / action class allowlist / kill switch / lease fencing / retry / dead-letter / graceful shutdownを先にテストする。
4. fake R2から実R2へ進む前に、非本番bucketでのupload→HEAD→download→SHA/MIME再検証→ledger commitのテスト計画を作る。実uploadは別途承認待ち。
5. main / foundation branch protectionとNeon production protection / snapshotsは別途承認付きで整備する。

本番Migration、Render deploy、env変更、課金、実R2 upload、外部公開は未承認のため実施しない。
