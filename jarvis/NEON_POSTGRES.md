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
