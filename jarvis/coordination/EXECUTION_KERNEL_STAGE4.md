# ONE JARVIS Stage 4 execution kernel

This branch adds a PostgreSQL-backed Worker Registry, atomic Task/Worker claim, Lease-fenced resource snapshots, recovery scanning, and an optional shared API rate limiter. It is additive and does not rewrite existing Task Registry or reservation event history.

## Database boundary

Migration 0007 creates:
- `worker_registry`: durable worker identity, lifecycle, current task, heartbeat and lease fencing metadata.
- `fenced_resources`: project-scoped resource snapshots with optimistic version and highest accepted fencing token.
- `fenced_operations`: durable operation/idempotency journal.
- `api_rate_limit_buckets`: hashed per-scope fixed-window counters shared by independent processes.

`createPostgresExecutionKernel({ pool, allowedOperationScopes })` and `createPostgresTaskRegistryRateLimiter({ pool })` fail closed until their required schema exists. Neither applies migrations. Migration 0007 is not applied automatically.

## Atomic claim and Worker lifecycle

`claimTaskForWorker({ taskId, workerId, leaseMs })` performs Task Lease acquisition, Task Registry claim-event append, and Worker binding in one PostgreSQL transaction. If Worker validation or binding fails, the Task event and Lease acquisition roll back together.

The lock order is Task Lease -> Worker row -> Task event. Recovery uses the same Lease -> Worker order to avoid a Worker/Lease lock inversion. `recoverExpiredWorker()` only clears Worker ownership after the persisted Lease has expired and the fencing token still matches. `listExpiredWorkers()` discovers candidates; `recoverExpiredWorkers()` processes them with per-Worker transaction/locking. Recovery appends an immutable `worker_recovered` event to `jarvis.events`.

Heartbeat age is diagnostic only: a stale heartbeat does not revoke an unexpired Lease. Callers must continue renewing the authoritative Task Lease. The recovery scanner does not run on a background schedule by itself.

## Fenced writes and idempotency

`writeResource()` requires both active Task Lease and Resource Lease. It verifies Lease owner/token/expiry, Worker binding/state, Task owner/state/project, operation scope, idempotency key, expected resource version, and fencing token in the same transaction as the snapshot update and operation journal insert.

A replay with identical operation identity/content returns the prior result. A mismatched replay is rejected. The resource row rejects a fencing token below the greatest token already accepted.

This guarantee protects only writes stored through `jarvis.fenced_resources`. It does not fence external GitHub, Google Sheets, LINE, Render, or third-party provider APIs. Those adapters must independently enforce fencing/idempotency atomically or remain disabled.

## Shared rate limiting

`createPostgresTaskRegistryRateLimiter({ pool, limits, windowMs })` atomically consumes shared PostgreSQL buckets for Agent, each authorized Project, Conversation, Worker, and API operation. It can be injected into `createServer({ taskRegistryRateLimiter })`. The API maps quota exhaustion to HTTP 429 with `Retry-After`. The default in-memory limiter remains process-local and is not a cluster-wide guarantee.

## Test boundary

The PostgreSQL integration test refuses non-loopback hosts and database names without `test`, and drops only the `jarvis` schema in that isolated test database. CI uses PostgreSQL 16. It includes ten independent Node.js child processes with separate PostgreSQL pools racing for one Task, one Resource Lease, and a shared Agent quota, plus atomic rollback, expiry/recovery, recovery audit, idempotency, and stale-writer checks.

## Remaining gaps before end-to-end completion

- The expanded Task state vocabulary (`pending`, `queued`, `waiting_approval`, `retry_wait`, `outcome_unknown`, `quarantined`, etc.) and explicit legacy-state mapping are not yet integrated into the existing Task Registry state machine.
- Parent/child completion aggregation, retry-vs-completion arbitration, and durable `outcome_unknown` quarantine are not yet implemented.
- The shared limiter is available for injection; production/runtime construction still needs to supply the PostgreSQL-backed instance. The in-memory default remains local.
- Dispatcher has not yet been switched to Task Registry as its sole task source, nor has its full auth/project/conversation/worker eligibility pipeline been connected to atomic Worker claim.
- Token expiry/revocation and all Project/Conversation/Resource authorization must be revalidated at the Fenced Writer boundary before this is treated as a complete auth integration.
- Reservation Runtime and external providers are not yet proven to validate the same fencing token at their write boundary. Provider calls without verifiable fencing/idempotency must remain fail-closed.
- Recovery APIs are implemented, but scheduling them in a live runtime and classifying ambiguous external outcomes as `outcome_unknown` remain separate work.
