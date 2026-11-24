# ONE JARVIS 本番Neonスキーマ実査・自律Worker接続前提

調査日: 2026-11-25 08:12 JST  
対象: `miyamotosakuya0427-png/line-ai-bot`  
Neon Project: `one-jarvis` (`super-fog-73704467`)  
Neon Branch: `production` (`br-floral-field-a71odam5`)  
Database: `neondb`  
対象PR: #83（監査資料。Draft / Open / Unmerged）  
安全境界: Neonは読み取り専用のカタログ・集計SELECTのみ。GitHub変更は本監査ブランチへの文書追加だけ。DB、Render、LINE、外部サービスへの書込み・送信・課金・デプロイは行わない。

## 1. 結論

本番Neonの実体は `public` schemaにある既存のJob / Approval / Audit構造であり、PR #78のTask Registry・Worker Registry・Fenced Execution用migration chainが前提とする `jarvis` schemaとは一致しない。

PR #78ブランチのmigration `0001` は `CREATE SCHEMA IF NOT EXISTS jarvis` を実行し、以降のmigrationも `jarvis.*` を作成・参照する。一方、production branchのカタログ調査では `public` schemaと以下5テーブルだけが確認でき、`jarvis` schemaは確認できなかった。productionの `public.schema_migrations` に記録されていたversionは文字列 `001` の1件のみであり、PR #78の `jarvis.schema_migrations` に記録する `0001`〜`0010` と同一のmigration履歴ではない。

**したがって、PR #78のmigration 0001〜0010をproductionへそのまま適用してはならない。** 既存publicテーブルのデータ・制約・トリガー・権限を保全した上で、publicからjarvisへの移行または明示的な共存設計を先に確定する必要がある。

## 2. productionの実テーブル

2026-11-25 08:12 JST時点で確認した非システムテーブル:

| Schema | Table | 種別 |
|---|---|---|
| public | jarvis_jobs | BASE TABLE |
| public | jarvis_job_attempts | BASE TABLE |
| public | jarvis_approvals | BASE TABLE |
| public | jarvis_audit_events | BASE TABLE |
| public | schema_migrations | BASE TABLE |

### public.jarvis_jobs

- `id uuid NOT NULL DEFAULT gen_random_uuid()`
- `idempotency_key text NOT NULL`（UNIQUE）
- `request_hash character NOT NULL`
- `type varchar NOT NULL`
- `payload jsonb NOT NULL DEFAULT '{}'`
- `status varchar NOT NULL DEFAULT 'queued'`
- `attempts integer NOT NULL DEFAULT 0`
- `max_attempts integer NOT NULL DEFAULT 5`
- `run_after timestamptz NOT NULL DEFAULT now()`
- `locked_at timestamptz NULL`
- `created_at / updated_at timestamptz NOT NULL DEFAULT now()`
- `completed_at timestamptz NULL`
- Index: PK(id), UNIQUE(idempotency_key), claim(status, run_after, created_at)
- CHECK: attempts >= 0、max_attempts 1〜20、statusはqueued/running/succeeded/failed/cancelled

### public.jarvis_job_attempts

- `id bigint`（sequence）
- `job_id uuid NOT NULL`（jarvis_jobs(id)へのFK、ON DELETE CASCADE）
- `attempt_no integer NOT NULL`
- `status varchar NOT NULL`
- `error_code / error_message varchar NULL`
- `started_at timestamptz NOT NULL DEFAULT now()`
- `finished_at timestamptz NULL`
- UNIQUE(job_id, attempt_no)、PK(id)
- CHECK: attempt_no >= 1、statusはrunning/retrying/succeeded/failed

### public.jarvis_approvals

- `id uuid`、`idempotency_key text`、`job_id uuid NULL`
- `requested_by varchar NOT NULL`、`action varchar NOT NULL`
- `payload jsonb NOT NULL DEFAULT '{}'`
- `status varchar NOT NULL DEFAULT 'pending'`
- `reviewed_by / decision_reason varchar NULL`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `reviewed_at timestamptz NULL`
- UNIQUE(idempotency_key)、PK(id)、job_id FKはON DELETE SET NULL
- CHECK: pendingならreviewed_at IS NULL、approved/rejected/expiredならreviewed_at IS NOT NULL

### public.jarvis_audit_events

- `id bigint`（sequence）、`event_id uuid NOT NULL`（UNIQUE）
- `actor varchar NOT NULL`、`action varchar NOT NULL`
- `resource_type varchar NOT NULL`、`resource_id varchar NULL`
- `metadata jsonb NOT NULL DEFAULT '{}'`
- `created_at timestamptz NOT NULL DEFAULT now()`
- Index: PK(id)、UNIQUE(event_id)、(resource_type, resource_id, created_at)

### public.schema_migrations

- `version text NOT NULL`（PK）
- `applied_at timestamptz NOT NULL DEFAULT now()`
- 読み取り結果: version `001` が1件

## 3. レコード状況（集計のみ）

- `public.jarvis_jobs`: status別集計で行なし
- `public.jarvis_approvals`: status別集計で行なし

