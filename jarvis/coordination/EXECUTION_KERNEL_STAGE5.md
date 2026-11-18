# ONE JARVIS Stage 5 — Task State Machine and Dispatcher foundation

This branch is stacked on PR #76 and is intentionally additive. It does not rewrite prior Task or Reservation event history and does not add or apply a migration.

## Implemented in this stage branch

- Canonical Task states: `pending`, `queued`, `claimed`, `running`, `waiting`, `waiting_approval`, `retry_wait`, `completed`, `failed`, `cancelled`, `outcome_unknown`, and `quarantined`.
- Explicit legacy-state mapping: `proposed` → `pending`, `ready` → `queued`, `in_progress` → `running`, `blocked` → `waiting`, `review` → `waiting_approval`, and `verified` → `completed`. Existing event payloads remain immutable; new snapshots carry canonical `state` alongside the compatibility `status`.
- Task Registry transitions validate canonical state edges and optimistic aggregate version. Existing Lease/Fencing checks remain mandatory.
- Parent/child relationship is represented by immutable `parentTaskId` on task creation. Parent completion is serialized against child creation/completion and rejected until every child is completed.
- `outcome_unknown` cannot transition to retry. Resolving it as completed/failed requires explicit reconciliation ID and operator identity.
- Dispatcher library reads tasks from Task Registry, revalidates project/conversation authorization before claim, checks eligibility, selects an authorized department Worker, applies a required shared rate limiter, then calls atomic `claimTaskForWorker`. It heartbeats the Task Lease and Worker, uses an injected fenced result writer, and quarantines ambiguous execution/persistence errors as `outcome_unknown`.
- A non-overlapping recovery scheduler invokes the existing PostgreSQL recovery API in bounded batches.
- Configured Task Registry API instances now require an explicitly injected limiter. In-memory limiting is exported for unit fixtures only; PostgreSQL integration uses the shared PostgreSQL limiter.

## Validation added

- Unit tests for canonical state vocabulary, legacy mapping, invalid transitions, and unknown-outcome restrictions.
- Dispatcher ordering, authorization denial, shared-quota gating, fenced-result requirement, and ambiguous-outcome tests.
- Recovery scheduler bounded-batch, overlap, error-hook, and lifecycle tests.
- PostgreSQL 16 Task Registry integration coverage for parent/child completion and explicit unknown-outcome reconciliation.
- Existing PostgreSQL 16 API integration is extended to use the shared PostgreSQL rate limiter and migrations 0001–0007 in its isolated test database.

## Explicit remaining blockers — not production-complete

- Dispatcher is a composable library and is **not yet wired into the production server's department execution path**. Existing department-specific dispatchers/handlers on other PR branches remain separate and were not modified.
- The injected `authorizeTask` and `resultWriter` contracts are host-supplied. The PostgreSQL Fenced Writer does not yet atomically revalidate a live token's expiry/revocation, Project/Conversation membership, and operation authorization against a revocation source in the same transaction as the write.
- The production server still needs to construct/inject the PostgreSQL shared limiter and Dispatcher from its PostgreSQL pool. This branch does not change production environment variables or enable Task Registry runtime.
- Recovery scheduler is opt-in and not started by the production server. Recovery does not yet atomically classify every expired in-flight external operation as `outcome_unknown`.
- Reservation Runtime still does not receive/verify the same Worker fencing token at the external provider boundary. Providers without atomic idempotency/fencing remain fail-closed and are not called by this branch.
- Explicit Retry-vs-completion multi-process race, token revocation during a write, DB disconnect/reconnect, all expiry boundaries, and parent/child multi-worker race permutations still need PostgreSQL 16 tests.
- No external GitHub, LINE, Google Sheets, Render, Binance, or booking-provider operation is protected merely by the internal fenced-resource journal.

## Safety boundary

- No production Neon writes/migrations, Render changes/deployments, LINE sends, Apps Script/Sheets writes, external bookings, paid APIs, trading/transfers, tax actions, publication, deletion, or secret access.
- Migration 0007 remains unapplied automatically.
- This stage must be reviewed and merged only by a human later; PR remains Draft/Open/unmerged.
