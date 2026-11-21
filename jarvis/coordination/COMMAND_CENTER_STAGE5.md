# ONE JARVIS Command Center — Stage 5

## Implemented on the isolated PR branch

### Durable Event Outbox
- Migration `0009_task_event_outbox.sql` creates a durable Task-event outbox and per-Project/Conversation cursor counter.
- The `jarvis.events` AFTER INSERT trigger writes the outbox row and advances its scope cursor in the same transaction as the append-only Task event.
- A transaction-scoped advisory lock serializes cursor allocation within a Project/Conversation; the counter update rolls back with the Task event, avoiding false gaps caused by sequence rollback or out-of-order commits.
- PostgreSQL NOTIFY carries only the scoped cursor as a wake-up hint. Event bodies are read from durable `jarvis.events` joined through the Outbox.
- Outbox replay checks future cursors and contiguous per-scope cursor progression. Outbox rows are protected against UPDATE / DELETE / TRUNCATE.
- Replay is bounded and validates Project / Conversation scope. The listener is a wake-up optimization; polling replay remains the recovery path for lost notifications.

### Authenticated SSE
- `GET /v1/command-center/events` requires the Dashboard API token and a Task Registry credential in `X-Task-Registry-Authorization`.
- Project and Conversation are checked against the authenticated principal at connection time and every 15 seconds while connected.
- Supports `Last-Event-ID` and the `after` query parameter for fetch-stream reconnects; duplicate cursors are skipped and ordered replay is sourced from the Outbox.
- SSE frames use an allowlist of event payload fields; credential hashes, secrets, and lease tokens are not serialized.
- Heartbeats, bounded output batches, backpressure timeout, per-agent/global connection caps, shared rate limiting, listener cleanup and polling fallback are implemented.
- Global connections are capped at 3 and each Agent at 1 to preserve capacity in the current PostgreSQL pool (max 5).
- The dashboard uses fetch streaming because browser EventSource cannot attach the required authorization headers. It retains 15-second polling as fallback.

### Worker Grant management
- Owner-only `GET /v1/admin/worker-scope-grants` lists active and revoked grants, grantor/time, Worker state, current Task and Lease expiry.
- Grant create/revoke operations require Owner authentication and `ownerApproval: true`; the dashboard additionally prompts for explicit confirmation.
- Grant/revoke audit events remain append-only.
- API/UI responses omit secrets, credential hashes and fencing tokens.
- Grantor is still recorded as the role label `owner-token`, not a named human identity.

### Handoff guard
- Task Registry now rejects same-department transfers, repeated department visits and routes exceeding eight handoffs.
- Unit tests cover same-department, cycle, maximum-hop and valid new-department routes.
- Existing Dispatcher `handoffTask` remains explicit; automatic department-handler routing is not yet integrated.

## Verification boundary and remaining work
- CI must pass on the exact latest PR Head before this stage can be called verified.
- Migration 0009 is included only in the isolated PostgreSQL 16 CI test setup. It is not auto-applied by server startup and has not been applied to production Neon.
- Until the migration is separately reviewed and applied through an approved production change, SSE replay fails closed with 503 and the dashboard keeps authenticated 15-second polling.
- Task Registry token expiry is rechecked every 15 seconds. The current authorizer loads token configuration at process startup; a config-level revocation change is not dynamically visible until restart. A live revocation source remains a security follow-up.
- Automatic department-handler handoff routing and full concurrent handoff integration tests remain incomplete.
- Real physical iPhone and desktop browser tests have not been performed; only responsive CSS and automated DOM/script checks are included.
- No production deployment, database migration, Render change, LINE send, Sheets write, paid API, external publication, merge, rebase or force-push is performed by this PR work.
