# ONE JARVIS Command Center — Stage 11
## Backup/restore proof, SSE endurance/chaos, Owner OIDC preparation, and production approval boundary

- Repository: `miyamotosakuya0427-png/line-ai-bot`
- PR: #78
- Branch: `integration/one-jarvis-command-center-ui`
- Starting Head: `f791dc0473ebd0c6bb3c2f3dec289c8b8e6051f9`
- PostgreSQL integration target: 16
- Production changes: none

## 1. Execution boundary and environment

The available execution container has Node.js 22 but no Docker, Podman, `psql`, or `pg_dump` binary. No isolated PostgreSQL server or backup utility is available in this execution session. The GitHub PostgreSQL 16 workflow is the available integration environment, but its existing Task Registry job is a short integration test, not a physical backup/restore drill or a multi-hour SSE soak. Consequently, this stage does not claim that a real backup artifact was restored or that one-hour endurance/DB chaos tests passed.

No production Neon connection was opened. The following production identifiers are planning-only and do not authorize access or change:
- Neon organization: `org-spring-rice-31510024`
- Project: `one-jarvis`, Project ID `super-fog-73704467`
- Production branch: `br-floral-field-a71odam5`
- Database: `neondb`

## 2. Owner OIDC hardening implemented

Updated `jarvis/core/owner-oidc.js`:
- Authorization and callback URLs must use HTTPS and reject URL userinfo and fragments.
- Scope list must be non-empty, contain `openid`, use constrained scope tokens, and contain no duplicates.
- Issuer and JWKS URLs must use HTTPS and reject userinfo/fragments.
- JWKS payload has a configurable bounded serialized size (default 64 KiB, hard configuration maximum 256 KiB) and a maximum of 100 keys.
- Signing keys must explicitly declare `use: "sig"`; if `key_ops` is present it must be exactly `["verify"]`.
- Private JWK material is rejected.
- RSA signing keys below 2048 bits are rejected.
- Existing pinned algorithm allowlist, signature/issuer/audience/time/nonce/Owner Group checks and fail-closed key selection remain in place.

Added Mock IdP tests for encryption-only keys, signing-only key operations, private JWK material, oversized JWKS responses, URL fragments and unsafe URL userinfo.

Important: this remains a verification primitive, not a production OIDC integration. There is no authorization-code token exchange, trusted live HTTP/JWKS transport, server session-cookie lifecycle, logout/revocation endpoint, or configured IdP. The resolver supplied by future integration must independently enforce TLS certificate validation, redirect rejection, DNS/IP egress policy, connection/read timeouts, response byte limits, content type, issuer metadata pinning, and safe JSON parsing. Do not connect a real IdP until Owner approval and independent security review.

## 3. Backup/restore runbook — NOT EXECUTED

Required isolated PostgreSQL 16 rehearsal:
1. Start two disposable PostgreSQL 16 databases/instances with separate names and no production credentials.
2. Apply migrations 0001 through 0010 in order to the source DB using the approved migration runner; record schema migration versions.
3. Seed synthetic Task, Worker, Scope Grant, Agent Revocation, Handoff Event, Outbox and append-only event data.
4. Record row counts and deterministic checksums for primary keys, event IDs/aggregate versions, scope cursors, revocation IDs, and Outbox source-event references.
5. Create a custom-format artifact using `pg_dump --format=custom --no-owner --no-acl`.
6. Restore into a clean, separate destination database using `pg_restore --exit-on-error --no-owner --no-acl`; do not use `--clean` or `--create`.
7. Compare counts, key sets, referential integrity, event ordering, cursor continuity, Outbox/Event joins, revocation ledger, schema_migrations and append-only triggers.
8. Re-run only migrations documented as idempotent; verify no duplicate rows/triggers/indexes and no mutation of audit rows.
9. Run application read-path tests against the restored DB.
10. Record artifact SHA-256, byte size, backup/restore durations, PostgreSQL version, errors, row deltas, and test report. Do not store credentials or connection strings in artifacts/logs.

Safe command outline (isolated host only):
```sh
pg_dump --format=custom --no-owner --no-acl --file=jarvis-stage11.dump "$SOURCE_DATABASE_URL"
sha256sum jarvis-stage11.dump
createdb --maintenance-db="$DESTINATION_ADMIN_URL" jarvis_stage11_restore
pg_restore --exit-on-error --no-owner --no-acl --dbname="$DESTINATION_DATABASE_URL" jarvis-stage11.dump
```
The URLs above are placeholders; never commit them, print them, or pass production credentials. This runbook is not evidence of a completed restore. No real backup artifact, restore, or post-restore comparison was produced in this stage.

## 4. SSE load/chaos — NOT EXECUTED

Existing CI proves bounded connection/reconnect behavior, scoped replay, listener cleanup and periodic reauthorization under short automated tests only. It does not prove one-hour endurance, multiple-Agent/Project high-load behavior, resource stability, PostgreSQL connection interruption/recovery, or deliberate NOTIFY loss.

