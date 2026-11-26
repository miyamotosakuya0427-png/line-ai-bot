# ONE JARVIS 第9段階・第3工程 監査記録

監査日: 2026-11-21
対象: `miyamotosakuya0427-png/line-ai-bot`
Render workspace: `朔也's workspace`
対象サービス: `one-jarvis` (`srv-dbsmf9m1egvs73e9gej0`)
安全境界: 読み取り専用調査と隔離ブランチ上の文書追加のみ。本番DB変更、マージ、Render設定変更、デプロイ、外部アップロード、公開、課金操作は行わない。

## 1. Executive summary

- Render workspaceのPostgreSQL一覧は空で、Render管理下のPostgresインスタンスは見つからなかった。JARVISのNeon DBとは別のサービスである。
- Render `one-jarvis` は `not_suspended`、Free、Singapore、Node.js、1インスタンス設定。Auto DeployはOFF、Health Check Pathは未設定。
- 24時間指定のCPU・メモリメトリクスでCPUサンプルは1点のみ、メモリサンプルは6インスタンスIDにまたがる7点。CPU/メモリの上限値はそれぞれ0.15 CPU、536,870,900 bytes（約512 MiB）。観測されたメモリ最大値は119,062,530 bytes（約113.6 MiB）。この疎なサンプルから平均・ピーク・継続的安定性は判定できない。
- 同期間のHTTP request count、HTTP latency、instance_countは空。HTTP正常性・実利用量・再起動回数はこのメトリクスだけでは確認できない。
- 現在のLive deployは2026-11-15に成功した `f3d6203c236257fc1248d03d092d4202eaf8bd66`。サービスのデプロイbranchは `one-jarvis-foundation`。既知のbranch HEADはデプロイ済みcommitより3 commits先行していた。Auto Deploy OFFのため、GitHubの変更が自動反映される前提にしてはならない。
- PR #82はCloudflare R2対応Asset GatewayのDraft実装で、Fake Object Storeによるテストは成功しているが、実R2 bucket接続・実ファイル転送・Neon Asset Registry書き込み・復元試験は未実施。
- Neonの既存DBは `public` schemaを使用し、現在のPR #43/#48/#50/#71/#73のmigration chainは `jarvis` schemaを新規作成する設計。現行DBの `public.jarvis_*` テーブル群と同一の台帳ではない。既存Neonにmigration 0001-0006をそのまま適用すると並行schemaを作る可能性があり、適用禁止。
- PR #73は隔離PostgreSQL 16でmigration 0001-0006の連続適用・2回目再適用を検証し、260 tests passed / 0 failed / 0 skipped。ただし、これは現行Neon schemaとの互換性や本番適用を証明しない。

## 2. Render read-only findings

### Service configuration

| 項目 | 観測値 |
|---|---|
| Service | one-jarvis |
| Service ID | srv-dbsmf9m1egvs73e9gej0 |
| URL | https://one-jarvis.onrender.com |
| Region / Plan | Singapore / Free |
| Runtime | Node.js |
| Branch | one-jarvis-foundation |
| Instances configured | 1 |
| Suspended | not_suspended |
| Auto Deploy | no / off |
| Health Check Path | 未設定 |
| Build command | cd jarvis && npm install |
| Start command | cd jarvis && npm start |
| Latest live commit | f3d6203c236257fc1248d03d092d4202eaf8bd66 |
| Latest live deploy | 2026-11-15T14:44:32Z |

Render workspaceのPostgres一覧は `No Postgres instances found`。Render上にPostgreSQLを作成・追加していない。Neonは別管理のDBとして扱う。

### Metrics window

取得期間: 2026-11-20T13:41:48Z ～ 2026-11-21T13:41:48Z、resolution 900 seconds。

- CPU usage: 1 sample、0.00013725556 CPU（2026-11-21T09:00:00Z）
- CPU limit: 0.15 CPU
- Memory usage: 7 samples。最小値48,717,824 bytes、最大値119,062,530 bytes
- Memory limit: 536,870,900 bytes（約512 MiB）
- HTTP request count: no data
- HTTP latency: no data
- Instance count: no data

