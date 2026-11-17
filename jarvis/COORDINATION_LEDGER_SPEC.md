# ONE JARVIS Shared Coordination Ledger

Status: design baseline; not yet a live operational registry.
Owner: ONE JARVIS coordination controller.
Canonical repository: `miyamotosakuya0427-png/line-ai-bot`.

## 1. Purpose and operating contract

This document defines the shared protocol for ChatGPT conversations, agents, and human operators working on ONE JARVIS. GitHub is the shared handoff and audit surface. A conversation must not assume it can inspect another conversation's private transcript. It must read the latest repository state and record its own handoff.

Before work:
1. Read this document and inspect open PRs, branches, and task records.
2. Create or locate a stable Task ID.
3. Confirm branch, PR, file, database, and service ownership.
4. Acquire the required resource lease before writing.
5. Stop if ownership or lease state is ambiguous.

After work:
1. Record changed paths, commit SHA, PR, tests, blockers, and next action.
2. Release every lease.
3. Never record credentials, tokens, connection strings, personal data, or raw customer data.

## 2. Task identity and status

Use immutable UUID Task IDs (for example, `TASK-<UUID>`). Also assign a deterministic `dedupe_key` from normalized project + workstream + resource + intended change. A duplicate dedupe key must reuse the existing task or be rejected; it must not create a second execution.

Allowed task states:
- `proposed`
- `ready`
- `claimed`
- `in_progress`
- `blocked`
- `review`
- `verified`
- `completed`
- `cancelled`

Every task record must include:
- task_id, dedupe_key, project_id, title, scope, acceptance_criteria
- owner_conversation (opaque label, not personal identity), owner_agent
- branch, base_branch, head_sha, pull_request
- dependency_task_ids, priority, status
- created_at, updated_at, started_at, completed_at
- lease_owner, lease_token_hash, lease_expires_at, fencing_token
- changed_paths, test_run_ids, verification_summary
- blocker_ids, next_action, handoff_summary

## 3. Registry model

Logical registries:
- project_registry
- task_registry
- agent_registry
- branch_registry
- pull_request_registry
- test_registry
- deployment_registry
- production_safety_registry
- media_registry
- blocker_registry
- audit_registry

These are logical projections, not a requirement to create eleven independent tables. Prefer event-sourced aggregates in the existing `jarvis.events` store, with bounded read models for current state. Preserve the append-only event history.

Recommended aggregate types:
- `project`, `task`, `agent`, `branch`, `pull_request`
- `test_run`, `deployment`, `safety_gate`, `media_asset`, `blocker`, `audit_record`

Every mutation appends a versioned event with an idempotency key. Use expected aggregate version to reject stale writes. Do not update or delete historical events.

## 4. Resource locking and concurrency

Task leases and resource leases are separate:
- Task lease: prevents two agents from executing the same task.
- Branch lease: prevents multiple writers to the same branch.
- File/path lease: prevents conflicting edits to the same normalized repository path.
- Database lease: serializes schema/data writes to the same database and environment.
- External-action lease: protects any approved one-time external operation.

Lease contract:
- Acquire atomically; never implement acquire as read-then-write.
- Return an unguessable lease token and monotonically increasing fencing token.
- Every write/complete/release must present the current owner, token, and fencing token.
- Renew before expiry; reject stale owners after expiry or reclaim.
- Expired leases may be reclaimed atomically.
- Release in a finally/cleanup path.
- If the lease service is unavailable, fail closed for writes.
- A lease is not proof of human approval.

For PostgreSQL, use a dedicated coordination lock table or equivalent atomic SQL with a unique resource key and conditional expiry takeover. Do not overload Worker job state as branch/file locks.

For JSONL, the existing in-process promise queue only serializes operations inside one process. It is not a multi-process distributed lock. JSONL mode must be restricted to single-process development or use an independently verified OS-level lock; it must not claim cross-process safety.

## 5. Worker and approval boundary

Reuse existing PostgreSQL operational stores for atomic Worker claims, `FOR UPDATE SKIP LOCKED`, advisory locks, heartbeat, expiry reclaim, and owner-bound transitions.

Keep these invariants:
- A job is claimed by one worker at a time.
- A reclaimed job increments attempts and fences the old worker.
- A stale worker cannot heartbeat or finish a reclaimed job.
- Approval execution is bound to actor, resource, exact payload, digest, expiry, and one-time claim.
- Worker execution only runs allowlisted handlers.
- Approval records authorize only the exact operation recorded; they do not grant blanket production permission.

