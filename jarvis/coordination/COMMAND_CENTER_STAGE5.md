# ONE JARVIS Command Center — Stage 5 status

## Implemented and verified on the isolated PR branch

### Durable Task Event Outbox
- Migration `0009_task_event_outbox.sql` creates an Outbox row and per-Project/Conversation cursor in the same transaction as each append-only Task event.
- Cursor allocation uses a transaction-scoped advisory lock and transactional counter, preventing committed cursor gaps from rolled-back transactions and ordering races.
- PostgreSQL NOTIFY contains only a wake-up cursor hint; event bodies are always read from durable Outbox joined to append-only `jarvis.events`.
- Outbox rejects UPDATE, DELETE and TRUNCATE. Replay is bounded, scope-limited, ordered, deduplicated by cursor, and rejects future cursors / detected gaps.
- Lost notifications are recoverable by replay polling. PostgreSQL 16 integration suite also covers rollback atomicity and independent OS processes for Worker/Lease races.

### Authenticated SSE
- `GET /v1/command-center/events` requires Dashboard API token and Task Registry token.
- Project / Conversation scope is checked on connection and rechecked during the stream.
- Last-Event-ID replay, cursor ordering, duplicate suppression, heartbeat, connection limits, shared rate limiting, bounded batches, backpressure timeout and LISTEN cleanup are implemented.
- SSE payload is an explicit metadata allowlist; free-form task text, credential hashes, secrets and lease tokens are excluded.
- Because the browser EventSource API cannot set the required custom auth header, the Dashboard uses fetch streaming.
- Authenticated 15-second polling remains the fallback.

### Shared dynamic Token revocation (new)
- Migration `0010_task_registry_agent_revocations.sql` adds an append-only PostgreSQL revocation ledger keyed by Agent ID; it blocks future authorization without process restart.
- The authorizer checks the shared revocation store on each authorization. SSE repeats authorization every 15 seconds and terminates on revocation/expiry.
- Owner-only `POST /v1/admin/task-registry-agents/:agentId/revoke` requires `ownerApproval: true`.
- If migration 0010 is missing or the shared revocation store is unavailable, SSE fails closed with 503; authenticated polling remains available using the existing configured token expiry/revocation checks.
- Agent IDs are permanently revoked in this ledger; credential rotation should use a new Agent ID. The ledger does not store raw tokens or token hashes.

### Worker Grant management
- Owner-only Grant listing includes active/revoked Grant metadata, grantor/time, Worker status and Lease expiry.
- Grant creation and revocation require Owner authentication and explicit `ownerApproval: true`; Dashboard UI also asks for confirmation.
- Responses omit secrets, credential hashes and fencing tokens. Grant audit events remain append-only.

### Structured Handoff in the common Dispatcher (partial)
- `createTaskDispatcher` now accepts a structured `handoffRequest` returned by a Department Handler.
- It selects a different-department target Worker, rechecks target Agent authorization and eligibility, derives an idempotency key, and delegates the actual transfer to atomic `recordTaskHandoff`.
- When no eligible target Worker is available, the Task moves to `waiting` and the source Worker/Lease is safely released.
- Unit tests cover authorized Handoff and no-target waiting.

## Remaining / not yet complete
- The current production Department Handler implementations still return ordinary answer objects; they do not yet emit structured `handoffRequest` envelopes by default.
- The common Task Dispatcher is not yet wired as the execution entry point for the existing Department Handler worker pipeline / authenticated Task Registry dispatch route. Therefore end-to-end autonomous cross-department routing is **not complete**.
- The token revocation ledger is only included in isolated PostgreSQL 16 CI. It has **not** been applied to production Neon. SSE remains disabled in environments where migration 0010 is absent.
- Token revocation is keyed to Agent ID and is append-only. Rotation to a new Agent ID is required after revocation; a managed reactivation workflow is not implemented.
- Full high-volume soak / notification-loss chaos tests beyond the deterministic replay and multi-process integration coverage remain outstanding.
- Real physical iPhone and desktop browser checks have not been performed; automated tests and responsive CSS checks are not a substitute.

## Latest verification
Exact PR #78 Head: `b2f41e5bd0d298384589ecc61d85ae1256b6b7bb`
- JARVIS tests — run 44901498851: success
- ONE JARVIS tests — run 44901498795: success
- ONE JARVIS Task Registry PostgreSQL 16 — run 44901498823: success
- PostgreSQL 16 suite: **301 passed / 0 failed / 0 skipped**

## Safety boundary
- PR #78 remains Draft / Open / unmerged.
- PR #77 and all other Worker branches remain untouched.
- Migration 0010 is not auto-applied at startup. No production Neon migration/write, Render configuration/deploy, LINE send, Google Sheets production change, paid API, external publication, secret disclosure, force-push, rebase or merge was performed.