注意: CPU/Memoryの値は疎なサンプルであり、常時監視の代替ではない。instance IDが複数観測されたことだけから、再起動・障害・スケールアウトを断定しない。

### Operational implications

1. RenderのHealth Check Pathを設定する案はあるが、現行アプリのreadiness endpointと依存サービス確認条件を先に監査する。設定変更は別途承認後。
2. Auto DeployはOFFのまま維持し、PR branchを本番Renderへ接続しない。
3. FreeプランのCPU/メモリメトリクスに依存したSLO判断をしない。一定期間のメトリクス収集とHTTP synthetic checksを設計する。
4. Render Postgresは存在しない。Neonを唯一の永続DB候補として扱うが、schema lineageを解決するまでDB migrationを実行しない。

## 3. Neon migration lineage blocker

### Live Neon branch observations (read-only)

- `production`: public schemaのみ、5 tables、`public.schema_migrations` はversion `001` のみ
- `one-jarvis-stage3-audit-20261121`: public schemaのみ、5 tables、`public.schema_migrations` はversion `001` のみ
- `one-jarvis-stage5-market-data-20261121`: public schemaのみ、12 tables、`public.schema_migrations` はversion `001` のみ
- 3 branchesとも `jarvis` schema / `jarvis.schema_migrations` は見つからなかった。
- Stage5にはmarket-data tablesと `public.market_data_audit_events` が存在する一方、確認したmigration directoryの0001-0006にはこれらを生成するSQLが含まれていない。

### PR migration chain

PR #73 branch `audit/one-jarvis-full-migration-chain` contains:

1. `0001_neon_event_store.sql`: `CREATE SCHEMA IF NOT EXISTS jarvis`; `jarvis.schema_migrations`; `jarvis.events`
2. `0002_job_approval_stores.sql`: indexes on `jarvis.events`
3. `0003_append_only_event_ledger.sql`: append-only triggers on `jarvis.events`
4. `0004_task_registry.sql`: `jarvis.coordination_leases` and task indexes
5. `0005_task_registry_scoped_dedupe.sql`: scoped dedupe index replacement
6. `0006_scheduling_reservation_store.sql`: reservation indexes on `jarvis.events`

PR #73 PostgreSQL 16 integration test runs all six migrations in order, re-applies all six, and verifies the six migration ledger entries in an isolated local test database. It is a good isolated migration-chain test, not evidence that these migrations match the current Neon production schema.

### Mandatory gate

Do not apply migrations 0001-0006 to any current Neon branch until a schema reconciliation plan is reviewed. Required work:

- Compare actual public table DDL, columns, indexes, constraints, triggers, functions, grants and ownership against all code paths.
- Decide whether `public.jarvis_*` tables are canonical, whether `jarvis.*` is intended to replace them, or whether an explicit data-preserving migration is needed.
- Produce a table-by-table mapping and preserve market-data tables and audit history.
- Check migration history integrity, duplicate/idempotency conflicts, row counts and backup/restore readiness.
- Design a staged migration with preflight, dry run, lock/timeout limits, verification queries, forward recovery and rollback-by-restore. No production execution in this phase.

## 4. Asset Gateway / R2 status

PR #82: https://github.com/miyamotosakuya0427-png/line-ai-bot/pull/82

- Isolated branch: `feature/one-jarvis-r2-asset-gateway-20261121`
- Draft PR based on CI fix PR #80.
- Adds AWS SDK v3 S3 adapter configured for R2 endpoint / region auto, bounded media validation, SHA-256 checks, and required `commitAssetMetadata` callback for atomic Asset Registry + audit metadata persistence.
- Fake in-memory store tests and CI passed: JARVIS 243 passed, 0 failed, 2 skipped; Apps Script 5 passed, 0 failed.
- No real R2 bucket, credential, upload, download, Neon write, Render setting, or external media action was used.
- Buffer-based 100 MiB default limit is not a streaming large-media architecture.
- R2 is a candidate provider, not an operationally verified durable asset store. Before live use: bucket-scoped credentials, least privilege, versioning/retention, encryption, object lifecycle, upload/download integrity, delete protection, backup/export and restore rehearsal.

