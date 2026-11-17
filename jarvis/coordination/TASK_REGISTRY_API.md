# Task Registry v1 — API contract

The implementation is intentionally opt-in. Call `createTaskRegistry({ pool })` only from a future authenticated service integration after migration 0004 is applied to an isolated test DB and reviewed.

API:
- `init()`: verifies the event store and migration-created lease table; it does not run migrations.
- `createTask(input)`: creates a UUID task aggregate, idempotent by dedupe key.
- `getTask(taskId)` / `listTasks(options)`: read current task projections from the append-only event stream.
- `acquireLease({resourceKey,ownerId,leaseMs})`: atomically acquires an unowned/expired resource and increments its fencing token.
- `heartbeatLease({lease,leaseMs})`: renews only the current unexpired lease.
- `releaseLease({lease})`: releases only the exact current lease.
- `claimTask({taskId,ownerId,leaseMs})`: claims a task and creates its task lease in one transaction.
- `transitionTask({taskId,expectedVersion,lease,status,patch})`: requires current lease and optimistic aggregate version.

No server routes are added in this phase. Authentication, authorization, route wiring, dashboard, branch/path lock UX, and PostgreSQL integration tests with independent connections remain follow-up work. Do not enable in Render or Neon production.
