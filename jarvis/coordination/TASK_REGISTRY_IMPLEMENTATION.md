# ONE JARVIS Task Registry v1 — implementation boundary

Status: isolated implementation candidate; not production-enabled.
Branch: `coordination/one-jarvis-task-registry-v1`
Base: PR #49 head `56dde9b1f8b0b7913d093ba90d3868c7e49c7036`
Design authority: `jarvis/COORDINATION_LEDGER_SPEC.md` from PR #47.

## Scope
- Keep project coordination tasks separate from the worker execution queue.
- Store task lifecycle as append-only `jarvis.events` aggregates (`aggregate_type='task'`).
- Use a dedicated mutable `jarvis.coordination_leases` table only for current lease state.
- Use deterministic dedupe keys and PostgreSQL unique enforcement.
- Use transaction-scoped advisory locks for aggregate version serialization.
- Use unguessable lease tokens; persist only SHA-256 token hashes.
- Increment fencing tokens on every successful lease acquisition/reacquisition.
- Require expected aggregate version and current unexpired lease for owner writes.
- Fail closed when PostgreSQL is unavailable; no JSONL distributed-lock fallback.

## Resource key convention
Normalize resource identifiers before calling the store:
- `task:<uuid>`
- `branch:<repository>:<branch>`
- `path:<repository>:<normalized-path>`
- `database:<provider>:<project>:<branch>`
- `external:<provider>:<operation-id>`

The caller must not derive authorization from a lease. Human approval remains a separate gate.

## Safety boundary
This branch is based on PR #49 and does not edit existing PR branches. The migration is not applied to Neon. No Render deploy, production DB write, LINE/Apps Script change, billing, upload, scheduling, or publication is part of this implementation.

## Remaining validation before integration
1. Run migration and tests against ephemeral PostgreSQL 16.
2. Prove duplicate dedupe rejection, simultaneous lease acquisition, fencing increments, expired lease takeover, stale token rejection, and stale aggregate-version rejection using independent connections.
3. Test migration rerun and append-only event behavior.
4. Review integration with PR #49's current head and PR #47's base divergence.
5. Keep the PR Draft until the owner reviews the implementation and integration plan.

## Coordination handoff
Each Task ID gets one immutable task record under `jarvis/coordination/tasks/<task-id>.md`. Do not let multiple conversations edit the same record. The registry implementation is the future transactional lock service; GitHub task records remain handoff/audit artifacts, not locks.
