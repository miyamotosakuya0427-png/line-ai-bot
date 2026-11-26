# ONE JARVIS 第9段階・第4工程 実装計画

更新日: 2026-11-26
対象PR: #84
基準: PR #78 headから分岐した隔離featureブランチ

## 目的

ONE JARVISのPostgreSQL runtime startupからDDL/DMLを排除し、Migrationを明示的なローカル/CI専用工程へ分離する。そのうえでTask Registry専用WorkerとApproval Gateを、本番に影響しない隔離環境で検証する。

## 今回の設計判断

### PostgreSQL起動とMigration

- Runtime startupは既存schema、migration version、必須trigger/indexの存在確認のみを行う。
- health()、init()、append()、list()はMigrationを暗黙実行しない。
- Migrationはjarvis/scripts/migrate-postgres.jsからのみ明示実行する。
- CLIはlocalhost、127.0.0.1、::1に限定し、リモートDBを拒否する。
- 各Migrationファイルを個別transactionで適用し、失敗時はrollbackする。
- 適用後にschema_migrationsのversionを照合する。
- GitHub ActionsはPostgreSQL 16と18の両方で0001〜0010を検証する。

### Task Registry専用Worker

- 既存jobStore Workerとは別モジュール・別feature flagにする。
- デフォルト無効。Worker scope grantとAgent revocation確認が必須。
- Agent / Project / Conversationの固定scopeを持つ。全scope横断のunscoped pollingは禁止。
- 1回のpollで処理するtask数に上限を設け、overlapを禁止する。
- Atomic Claim、Lease heartbeat、Fencing tokenは既存Dispatcher/Execution Kernelを利用する。
- Kill Switch、Graceful Shutdown、bounded exponential backoff、失敗監査を実装する。
- Lease喪失や実行結果不明は自動再実行せず、outcome_unknownとして隔離する。
- Dead Letter相当の最終隔離状態と再投入権限は別途設計・試験する。

### Approval Gate

- TaskのactionClassは明示必須とし、未指定・不明はunknownとして拒否する。
- 自動実行候補はread、analyze、draft、internal_taskに限定する。
- external_submit、financial、contract、publish、delete、permission_change、unknownは承認なしに実行しない。
- 承認対象はTask IDだけでなくresourceId、operationPayload、期限、digestに結び付ける。
- 実行時に承認済みdigestと実際の操作payloadが完全一致しなければ停止する。
- 承認の一回限りのclaimと実行結果確定を必須にする。
- Handlerが自己申告で安全Actionへ格下げすることは禁止する。

## 現在の実装状況

- postgres-event-store.health()はread-only schema checkへ変更。
- postgres-event-store.append() / list()はMigrationを暗黙実行せず、schema checkを行う。
- postgres-operational-stores.init()はread-only schema checkへ変更。
- Operational migrationsは明示的migrate()へ分離。
- server.jsのPostgreSQL startupはassertSchema()のみを呼ぶ。
- Loopback限定Migration CLIを追加。
- PostgreSQL 16/18のCI matrixと、0001〜0010の隔離DB検証を追加。
- PR #84はDraft。PR #78へのマージ、本番DB変更、Render deployは行わない。

## 未完了・次の実装順

1. PostgreSQL 16/18の最新CI結果を確認し、Migration runnerとread-only startupの不具合を修正する。
2. Task Registry専用WorkerのTDD実装（disabled default、scope固定、single-flight、kill switch、shutdown、retry/backoff）。
3. Dispatcherに外側AbortSignalを伝播させ、停止時にhandlerが協調停止できるようにする。
4. Task payloadにactionClass、approvalId、resourceId、operationPayloadを追加し、default unknownでfail-closedにする。
5. Approval GateをDispatcherのHandler呼び出し前に強制し、digest一致と一回限りのexecution claimを検証する。
6. PostgreSQL 16/18で複数Worker、重複claim、lease切れ、revocation、approval拒否、kill switch、shutdownを検証する。
7. Fake Object StoreでR2 Asset Gatewayのupload/HEAD/download/MIME/SHA-256とappend-only ledger連携を検証する。

## 禁止事項

既存LINE本番、Neon production、Render設定・deploy、main、PR merge、環境変数/秘密情報、課金、R2実バケット、動画生成、外部投稿・公開、データ削除には触れない。必要な場合は実行せず、代表者の明示承認を待つ。


## Parent branch synchronization

2026-11-26: PR #85 base was synchronized to the latest PR #78 head `38bb5fbc739d16eb6d082107727f409479b5b3ed` after the concurrent integration branch completed its CI successfully. No parent files were overwritten.
