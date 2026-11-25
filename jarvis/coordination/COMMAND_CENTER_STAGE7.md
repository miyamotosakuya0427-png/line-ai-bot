# ONE JARVIS Command Center — Stage 7
## Pre-production security audit, Migration 0010 readiness, and Agent rotation

- Repository: `miyamotosakuya0427-png/line-ai-bot`
- PR: #78
- Branch: `integration/one-jarvis-command-center-ui`
- Baseline Head: `bb1da1f45af775167ced68a10036319226c58a85`
- PostgreSQL target: 16
- Scope: read-only production audit + isolated CI verification + documentation. No production changes.

## 1. Security audit findings

### Task Registry authentication and scope
- Bearer tokens are SHA-256 hashed for comparison and compared with `timingSafeEqual`.
- Agent entries require unique hashes, expiry, an allowlisted scope set, explicit Project IDs, and resource prefixes for resource lease scope.
- Internal Agent authorization checks live revocation, Project, Conversation, and required scopes.
- Task Registry API checks action scope, Project/Conversation ownership, per-Agent rate limiting, and fails closed with 503 when the authorization/revocation backend is unavailable.
- Dispatcher authorization requires both `tasks:dispatch` and `tasks:claim`; the runtime rechecks source and target Agent authorization.
- Worker Claim checks active Scope Grant and live Agent revocation in the PostgreSQL transaction.
- Handoff serializes source/target Agent revocation checks with the same advisory lock used by the revocation ledger.
- Target Worker state and Scope Grant are checked during scoped Worker selection; actual Task Claim rechecks Worker state and Grant in its transaction. A Grant/Worker change in the interval can leave the Task queued until an eligible target is available; it cannot authorize a revoked Worker to claim.

### Credential material and response redaction
- Security correction: Task Registry API Task responses now redact `leaseTokenHash`, `tokenHash`, `secret`, `accessToken`, `apiToken`, and `password` fields from Task payloads.
- Redaction is applied to list, create, get, dispatch, claim, and transition Task result payloads. Lease capability responses remain returned only to the authenticated caller because the caller needs the opaque capability for heartbeat/release; do not log or display those values.
- Dashboard telemetry and SSE use explicit allowlists and do not serialize lease token hashes or raw Lease tokens.
- No raw API token or token hash was printed into CI summaries or this document.

### Dynamic revocation and SSE
- PostgreSQL revocation reads are performed on each authorization, not cached as a permanent process decision.
- A missing shared revocation store prevents mutating Claim/Dispatch authorization and disables SSE; read-only polling is the fallback.
- DB errors during authorization are translated to unavailable/fail-closed responses by API and SSE paths.
- SSE revalidates authorization every 15 seconds, closes on authorization loss or outbox replay failure, limits connections to 3 globally and 1 per Agent, and closes on prolonged backpressure.
- SSE sends a narrow payload allowlist; heartbeat frames do not contain credential material.

### Owner revocation audit limitation
- The append-only `jarvis.task_registry_agent_revocations` ledger records Agent ID, revocation timestamp, and a revoker label.
- The current Owner route records the fixed label `owner-token`; the current shared Owner bearer authentication does not identify a distinct human operator. This is an authenticated-Owner audit record, not person-attributable identity proof.
- Before production, decide whether the Owner authentication model must provide a non-secret, verified operator identity. Do not accept a caller-supplied identity string as proof.

### Remaining race / operational consideration
- Handoff checks target Worker eligibility and Grant before the atomic Task Handoff; the target's subsequent Claim again checks Worker state, Grant, and revocation transactionally.
- If a Grant or Worker changes after selection but before Handoff commit, the Task may be queued to a target that cannot claim it. This is fail-closed but requires an operator/recovery path to move the Task to waiting or select another eligible target. A transactional target Worker/Grant recheck at Handoff commit remains a pre-production hardening item.
- A Worker that loses its Lease cannot write a final Task transition. The recovery path must treat an expired running Task as `outcome_unknown` and require explicit reconciliation; it must not blindly retry external actions.

## 2. Migration 0010 audit

Migration file: `jarvis/migrations/0010_task_registry_agent_revocations.sql`

- Creates `jarvis.task_registry_agent_revocations` with Agent ID primary key, timestamp, and revoker label.
- Adds UPDATE/DELETE and TRUNCATE rejection triggers.
- Records the migration version in `jarvis.schema_migrations`.
- Contains no token, token hash, database URL, or secret values.
- Is re-runnable at the DDL level, but must still be applied only under an approved migration process.
- The PostgreSQL 16 isolated integration suite applies migrations 0001 and 0003–0010 to a disposable test schema.
- Added explicit PostgreSQL 16 assertions that UPDATE, DELETE, and TRUNCATE of the revocation ledger are rejected.

### Production preflight SQL — review only, do not run against production in this stage

```sql
SELECT current_database(), current_setting('server_version');
SELECT to_regclass('jarvis.schema_migrations') AS schema_migrations,
       to_regclass('jarvis.task_registry_agent_revocations') AS revocation_ledger;
SELECT version
FROM jarvis.schema_migrations
WHERE version IN (
  '0001_neon_event_store',
  '0003_append_only_event_ledger',
  '0004_task_registry',
  '0005_task_registry_scoped_dedupe',
  '0006_scheduling_reservation_store',
  '0007_execution_kernel_fencing',
  '0008_worker_scope_grants',
  '0009_task_event_outbox',
  '0010_task_registry_agent_revocations'
)
ORDER BY version;
```