The Worker queue is execution infrastructure; the task registry is project coordination. Do not conflate them.

## 6. GitHub handoff format

Until the transactional coordination service is implemented, use one immutable task record per Task ID under `jarvis/coordination/tasks/<task-id>.md`, and this specification as the protocol. Do not have multiple conversations edit the same task record concurrently. Use a dedicated handoff PR for task-record changes; review conflicts before updating.

A task record must contain the required fields in section 2 plus:
- source conversation's claimed facts vs unverified facts
- files inspected and exact refs/SHAs
- tests actually run (not merely expected)
- safety impact and prohibited actions respected
- next prompt / next owner

GitHub Markdown is a handoff and audit surface, not a substitute for transactional locks. For simultaneous writers, the database lock service is mandatory.

## 7. Branch and PR rules

- One active writer per branch.
- PRs must identify parent/dependent PRs and exact base/head refs.
- Never retarget, rebase, force-push, or merge another workstream's branch without its owner's approval.
- Before creating a branch or PR, search for an equivalent task, branch, and open PR.
- A branch with recent commits or an open PR is presumed owned; ownership is unknown unless explicitly recorded.
- Read-only inspections may run in parallel. Writes to the same branch, file, or database must be serialized.

## 8. Production safety gates

Default deny:
- no LINE production changes
- no Render production deploy or service setting changes
- no Neon production migration or data mutation
- no PR merge
- no billing or paid generation
- no external media upload, scheduling, or publication
- no secrets or personal/customer data in logs, prompts, task records, or test fixtures

Every deployment record must state environment, service, branch, commit SHA, approval reference, operator, start/end time, and verification. Production actions require a separate explicit approval and an independently verified rollback plan.

## 9. Current integration facts at specification creation

- The repository currently has 49 branches and 29 open PRs; all 29 open PRs are Draft at the latest inspection.
- PR #43 is the parent PostgreSQL foundation; its latest observed head is `6e98ea3c`. Its CI reports success on an isolated PostgreSQL 16 test service. It does not touch Neon.
- PR #46 is a dependent append-only ledger hardening PR. Its branch advanced during the inspection to `1abb71fc7a15fc7641b998ab62740aa32a5b5627`.
- The runtime trigger function now uses valid PostgreSQL `$$ ... $$` quoting, and its unit assertion checks that form. The earlier malformed `AS $ ... END; $` form was corrected on the existing PR branch by a concurrent update; this specification branch did not modify PR #46.
- The latest observed `ONE JARVIS tests` and `JARVIS tests` runs for PR #46 head `1abb71fc` succeeded.
- Actual PostgreSQL execution of the append-only UPDATE/DELETE/TRUNCATE trigger behavior is still not established by the inspected test evidence. Fake-pool SQL assertions are not equivalent to a real PostgreSQL integration test.
- Existing PostgreSQL Worker operational stores include atomic claim, lease renewal, expiry reclaim, and owner-bound transitions. Existing JSONL job store uses an in-process queue and is not a distributed multi-process lock.
- No shared task/branch/file coordination registry was found in the inspected `main`, `one-jarvis-foundation`, `jarvis-paper-trading-learning`, PR #43, or PR #46 trees. This is a scoped inspection, not proof that no equivalent exists on every branch or in another service.

## 10. Implementation sequence

1. Add isolated PostgreSQL integration tests for append-only triggers: INSERT succeeds; UPDATE, DELETE, and TRUNCATE fail; migration rerun is safe; existing rows remain unchanged.
2. Implement task aggregate events and read model using the existing event store; add schema/validation and idempotency tests.
3. Implement atomic task/branch/path/database leases with fencing tokens and concurrent multi-connection tests.
4. Add GitHub task-record generator/validator and duplicate detection.
5. Add branch/PR ownership synchronization and CI checks.
6. Add read-only dashboards and cross-department reporting.
7. Only after independent review, consider any production integration under explicit approval.

## 11. Acceptance criteria

- Two independent workers cannot claim the same task or resource lease.
- A stale owner cannot write after lease expiry/reclaim.
- Duplicate task creation is idempotently rejected or returns the existing task.
- Task state transitions are validated and auditable.
- JSONL mode clearly refuses to promise distributed locking.
- Append-only trigger behavior is proven against real isolated PostgreSQL.
- Every handoff includes exact branch/PR/SHA/test evidence.
- No production, billing, or external publishing operation is performed by this phase.
