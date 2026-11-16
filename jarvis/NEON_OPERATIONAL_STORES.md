# ONE JARVIS operational PostgreSQL adapters

This phase adds opt-in PostgreSQL-backed job and approval stores using the append-only `jarvis.events` ledger created by migration 0001.

- The stores preserve the existing JSONL store API shape: `init/create/get/getByIdempotencyKey/list/transition` for jobs and `init/create/get/list/decide` for approvals.
- Writes are transactional; job and approval transitions use aggregate-scoped advisory locks.
- Job state transitions follow the existing transition graph and attempt counter.
- Approval requests carry a SHA-256 integrity digest; decisions verify the immutable request fields and record the decision actor.
- Idempotency keys are queried with parameterized SQL and indexed by migration 0002.
- JSONL files are not imported, deleted, rewritten, or dual-written by this phase.

## Activation

The adapter is opt-in and must only be selected with `JARVIS_STORAGE_MODE=postgres` plus a secret `DATABASE_URL`. The service must fail closed if PostgreSQL mode is selected but the database cannot initialize; it must not silently fall back to JSONL, because that could split the source of truth. With no explicit PostgreSQL mode, existing JSONL behavior remains unchanged.

The production runtime is not activated by this PR. No connection string is included and no live database migration has been run.
