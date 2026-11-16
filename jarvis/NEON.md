# ONE JARVIS Neon persistence

Neon is an optional persistence layer. Google Sheets remains the existing operational source and is not modified by this module.

## Configuration

Set `NEON_DATABASE_URL` only in the dedicated ONE JARVIS Render service after verifying the Neon endpoint and credentials. Never print the value or include it in logs. The module does not read or alter any existing Sheets or LINE environment variables.

## Safe activation sequence

1. Confirm the Neon project endpoint is active and its region is Sydney (`aws-ap-southeast-2`).
2. Add `NEON_DATABASE_URL` to the dedicated Render service without replacing existing environment variables. Do not deploy as part of this preparation.
3. From a controlled environment, create the store with `createDbStore()`, run `ping()`, then `migrate()`.
4. Verify the migration ledger and expected tables. Do not migrate operational Google Sheets data in this phase.
5. Only after a separately approved deployment, wire the store into job and approval workflows.

## Schema

Migration `001_initial_persistence.sql` creates:
- `jarvis_jobs`: durable job queue with unique idempotency keys and request hashes.
- `jarvis_job_attempts`: attempt history with a unique (job_id, attempt_no) pair.
- `jarvis_approvals`: approval state with one-way pending-to-decision transition.
- `jarvis_audit_events`: append-only event records with unique event IDs.
- `schema_migrations`: migration ledger created by the runner.

The queue claim uses `FOR UPDATE SKIP LOCKED`. Job creation and audit event insertion are idempotent. A reused job idempotency key with a different payload is rejected with status 409.

## Retry and safety

Transient network failures are retried with bounded exponential backoff. Non-transient PostgreSQL errors are not retried. Queue claims are deliberately not retried automatically because a lost response could otherwise claim a second job. Secrets are not included in error messages or health responses.

This change only adds code and schema files on `one-jarvis-neon-integration`. It does not activate the database, add Render environment variables, run migrations, deploy, merge, or change LINE / Google Sheets.