個別payload、利用者情報、監査metadataの内容は取得していない。行数が0であることは、テーブル構造やmigration互換性を証明しない。

## 4. PR #78のmigration chainとの相違

PR #78 head `bb1da1f45af775167ced68a10036319226c58a85` の `jarvis/migrations` には以下が存在する。

| Migration | 主な追加内容 | 対象schema |
|---|---|---|
| 0001 | events、jarvis.schema_migrations | jarvis |
| 0002 | eventsのJob / Approval検索index | jarvis |
| 0003 | append-only event ledger | jarvis |
| 0004 | coordination_leases、Task関連index | jarvis |
| 0005 | scoped dedupe | jarvis |
| 0006 | scheduling / reservation index | jarvis |
| 0007 | worker_registry、fenced_resources、fenced_operations、api_rate_limit_buckets | jarvis |
| 0008 | worker_scope_grants | jarvis |
| 0009 | task_event_outbox、scope cursor | jarvis |
| 0010 | task_registry_agent_revocations | jarvis |

既存 `public.jarvis_jobs` 等を同名の新テーブルへ直接置き換えるmigrationではない。publicの既存データをjarvisへどう引き継ぐか、二重書込み期間を設けるか、どの時点で読取先を切り替えるかは未確定。

## 5. 自律Task Workerの実装・稼働状態

PR #78の `jarvis/server.js` を確認した結果:

- `JARVIS_TASK_REGISTRY_API_ENABLED=true` は `JARVIS_STORAGE_MODE=postgres` を要求する。
- Task RegistryとExecution Kernelの初期化はschema checkであり、migrationを自動適用しない。
- Task DispatcherはTask Registry、Execution Kernel、Revocation Store、共有Rate Limiterがそろった場合だけ構築される。
- 既存の `worker.startPolling()` はlegacy `jobStore` を処理するWorkerであり、PostgreSQL Task RegistryのTaskを定期claimしてDispatcherへ渡すpollerではない。
- よって、PR #78のコードが存在することと、Task Registryの自律バックグラウンド実行が稼働していることは同義ではない。
- Task Registry用pollerを追加する前に、DB schemaの整合、Agent / Project / Conversation scope、Worker Scope Grant、lease fencing、revocation、停止・再試行・重複実行防止を統合試験する必要がある。

## 6. Render / GitHubとの接続前提

- Render `one-jarvis`: Free / Singapore / Node.js / 1 instance / branch `one-jarvis-foundation` / Auto Deploy OFF / Health Check Path未設定。
- Live deploy commit: `f3d6203c236257fc1248d03d092d4202eaf8bd66`（2026-11-15）。
- GitHub `one-jarvis-foundation` HEAD: `95b2570e41149c8cbde512c33db9b7cffe184b09`。Live commitから3 commits ahead。
- Render workspaceのPostgres一覧は空。NeonはRenderとは別サービス。
- 永続ディスクの有無は今回の返却情報だけでは確認できない。
- 24時間メトリクスはCPU 2点、Memory 3点のみ。HTTP request count / latency / instance countは空。Error level app logは指定時間帯で0件、Render service eventsも0件。疎なデータのため、継続的な稼働健全性は判定できない。
- GitHub main HEAD: `3bfd3781ae7dc9d4be8d868383a1aaa388d50673`。Branch APIではprotected=false、Repository rulesetsは空。
- Open PRは65件で、今回の一覧では65件すべてDraft。PR #78は214 commits / 35 filesで、現在headの3 checksはsuccess。PR #83は2 checks success。PR #82と#80は各3 checks success。CI成功はproduction migrationや実サービス接続の証明ではない。

## 7. 次の安全な実行順序

1. publicの5テーブルについて、DDLだけでなくtrigger、RLS、GRANT、所有者、sequence、FK依存を読み取り専用で追加調査する。
2. migration 0001〜0010の全DDLをpublicの実体と比較し、列・制約・index・データ変換・権限の対応表を作る。
3. 既存データを保全する移行案を最低2案（public拡張案 / jarvis新schema共存案）作り、切替・ロールバック・二重書込み・再実行時の冪等性を比較する。
4. その案を隔離PostgreSQL 16/18環境でテストし、production Neonへは一切適用しない。
5. schema整合後に、Fake Handlerと隔離DBだけでTask Registry pollerのclaim / lease heartbeat / lease loss / duplicate suppression / retry / DLQ / graceful shutdown / approval gateを検証する。
6. 本番Neon migration、Render接続設定変更、デプロイ、永続ディスク変更は代表者の別途明示承認まで実施しない。

## 8. 未確認・制約

- productionのtrigger、RLS、GRANT、テーブル所有者、全migration実行履歴の完全性は未確認。
- Render永続ディスクの有無、実際の環境変数値、DB接続先は未確認（秘密情報は取得していない）。
- Cloudflare R2の実bucket round-trip、Asset Gatewayの実ファイル保存・復元・サーバー側checksum検証は未確認。
- この資料は読み取り専用観測結果であり、migration適用許可や本番稼働承認ではない。
