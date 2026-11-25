# ONE JARVIS Command Center — Stage 8
## Atomic Handoff target validation, Owner identity design, and pre-production test plan

- Repository: `miyamotosakuya0427-png/line-ai-bot`
- PR: #78
- Branch: `integration/one-jarvis-command-center-ui`
- Baseline Head: `b8862369034fc09b650d2bd5b682cac7d448e7b4`
- PostgreSQL target: 16
- Production changes: none

## 1. Atomic Handoff target revalidation

The Handoff API now requires an explicit `targetWorkerId` in addition to target Agent and Department IDs. The Dispatcher passes the selected Worker ID to the registry.

Within the same PostgreSQL transaction that writes the Handoff event and requeues the Task, the registry:
1. Locks the destination Worker row with `FOR UPDATE`.
2. Rechecks exact Worker ID, Agent ID, Department ID, `idle` state, and absence of a current Task.
3. Rejects a missing or stale heartbeat (older than 120 seconds).
4. Locks an active Project/Conversation Grant row with `FOR SHARE`, scoped to the Task's persisted Project and Conversation.
5. Rechecks both source and destination Agent revocation under the shared advisory-lock protocol.
6. Includes `toWorkerId` in the append-only Handoff event and idempotency replay comparison.

The Worker and Grant row locks remain held until the transaction commits. A concurrent Worker state change or Grant revocation therefore serializes behind Handoff; a concurrent Agent revocation serializes through the existing Agent advisory lock. Any failed check rolls back the Task event, Outbox event, Lease release, and source Worker release together.

The integration fixture now provisions explicit destination Workers and Grants for normal and revoked-Agent Handoff cases.

## 2. Owner operator identity — design only

The current shared Owner bearer token proves possession of a shared credential, not the identity of an individual operator. A caller-supplied `actor` or `operatorName` string is not identity proof and must never be trusted.

Recommended production design:
- Use an organization-approved OIDC identity provider for Owner actions.
- Verify JWT signature, issuer, audience, expiry, not-before, and approved Owner role/group on the server.
- Derive immutable operator identity only from verified `iss` + `sub`; optionally retain a display name as non-authoritative metadata.
- Store a stable, non-secret operator subject reference in the append-only revocation audit row, alongside Agent ID and timestamp. Do not store the bearer token, JWT, token hash, or other credential material.
- Require explicit Owner approval for each destructive administrative action and retain request correlation ID, action, target Agent ID, verified operator subject, and timestamp.
- Keep the current shared Owner token as a legacy compatibility path only if policy permits; records created through that path must remain labelled as shared-owner / unattributed, never retroactively attributed to a person.
- Add a versioned migration and isolated tests before rollout. No production Owner credential or environment variable was changed in this stage.

Owner approval decisions still required: identity provider/issuer, audience, Owner group claim, emergency break-glass process, retention period, and whether legacy shared-token revocation remains enabled during transition.

## 3. SSE and dashboard test status

The existing SSE implementation provides scope checks, Last-Event-ID replay, 15-second reauthorization, fail-closed behavior when the shared revocation store is unavailable, global/per-Agent connection limits, payload allowlisting, backpressure handling, and listener cleanup.

Stage 8 did not run a dedicated high-volume, long-duration soak or chaos experiment. The following remain mandatory before enabling SSE in production:
- 3 global connections / 1 per Agent boundary and rejection behavior
- 15-second authorization recheck and measured revoke-to-disconnect latency
- PostgreSQL outage/recovery, reconnect and replay from Last-Event-ID
- NOTIFY loss with durable replay, duplicate suppression, and gap detection
- slow-reader backpressure, cancellation, listener/connection leak checks
- sustained concurrent connection soak with CPU, memory, DB pool and listener measurements
- credential and credential-hash payload/log scans

Automated dashboard tests do not equal physical iPhone or desktop browser validation. No physical device test was performed in this stage.

## 4. outcome_unknown recovery

The existing Task State Machine requires an explicit reconciliation ID and operator identity to resolve `outcome_unknown`. Expired running Tasks are quarantined rather than automatically reclaimed. External side effects must not be retried automatically when their outcome is uncertain.

Operational reconciliation procedure:
1. Freeze the Task in `outcome_unknown`; do not replay the external operation.
2. Create a unique Reconciliation ID and assign a verified human operator.
3. Inspect provider-side evidence using read-only queries or statements.
4. Record evidence, provider reference, observed result, timestamp, and operator identity in the approved audit channel.
5. Obtain Owner approval for the resolution where the action is financial, public, contractual, or otherwise irreversible.
6. Resolve to completed/failed only through the fenced Task transition requiring Reconciliation ID and operator identity.
7. If evidence remains inconclusive, keep the Task quarantined and escalate; do not retry.

This is a documented operating procedure, not a claim that provider-side reconciliation was executed.

## 5. Migration 0010 readiness

Migration 0010 remains isolated-test-only and has not been applied to production Neon. Existing Stage 7 preflight/post-apply SQL, backup/restore requirements, and forward-fix policy remain in force.

Before production application, the Owner must approve the exact Neon project/branch/database, maintenance window, backup restore point and isolated restore proof, migration checksum, expected schema objects, verification SQL, operator, and forward-fix owner. Append-only revocation records must never be erased as rollback.

## 6. Not performed / not approved

- No production Neon read/write or migration application.
- No Render setting change or deployment.
- No LINE production send or Google Sheets production edit.
- No paid API, external publication, or production Agent Token issuance/revocation/rotation.
- No physical iPhone/desktop browser test.
- No dedicated high-volume SSE soak/chaos test.
- No live OIDC Owner identity integration.
- No claim of production readiness.

PR #78 must remain Draft / Open / unmerged. PR #77 and all other Worker branches remain untouched.
