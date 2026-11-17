# ONE JARVIS Neon PostgreSQL foundation

## Scope

This branch adds the first PostgreSQL persistence foundation. It does **not** switch existing JSONL stores to PostgreSQL yet. Existing job, approval, video-batch, paper-trading, and influence-event stores continue using their current file-backed implementations until each receives a separately tested repository adapter and an explicit cutover plan.

## Configuration

- Runtime variable: `DATABASE_URL` (Neon pooled connection string recommended for runtime; direct connection string for migration/admin operations where required).
- `PGSSLMODE` is intentionally not read; TLS verification is enforced by `createNeonPool` (`rejectUnauthorized: true`).
- Keep connection strings in the secret manager only. Never print them, include them in diagnostics, or commit them.
- Free Render filesystems are ephemeral; do not use them as the only source of truth for durable production data.

## Schema and operations

Migration `0001_neon_event_store` creates an append-only event ledger in schema `jarvis`, an idempotency index, and aggregate-version uniqueness. The runtime migration is transactional and idempotent. Event writes use a PostgreSQL transaction, an aggregate-scoped advisory lock, an optional expected-version check, and a unique idempotency key. Reads are ordered and bounded.

Transient SQLSTATEs (serialization failures, deadlocks, temporary connection failures) receive bounded retries. Constraint, validation, authentication, and other permanent errors are not retried. Health output intentionally returns only a generic availability state.

## Current integration status

- PostgreSQL pool and event store module: added.
- Initial SQL migration: added.
- Unit tests using a fake pool: added.
- Existing JSONL store replacement / import-export / dual-write / rollback: **not implemented**.
- Live Neon connection and schema application: **not performed**.
- Render environment variables and deployment: **not changed**.

## Required next phase

1. Run CI on this PR.
2. Add repository adapters and store-level tests for jobs and approvals first, then video batches, paper trading, and influence events.
3. Build a dry-run JSONL import with record counts, checksums, duplicate/conflict report, and no writes by default.
4. Test against a separate Neon branch/database before any production migration.
5. Define dual-write, reconciliation, cutover, and rollback before switching any runtime.
6. Only after explicit approval, set `DATABASE_URL` on the dedicated ONE JARVIS Render service. Do not deploy automatically.


## Migration 0003 — append-only event ledger

The migration sequence is 0001 (schema and event table), 0002 (operational indexes), then 0003 (row UPDATE/DELETE and table TRUNCATE rejection triggers). Operational-store initialization applies 0002 before installing 0003 and records each version idempotently. The standalone SQL file is also exercised twice in the isolated PostgreSQL integration test.

The integration test uses only an ephemeral PostgreSQL 16 service and a disposable database whose name includes `test`. It verifies INSERT and SELECT using a restricted runtime test role, checks that the role has no UPDATE/DELETE/TRUNCATE grants, and verifies that even the table owner is rejected by the row and statement triggers for UPDATE, DELETE, and TRUNCATE.

The current application connection still performs initialization using the configured `DATABASE_URL`; production must not be considered hardened until migration ownership is separated from the runtime role, least-privilege grants are applied deliberately, and privileged DDL is monitored. A superuser or schema/table owner can alter or disable triggers. No live Neon database has been migrated by this change.


## Worker retry and lease recovery policy

Worker retries are bounded by `maxAttempts` and use exponential delays (default 1 second base, capped at 60 seconds). A handler error is retried only when it sets both `retryable: true` and `retrySafe: true`; this is an explicit assertion that the provider confirmed no effect or the operation is protected by a stable idempotency key. A retryable error without `retrySafe` is recorded as `outcomeUnknown` and is not automatically replayed.

An expired PostgreSQL lease is recorded as failed with `outcomeUnknown: true`; it is not automatically reclaimed by another worker. The previous lease owner cannot heartbeat or change the job after expiry. A job can be requeued only after explicit reconciliation. The JSONL worker follows the same fail-closed rule for interrupted running jobs, and an incomplete final journal fragment is preserved in a restricted quarantine file before recovery continues.

These policies reduce duplicate external effects but do not replace provider-side idempotency keys or operator review. External publishing handlers remain disabled until an approval-aware execution adapter is separately implemented and reviewed.