### Post-apply verification SQL — review only, do not run against production in this stage

```sql
SELECT to_regclass('jarvis.task_registry_agent_revocations') AS revocation_ledger;
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'jarvis.task_registry_agent_revocations'::regclass
  AND NOT tgisinternal
ORDER BY tgname;
SELECT count(*) AS revocation_record_count
FROM jarvis.task_registry_agent_revocations;
```

Do not select or export raw connection strings, token hashes, or secret values during preflight.

### Backup and recovery requirements
1. Obtain explicit Owner approval for a maintenance window and the exact target Neon project/branch/database.
2. Create a Neon restore point/snapshot using the supported platform workflow immediately before the migration; record its identifier and timestamp without exposing connection details.
3. Verify the restore point can be restored to an isolated branch before production use.
4. Confirm current schema migration inventory and backup freshness.
5. Apply migration 0010 in a controlled transaction using the reviewed SQL; capture success/failure and migration version only.
6. Run post-apply verification queries and isolated application smoke tests.
7. If the transaction fails before commit, rollback the transaction and investigate.
8. If committed schema is defective, do not delete the append-only revocation ledger or erase audit records. Prefer a forward-fix migration. If data recovery is necessary, restore the pre-migration snapshot to a separate branch and reconcile under explicit Owner approval.
9. Never run destructive DROP/TRUNCATE rollback against the revocation ledger.

### Owner approval checklist
- Exact Neon project, branch, and database confirmed.
- Backup/restore point created and isolated restore verified.
- Migration SQL and expected schema objects reviewed.
- Maintenance window and application fail-closed behavior agreed.
- Post-apply verification queries reviewed.
- Recovery/forward-fix owner and operator identified.
- Separate explicit approval for the actual production migration. This stage does not grant that approval.

## 3. Agent Token rotation runbook

1. Select a never-before-used Agent ID; revoked IDs are permanent and must never be reused.
2. Generate a new cryptographically random bearer token in the approved secret-management environment. Do not paste it into chat, source code, PR comments, screenshots, or logs.
3. Calculate SHA-256 inside the approved secret-management process and place only the hash in the protected `JARVIS_TASK_REGISTRY_AGENT_TOKENS` configuration.
4. Configure the minimum required scopes only. Typical dispatch Agent scopes are `tasks:read`, `tasks:dispatch`, and `tasks:claim`; add lease/transition/resource scopes only when the Agent actually requires them.
5. Bind the Agent to the intended Project IDs and Conversation ID. Resource lease scope requires explicit resource prefixes.
6. Set an explicit expiry and verify the token hash is unique across all configured Agents.
7. Register a new Worker for the new Agent ID and grant only the intended Project/Conversation scope.
8. Verify the new Agent can perform only its intended read/claim/dispatch operations in an isolated environment; verify wrong Project, Conversation, scope, expired token, missing Grant, and revoked token all fail closed.
9. During an approved cutover window, direct new work to the new Agent. Do not transfer an active Lease by copying tokens.
10. After confirming no active Task/Lease depends on the old Agent, revoke the old Agent ID through the Owner-only endpoint with explicit approval.
11. Verify the old Agent can no longer Claim, Dispatch, Handoff, or keep an SSE connection open. Keep the revocation ledger record.
12. If the new Agent fails before old revocation, stop cutover and investigate. If the old Agent has been revoked, create another new Agent ID for recovery; never reactivate the revoked ID.

Rotation is designed only; no live Agent credentials, environment variables, Workers, Grants, or production settings were changed.

## 4. Verification matrix

- 13 Department Handler protocol: existing unit tests cover all 13 handlers emitting validated Handoff while preserving ordinary answer fields.
- Handler → Dispatcher: sequential Construction → Management dispatch test exists and passed on Stage 6 Head.
- PostgreSQL 16: existing CI covers multi-process Claim contention, Fenced Writer persistence/idempotent replay, atomic Handoff and revocation-denied Claim/Handoff.
- Dynamic revocation: unit/integration tests cover per-request revocation lookup, Claim rejection, and SSE authorization revalidation.
- Revocation ledger append-only: new tests cover UPDATE, DELETE, TRUNCATE rejection.
- Task API redaction: new tests cover Lease Token Hash redaction from Claim, GET and list responses.
- Dashboard: automated regression and responsive CSS checks run in CI.
- Physical iPhone/desktop browser testing: not performed.
- High-volume SSE soak/chaos and long-duration disconnect/reconnect testing: not performed.
- Production Neon migration, Render configuration/deploy, LINE production sends, Google Sheets edits, paid API calls, and external publication: not performed.

## 5. Production readiness decision

**Not approved for production cutover yet.** Reasons:
- Migration 0010 has not been applied to production.
- Owner revocation actor identity is not person-attributable under the current shared Owner token model.
- Handoff target Worker/Grant eligibility is rechecked on Claim, but not transactionally locked in the Handoff commit; stale-target recovery needs hardening.
- Physical-device and high-volume SSE soak tests remain outstanding.

PR #78 remains Draft / Open / unmerged. PR #77 and other Worker branches remain untouched. No production changes were performed.
