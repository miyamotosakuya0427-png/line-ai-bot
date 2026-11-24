# ONE JARVIS Command Center — Stage 6
## Department Handler / Common Dispatcher Integration

- Repository: `miyamotosakuya0427-png/line-ai-bot`
- PR: `#78`
- Branch: `integration/one-jarvis-command-center-ui`
- Base: `integration/one-jarvis-stage5-dispatcher-state-machine`
- Verification Head before the multi-hop result-isolation correction: `5c2a233b46c39b47939e019632c819106bf0d46f`
- PostgreSQL test target: PostgreSQL 16

## Implemented on this PR branch

### 1. Thirteen formal Department Handlers
- All 13 registered departments remain the only valid routing targets: `jarvis`, `management`, `tax`, `office`, `construction`, `hr`, `procurement`, `recycling`, `safety`, `content`, `affiliate`, `invest`, `trader`.
- The existing answer fields are preserved. A valid optional `handoffRequest` is added with `departmentId`, `reason`, `deliverables`, `acceptanceCriteria`, and `actionClass`.
- The Office research Handler receives the same protocol.
- Unregistered departments, self-handoffs, malformed/incomplete requests, notification/publication/external action classes, and other unsafe action classes fail closed.
- Handler request text is treated as untrusted input. Handlers do not receive Task Registry or Worker mutation methods.

### 2. Authenticated common Dispatcher route
- Added `POST /v1/tasks/:taskId/dispatch` to the authenticated Task Registry API.
- The route calls the PostgreSQL-backed common Dispatcher runtime and uses the same 13 Department Handler functions.
- The Dispatcher passes Task title, scope and acceptance criteria as the Handler request, while retaining the Task, Worker, Lease and principal context.
- Task Registry remains the sole Task state authority. Worker claim remains atomic.
- Target selection checks department, idle Worker state, active Scope Grant, recent heartbeat, Agent configuration, project/conversation scope, required `tasks:dispatch` and `tasks:claim` scopes, expiry and live shared revocation.
- The target Agent is re-authorized immediately before Handoff. The Task Registry transaction also serializes source/target Agent checks against revocation.

### 3. Atomic Handoff and idempotency
- Structured Handoff metadata and the updated Task ownership/department/state are appended in the same PostgreSQL transaction.
- A deterministic Idempotency Key is required by the Dispatcher and persisted with the Handoff event. Replay compares the complete structured request and result resource reference.
- Existing route-cycle protection remains active; same-department/repeated-department/over-limit handoffs are rejected.
- If no active eligible target Worker exists, the Task moves to `waiting`; the source Worker and Lease are safely released.
- Legacy Worker/job execution paths were left additive and unchanged.

### 4. Fenced result persistence
- The runtime writes the Handler result through the Execution Kernel Fenced Writer using both the Task Lease and a separate Resource Lease.
- Result resources use a deterministic Task-scoped identifier and idempotency key.
- The Task stores `resultResourceId` when completed, waiting for a target, or handed off; the Handoff event includes the same reference. Result resource IDs are versioned per Task execution (`task-result-<taskId>-v<runningVersion>`) so a later Department Handler in a multi-hop route cannot collide with the previous department's `expectedVersion: 0` resource write.
- A missing/failed Fenced Writer confirmation prevents completion. Uncertain persistence/execution is quarantined as `outcome_unknown` and is not automatically retried.

### 5. Dynamic Agent revocation
- Migration `0010_task_registry_agent_revocations.sql` remains additive and append-only.
- Owner revocation uses the protected admin route and requires `ownerApproval: true`; the ledger records Agent ID, revocation time and revoker label without token/hash material.
- Revocation writes and Task Claim/Handoff transactions share the same advisory lock key, serializing concurrent revocation against Claim and Handoff.
- Both public Task Claim and Worker Task Claim fail closed after revocation. Handoff rejects a revoked source or target Agent.
- If the shared revocation store is absent, read-only polling remains available, but mutating Claim/Dispatch authorization fails closed and Dispatcher/SSE are not enabled.
- Revocation is permanent for an Agent ID. Rotation procedure: create a new Agent ID and token, configure only the required scopes/project/conversation, register a new Worker and active Scope Grant, verify read/claim/dispatch, then revoke the old Agent ID. Do not reactivate or reuse a revoked ID.

## Verification

Exact post-correction implementation Head: `150d7f802f337805e76c1502d9c95b3a6e9e781c`

- JARVIS tests — run `45416591603`: success; **312 passed / 0 failed / 4 skipped**.
- ONE JARVIS tests — run `45416591574`: success; **312 passed / 0 failed / 4 skipped**.
- ONE JARVIS Task Registry PostgreSQL 16 — run `45416591553`: success; **316 passed / 0 failed / 0 skipped**.
- Added a sequential cross-department runtime test: Construction Handler → atomic Handoff → Management Handler → distinct fenced result resource → completed Task.
- The PostgreSQL 16 suite includes multi-process claim contention, Fenced Task result persistence/idempotent replay, atomic structured Handoff, revocation-denied Claim/Handoff, and Worker recovery.
- Runtime tests use deterministic fake Handler/Kernel dependencies to prove Handler → Dispatcher → result persistence/Handoff behavior without calling paid APIs or a live LLM.
- Dashboard regression checks and responsive CSS marker checks pass as part of the JARVIS test suite.

## Explicitly not completed / not performed

- Migration 0010 has **not** been applied to production Neon. In production environments without the shared revocation table, Dispatcher and SSE remain unavailable/fail-closed; polling is the fallback.
- No production Neon writes, migrations, or SQL mutations were performed.
- No Render environment/configuration changes or deployments.
- No LINE production messages or Google Sheets production edits.
- No paid API, external publish, order, contract, financial transaction, tax submission, or other external action.
- No real physical iPhone or desktop browser test. Automated dashboard/responsive regression tests are not a substitute for device verification.
- No high-volume soak/chaos test covering prolonged SSE load, notification loss, and large concurrent cross-department fan-out.
- No single all-real-PostgreSQL + live-LLM production-like end-to-end test. The Handler-to-Dispatcher runtime path and PostgreSQL persistence/security primitives are verified in complementary deterministic runtime and PostgreSQL 16 integration suites.

## Safety / PR state

- PR #78 must remain Draft / Open / unmerged.
- PR #77 and all other Worker branches remain untouched.
- No force push, rebase, merge, production configuration changes, secret display, or external publication.


## Multi-hop result isolation correction

- Fixed the Task result resource key to include the running Task version, preventing the second Department Handler in a sequential Handoff chain from colliding with the first Handler's result resource.
- Added a regression test that dispatches the same Task through Construction → Management and verifies separate fenced result resources and final completion.
- Exact correction Head: `150d7f802f337805e76c1502d9c95b3a6e9e781c`.
- All three CI workflows passed on that exact Head; see the verification block above.
