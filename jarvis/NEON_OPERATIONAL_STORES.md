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


## Quality review findings and limitations

- Idempotent job and approval lookups return the latest aggregate snapshot, not only the original creation event.
- The adapter uses parameterized SQL and transaction-scoped advisory locks. The automated adapter tests use a fake pool; they do not prove PostgreSQL multi-process behavior.
- The current Worker contract lists queued jobs and then transitions them to running. It does not yet expose an atomic database claim/lease API. Do not run multiple independent Worker processes against this adapter until a claim/lease protocol and real concurrency tests are added.
- The existing generic approval-store contract has no target-resource identifier, expiry field, execution claim, or execute-before-action revalidation method. The digest currently covers department, action class, summary, and details only. It must not be treated as sufficient authorization to execute an external action.
- Existing API routes keep approval execution disabled; approval decisions only record the decision. Any future external action must add a separate, owner-authorized execution protocol that binds target ID, exact payload digest, expiry, approver, and one-time execution claim.
- CI runs the full Node test suite and syntax checks for the PostgreSQL and store entry points. No dedicated lint command or security scanner is configured in this repository workflow.
- No live PostgreSQL/Neon integration test, JSONL migration dry-run, checksum reconciliation, or rollback test has been performed.
