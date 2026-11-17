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


## Stage 3: atomic worker claims and approval integrity

### PostgreSQL worker claims
- PostgreSQL stores expose `jobs.claimNext({workerId, leaseMs})`, implemented as a transaction that selects the latest queued or expired-running aggregate with `FOR UPDATE SKIP LOCKED`, then appends a running event with a lease.
- Claims record owner, heartbeat timestamp, expiry, and increment attempts. Expired leases can be reclaimed by a later claimant.
- `jobs.heartbeat(id, {workerId, leaseMs})` renews only a currently owned, unexpired lease.
- A lease-owning worker must supply its owner ID to terminal/retry transitions. Stale or expired owners are rejected.
- Worker uses the claim API only when the store exposes it. JSONL stores retain the existing list/transition/recovery behavior.
- Handler side effects remain at-least-once across a crash/lease-expiry boundary. External handlers must be idempotent; do not use this queue as exactly-once delivery.

### Approval integrity
- New approvals may bind a resource ID, exact JSON operation payload, and expiry. SHA-256 covers department, action class, summary, details, resource ID, payload, and expiry.
- Old approval digests remain verifiable using the legacy digest format.
- Decisions reject expired approvals and record the actor.
- `verifyExecutionRequest`, `claimExecution`, and `validateExecutionClaim` provide preflight, one-time claim, and final pre-execution revalidation.
- Execution claims require an injected `authorizeActor` function. The server does not currently inject this callback or expose an execution route, so execution claims remain disabled in the running application. Generic legacy approvals without resource/payload/expiry are non-executable.
- No external action is performed by these methods. A future executor must revalidate immediately before acting and use provider-side idempotency keys where available.

### Verification limits
- Unit tests exercise fake-pool locking behavior, lease ownership, expiry/reclaim, and approval integrity.
- An opt-in real PostgreSQL integration test is available only when both `JARVIS_TEST_DATABASE_URL` and `JARVIS_ALLOW_TEST_SCHEMA_RESET=yes` are explicitly set, and the database name includes `test`. It drops and recreates the `jarvis` schema in that isolated database. CI does not configure these variables, so real multi-connection PostgreSQL integration remains unrun.
- Do not configure this test against Neon production or any database containing user data.
- JSONL migration, checksum reconciliation, rollback, and live Neon validation remain separate follow-up work.


## Approval execution lifecycle
- Approval execution claims can now be finalized as `succeeded` or `failed`, or marked `expired` after the approved expiry time. These methods only update the append-only approval journal; they do not execute external operations.
- The real PostgreSQL integration test is restricted to loopback PostgreSQL hosts and a disposable database name containing `test`. It refuses Neon or any remote database because the test resets its isolated `jarvis` schema.
- The CI integration test remains skipped unless explicitly enabled with a disposable local test database. A green CI run without that configuration is not evidence of real PostgreSQL concurrency validation.