## 5. CI and integration architecture

- PR #80 fixes dependency installation in three JARVIS workflow files. At its observed head, all three workflows passed; the JARVIS suite is duplicated across three workflows, creating avoidable CI time and maintenance overhead.
- PR #82 also passed all three workflows. The two skipped JARVIS tests require a real database configuration; the dedicated PostgreSQL 16 integration workflow in the Task Registry lineage passed separately.
- PR #50 PostgreSQL 16 integration success must not be conflated with the earlier generic test run that failed due missing `pg` dependency. PR #80 addressed dependency installation; DB-dependent tests without a DB remain skipped.
- Do not merge stacked PRs solely by PR number. Validate exact Base/Head SHA and transitive branch ancestry; all current implementation PRs remain Draft/Open.

## 6. Video pipeline readiness

The inspected `jarvis/video/workflow.js` and README describe a pure Node input-validation/state-transition module, not an end-to-end production pipeline. The inspected server/core paths do not establish a live adapter chain for HeyGen, Descript, fal, vidIQ, Metricool, R2 or YouTube publishing.

Connector account availability is not equivalent to deployed JARVIS credentials or API integration. No video generation, editing, upload, scheduling or publishing was performed in this stage. fal generation is currently blocked by account credit availability; Descript project state and previous edit/preview results need a separate human QA pass.

Required architecture before production:
- one durable job/task record with idempotency and approval state;
- provider adapter interfaces with per-provider credential isolation and timeout/retry policies;
- immutable asset metadata and SHA-256 linkage to every generated source/output;
- audio/video duration, codec, caption and visual QA gates;
- human approval before external publishing;
- publish result reconciliation and Metricool analytics ingestion;
- no blind retries after unknown provider outcomes.

## 7. Stage 9 / Stage 3 decision log

| Area | Status | Decision |
|---|---|---|
| Render PostgreSQL | Not found | Use Neon as separate DB candidate; do not create Render DB without separate cost approval |
| Render runtime | Not suspended; latest deploy live | Keep production unchanged; monitor sparse metrics as insufficient |
| Health check | Path unset | Audit app readiness endpoint before proposing config change |
| Auto deploy | Off | Keep off until reviewed integration release |
| Neon schema | public vs jarvis mismatch | Block migrations; reconcile table-by-table |
| Migration chain | 0001-0006 pass isolated PG16 test | Accept as isolated evidence only |
| Asset Gateway | PR #82 Draft, CI green | Keep Draft; require R2 live test and Neon metadata contract |
| Video providers | ChatGPT connectors available, app pipeline incomplete | Build adapters only after durable task/asset/approval contract |
| CI | Three duplicate workflows | Consolidate after confirming triggers and required checks; do not remove required checks prematurely |

## 8. Next execution order

1. Complete Neon public-schema DDL inventory and compare it with migration 0001-0006 and Stage5 market-data tables.
2. Produce a reviewed schema mapping and migration plan; include RLS/least-privilege roles and append-only audit ownership.
3. Add migration failure-injection and restart/recovery tests on isolated PostgreSQL 16.
4. Reconcile Task Registry / Worker Registry / Lease / Fenced Writer / Audit contracts on one integration branch without rewriting existing PR branches.
5. Define Asset Registry DDL and an atomic transaction that writes asset metadata + append-only audit event; connect it to the Asset Gateway callback only in isolated tests.
6. Add R2 integration tests using a separately approved test bucket and bucket-scoped test credentials; prove round-trip, checksum mismatch, retention/versioning and restore.
7. Audit Render readiness/health endpoint, add synthetic request tests, and establish a metrics baseline. Keep production config untouched.
8. Consolidate duplicate CI workflows only after documenting branch/path filters and required-check names.
9. Implement video-provider adapters and human QA/publishing gates as isolated PRs.
10. Request human review; keep all PRs Draft/Open until the owner explicitly approves merge/deploy and any paid resource use.

## 9. Safety confirmation

No Neon writes or migrations, Render configuration changes, service restarts, deployments, environment-variable reads/changes, new database creation, R2 bucket creation, credentials, uploads, paid media generation, video publishing, PR merges or main-branch changes were performed.
