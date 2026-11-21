# ONE JARVIS Command Center — Stage 4 implementation and safety status

## Worker Scope Grants (Migration 0008)

Added `jarvis/migrations/0008_worker_scope_grants.sql` as an additive migration. It records Worker, Project, Conversation, grantor, creation time, revocation time, revoker, and version. A partial unique index prevents duplicate active grants for the same Worker/Project/Conversation.

Execution Kernel provides:
- `grantWorkerScope`: owner-authorized grant creation, idempotently returns an existing active grant.
- `revokeWorkerScope`: revokes a grant and writes an append-only audit event.
- `listWorkersForScope`: returns only Workers with an active grant for the exact Project and Conversation.

Task Registry `claimTaskForWorker` requires an active grant matching the Task Project and Conversation. It checks the grant while holding the Worker row lock, in the same transaction as the Lease/claim/Worker binding. Grant revocation takes the Worker row lock before the Grant row lock, matching claim lock order. This serializes revocation against a concurrent claim: either the claim commits before revocation or it observes the revoked grant and fails.

Owner API endpoints:
- `POST /v1/admin/workers/:workerId/scope-grants`
- `POST /v1/admin/worker-scope-grants/:grantId/revoke`

Both require the configured owner bearer token. The API records the authenticated owner role label, not caller-supplied grantor identity. Credentials are never returned.

The telemetry endpoint lists Workers across all authenticated Project IDs only when a matching active Worker Scope Grant exists. It does not enumerate ungranted Workers.

## Dispatcher Handoff Events

Task Registry `recordTaskHandoff` performs a fenced, version-checked handoff:
- Validates current Task Lease, Task version/state, source Agent/Department, Worker binding, and fencing token.
- Serializes idempotency key races.
- Updates Task ownership and department, requeues the Task, expires the prior Lease, and releases the prior Worker in one transaction.
- Appends an `agent_handoff` event with source/destination Agent and Department, source Worker, timestamp, and idempotency key.
- A replay with the same key and same destination returns the prior event; changed target content is rejected.

Dispatcher exposes `handoffTask`, which checks requester scope and target Agent eligibility before calling the Task Registry. This operation is an explicit API for future routing; existing handler execution does not yet automatically choose cross-department handoffs. No automatic handoff is inferred.

## SSE decision: deferred, authenticated polling retained

SSE is intentionally not enabled in this stage. Current Task event storage has durable event IDs, but there is no implemented PostgreSQL LISTEN/NOTIFY publisher, durable scoped cursor/replay contract, or long-lived connection authorization revalidation. Implementing SSE without those pieces could leak events across scopes or lose events during reconnect.

The dashboard continues authenticated 15-second polling. SSE remains blocked until all of the following are implemented and tested:
- Transactional NOTIFY/outbox delivery with durable event cursor.
- Replay from Last-Event-ID restricted to current authenticated Project/Conversation scope.
- Revalidation of Dashboard and Task Registry credentials and scopes during long-lived connections.
- Bounded replay, gap detection, duplicate suppression, ordering, heartbeat, backpressure, and disconnect cleanup.

## Test coverage added in Stage 4

PostgreSQL 16 integration test now applies migration 0008 only to the isolated test database and provisions explicit grants for test Workers. It adds checks for:
- Scoped Worker enumeration.
- Claim denial when no grant exists.
- Claim denial after grant revocation.
- Fenced Task handoff and Worker release.
- Handoff event persistence and idempotent replay.

Full CI results must be read from the exact latest PR Head before claiming this stage validated.

## Remaining gaps

- Owner grant/revoke API has not been connected to a dedicated UI workflow; it remains an owner-token-protected API.
- No production migration was applied.
- SSE / LISTEN / NOTIFY / replay is not implemented; 15-second polling remains.
- Existing Dispatcher does not automatically decide or emit cross-department handoffs; the explicit fenced handoff operation is available.
- iPhone and desktop real-device tests have not been performed.
- Existing 13 formal departments remain unchanged; 3 candidate departments are not registered.

## Safety

No production Neon write/migration, Render config/deploy, LINE send, Sheets change, external publication, paid API, secret disclosure, force-push, rebase, merge, or edits to PR #77/other Worker branches were performed.