Required separate isolated soak job:
- Run a 60-minute baseline plus a 60-minute reconnect/slow-reader profile.
- Record concurrent streams, per-Agent and global caps, event latency p50/p95/p99, reconnect counts, replay lag, cursor gaps, duplicate count, HTTP errors, CPU, RSS/heap, event-loop delay, PostgreSQL pool active/idle/waiting, backend connections, listener count, socket count and cleanup time.
- Inject PostgreSQL disconnect/reconnect and suppress/drop NOTIFY wakeups. Confirm durable Outbox replay recovers events independently of NOTIFY.
- Exercise Last-Event-ID, cursor-ahead rejection, cursor-gap fail-closed behavior, duplicate suppression, slow readers, bounded queues, cancellation, and 15-second reauthorization after credential revocation.
- Require zero unexplained cursor gaps, zero cross-scope events, zero secret/token/hash leakage, no unbounded queue growth, and listener/socket counts returning to baseline.
- Keep this job separate from fast PR CI; never use production credentials or production endpoints.

No one-hour soak, resource metric collection, PostgreSQL fault injection, or deliberate NOTIFY-loss experiment was run in this execution.

## 5. OIDC production integration requirements and Owner decisions

No live IdP details have been approved. Owner must explicitly provide/approve:
1. IdP vendor and exact Issuer URL.
2. Client ID and Audience.
3. Exact Owner Group/Role claim name and value.
4. Redirect URI, allowed origin, and callback route.
5. Signing algorithm allowlist and key-rotation expectations.
6. Session lifetime, idle timeout, reauthentication and logout/revocation policy.
7. Audit retention, operator identity access, and data residency policy.
8. Shared Owner-token parallel migration window and retirement date.
9. Break-glass custodians, dual-control approval, expiry, alerting, emergency revocation, and post-use audit.
10. Whether sensitive actions require recent authentication or dual approval.

Recommended audit migration (proposal only):
- Add nullable `operator_issuer`, `operator_subject`, `request_id`, and `action` fields to the relevant append-only Owner audit ledger.
- Enforce issuer/subject both-null-or-both-present.
- New OIDC-authenticated actions must persist only the verified identity object from middleware.
- Legacy shared-token events remain unattributed; never backfill a human identity.
- Preserve append-only semantics and add an audit schema version. Do not apply a migration until Owner approval and an isolated backup/restore rehearsal are complete.

## 6. Migration 0010 preflight/postflight approval checklist — NOT RUN ON PRODUCTION

Target approval record:
- Project: `one-jarvis` / `super-fog-73704467`
- Branch: `br-floral-field-a71odam5`
- Database: `neondb`

Preflight queries (execute only after a separately approved isolated rehearsal; production execution requires a separate explicit change approval):
```sql
SELECT current_database(), current_user, version();
SELECT to_regclass('jarvis.schema_migrations') AS migration_ledger;
SELECT to_regclass('jarvis.task_registry_agent_revocations') AS revocation_ledger;
SELECT version FROM jarvis.schema_migrations
 WHERE version IN ('0008_worker_scope_grants','0009_task_event_outbox','0010_task_registry_agent_revocations')
 ORDER BY version;
SELECT count(*) AS revocation_rows
  FROM jarvis.task_registry_agent_revocations;
```
The preflight must first verify that the schema and migration ledger exist; if any required object is absent, stop rather than assuming a clean/compatible DB.

Postflight checks:
```sql
SELECT version FROM jarvis.schema_migrations
 WHERE version='0010_task_registry_agent_revocations';
SELECT count(*) AS revocation_rows
  FROM jarvis.task_registry_agent_revocations;
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid='jarvis.task_registry_agent_revocations'::regclass
   AND NOT tgisinternal
 ORDER BY tgname;
SELECT has_table_privilege(current_user,
  'jarvis.task_registry_agent_revocations','UPDATE') AS can_update,
       has_table_privilege(current_user,
  'jarvis.task_registry_agent_revocations','DELETE') AS can_delete;
```
The deployment identity must not be assumed to have safe privileges from these checks alone. Verify trigger behavior with attempted UPDATE/DELETE/TRUNCATE only in disposable isolated DBs. Never attempt destructive probes on production.

## 7. Forward-fix and recovery rules

- Prefer a new additive migration with a unique version and explicit preconditions.
- Never rewrite an applied migration.
- Never DROP/TRUNCATE or disable append-only audit/revocation triggers to recover.
- Take and verify an isolated backup before any future approved schema change.
- If postflight fails, stop rollout, preserve logs without secrets, quarantine dependent functionality, and prepare a forward-fix. Do not improvise destructive rollback.
- Keep authenticated polling fallback if SSE durable replay or shared revocation storage is unavailable.
- Keep external operations blocked while outcome is `outcome_unknown`; require human reconciliation and a unique Reconciliation ID before any permitted state resolution.

## 8. Stage 11 execution status

Implemented:
- OIDC endpoint/scope validation hardening.
- JWKS payload size/key count bounds.
- Signing-key usage, key_ops, private-material and RSA strength validation.
- Mock IdP regression tests for these controls.

Not completed / not evidenced:
- Physical PostgreSQL 16 backup artifact and restore.
- Post-restore row-by-row/key-set/checksum comparison.
- One-hour or longer SSE soak.
- CPU/memory/DB pool/listener/socket measurement.
- PostgreSQL disconnect/reconnect and deliberate LISTEN/NOTIFY loss chaos.
- Full production OIDC code exchange, session lifecycle, live IdP and Owner approval.
- Owner audit migration implementation/application.
- Physical iPhone/PC tests.
- Production Neon Migration 0010.
- Production cutover readiness.

PR #78 must remain Draft/Open/unmerged. PR #77 and all other Worker branches remain untouched. No production Neon, Render, LINE, Google Sheets, Owner Token, Agent Token, IdP, paid API, or external publication action was performed.
