# ONE JARVIS Stage 4 execution kernel

This branch adds a PostgreSQL-backed Worker Registry and a fenced resource snapshot writer. It is deliberately additive: it does not rewrite existing Task Registry, Lease, Worker, reservation, or authentication APIs.

## Database boundary

Migration 0007 creates:
- `worker_registry`: durable worker identity, lifecycle, current task, heartbeat and lease fencing metadata.
- `fenced_resources`: project-scoped resource snapshots with optimistic version and highest accepted fencing token.
- `fenced_operations`: durable operation/idempotency journal.

`createPostgresExecutionKernel({ pool, allowedOperationScopes })` fails closed until migration 0007 is recorded. It never applies migrations.

## Worker flow

1. Existing Task Registry claims a task and obtains `task:<taskId>` lease owned by the worker ID.
2. `bindWorker()` verifies that lease in a transaction and binds the worker to the task.
3. `heartbeatWorker()` requires the same active lease.
4. Worker state transitions use optimistic version checks.
5. `writeResource()` locks and verifies the current lease and worker row in the same transaction as the resource version check, idempotency journal insert, and resource update.

The resource row rejects any fencing token lower than the greatest token previously accepted. A stale operation fails before commit; all writes roll back together.

## Scope

This writer protects only resources stored in `jarvis.fenced_resources`. It does not magically fence external GitHub, Google Sheets, LINE, Render, or third-party provider APIs. Such adapters must independently validate fencing/idempotency atomically at their own write boundary or remain disabled.

## Known gaps

- Existing Task Registry task state vocabulary remains unchanged; no destructive migration to the expanded proposed state vocabulary is performed.
- Claiming a task and binding its Worker row are two calls, not one cross-module atomic transaction. A recovery/reconciliation layer is still needed to repair a crash between them.
- Expired worker heartbeat detection and automated task/lease recovery are not yet activated.
- Rate limiting remains process-local unless a shared limiter is injected.
- A real PostgreSQL 16 multi-process test suite is required before claiming end-to-end concurrency proof.
