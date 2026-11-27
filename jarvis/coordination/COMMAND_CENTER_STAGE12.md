# ONE JARVIS Command Center — Stage 12 execution record

- PR: #78 (must remain Draft/Open/unmerged)
- Branch: `integration/one-jarvis-command-center-ui`
- Starting Head: `3b1c5da249f2e9f98a7f91bc1d62e663763498ee`
- Isolated test target: PostgreSQL 16
- Production systems touched: none

## 1. Latest PR state at Stage 12 execution

- PR #78 was Open/Draft/unmerged at start.
- PR #77 was Open/Draft/unmerged and was not modified.
- Work was limited to PR #78's branch.
- No force-push, rebase, merge, Render deployment/configuration, production Neon write/migration, LINE send, Google Sheets write, paid API, production Owner/Agent token action, or live IdP configuration was performed.

## 2. Isolated PostgreSQL 16 backup/restore — PASS

Workflow: `ONE JARVIS Stage 12 Isolated Backup Restore`
Successful run: `45819643488`
Exact tested Head: `fb71dc15d4ee5c6bdd1dac83542539413443ea8e`
Artifact: `one-jarvis-stage12-backup-restore` (Artifact ID `15117017115`, 8,310 bytes; expires 2026-12-03)

Evidence from the successful run:
- PostgreSQL server: 16.16.
- `pg_dump` and `pg_restore`: 16.16, matching the server major version.
- Applied migrations 0001 through 0010 in order to a disposable source database.
- Seeded synthetic Task event history (created + agent_handoff), Worker Registry, Worker Scope Grant, Agent Revocation, durable Outbox and scope Cursor.
- Created a real custom-format `pg_dump` file and restored it into a separate empty database using `pg_restore --exit-on-error --no-owner --no-acl`.
- Backup size: 36,189 bytes.
- SHA-256: `6ce410fb1003209ab48d11666fe0e450372563b12f96ffe58aab758bc41b7518`.
- Source/restore fingerprints matched for migration ledger, Event IDs/aggregate versions/order, Worker IDs, Grant keys/scopes, Outbox source-event references/cursors, and Revocation rows.
- Verified two Task events linked to two Outbox records and the scope cursor reached 2.
- Verified restored Event UPDATE and Revocation DELETE are rejected by append-only protections.
- Re-ran migrations 0009 and 0010 in the restored DB and verified existing revocation evidence remained.
- Uploaded the artifact successfully.

The first attempt failed because the Ubuntu runner's PostgreSQL 18 client emitted a setting unsupported by PostgreSQL 16. The workflow was corrected to run the dump/restore script inside the official PostgreSQL 16 image. The next attempt passed its database operation but failed artifact upload because the Docker container created root-owned files. The workflow was corrected to run the container as the runner UID/GID; run 45819643488 then passed all steps including artifact upload.

The source and restore were small synthetic databases. Reported backup/restore elapsed times rounded to 0 seconds at the script's one-second measurement resolution; this is not a production RTO estimate.

## 3. SSE 60-minute endurance and listener/NOTIFY fault harness

Added:
- `jarvis/scripts/command-center-sse-soak.js`
- `.github/workflows/stage12-sse-soak.yml`

The harness exercises the real HTTP SSE endpoint backed by PostgreSQL Outbox and PostgreSQL LISTEN, with three synthetic Agent/Project/Conversation scopes. It targets a 60-minute run, periodic Last-Event-ID reconnects, a deliberately slowed reader, 5-minute NOTIFY wakeup suppression (durable polling must still replay), termination of the PostgreSQL LISTEN backend connection (replay must continue using the pool), and synthetic Agent authorization revocation (stream must close on periodic reauthorization). It records redacted event counts, duplicate/gap counts, reconnect and authorization counts, p50/p95/p99 event latency, process RSS/CPU samples, DB pool metrics and remaining listener connections.

Latest soak run at the time this record was written: `45819906790`, queued/pending. **No 60-minute completion is claimed until that exact run finishes successfully and its metrics artifact is inspected.** The harness's listener-backend termination is not equivalent to restarting the entire PostgreSQL server or testing a full network partition. Slow-reader coverage is a bounded synthetic delay, not yet a measured worst-case backpressure saturation test.

Acceptance conditions include >=3600 seconds, zero unexplained duplicate/cursor-gap events, continued replay during NOTIFY suppression and listener backend loss, observed reauthorization revocation closure, and listener cleanup.

## 4. Existing application/CI verification boundary

The current branch retains the existing:
- SSE scope validation, 3-global / 1-per-Agent cap, Last-Event-ID replay, periodic 15-second authorization, fail-closed revocation-store requirement, and listener cleanup.
- Owner OIDC PKCE request and callback state/nonce checks, signature/issuer/audience/time/nonce/Owner Group verification, HTTPS URL validation, JWKS bounds and Mock IdP tests.
- Dashboard responsive automated markup checks, token redaction checks, existing 13 Department Handler compatibility tests, Task Handoff concurrency/recovery and `outcome_unknown` quarantine tests.

These normal CI tests do not constitute physical iPhone/PC checks or live production service E2E.

## 5. Owner OIDC / Session / Owner audit — NOT production-integrated

- Existing Mock IdP verification remains in place.
- Added isolated policy primitives in `jarvis/core/owner-session-security.js` and tests for `__Host-` Secure/HttpOnly/SameSite cookie formatting, CSRF token generation/constant-time comparison, absolute/idle expiry, revocation decisions, and session-ID rotation triggers.\n- These helpers are not wired into an HTTP authentication route or persistent session store. No authorization-code exchange client, trusted live IdP HTTP transport, CSRF middleware integration, logout/revocation route, or approved real IdP configuration was added.
- No production Owner token or IdP settings were changed.
- The Owner audit migration remains a proposal: nullable issuer/subject/request ID/action, issuer-subject paired-null constraint, append-only enforcement, legacy shared-token operations unattributed, and no retroactive identity attribution.
- Owner decisions remain required for IdP issuer/audience/client/group/redirect, session lifetime and idle timeout, recent-auth policy, dual control, break-glass custodians/expiry/alerts, shared Owner-token migration window and retirement date, audit retention and data residency.


## 5A. Owner audit identity migration proposal — implemented for isolated validation only

Added additive migration `jarvis/migrations/0011_owner_audit_identity.sql`:
- New append-only `jarvis.owner_audit_events` ledger.
- `actor_kind` distinguishes verified `oidc_owner`, `legacy_shared_owner_token`, and `system`.
- Adds `operator_issuer`, `operator_subject`, `request_id`, `action`, metadata and timestamp.
- Database CHECK constraints require issuer and subject to be both null or both present. OIDC Owner rows require an HTTPS issuer, non-empty subject and request ID.
- Legacy shared-token and system events require issuer/subject to remain NULL. No retroactive identity backfill is permitted.
- UPDATE, DELETE and TRUNCATE are rejected by append-only triggers; PUBLIC table/sequence privileges are revoked.
- Migration is idempotent in the same style as the prior additive migrations.

The isolated backup/restore rehearsal was extended to seed one verified-identity-shaped OIDC audit row and one unattributed legacy shared-token row, compare both across restore, reject half-populated issuer/subject, reject UPDATE/DELETE/TRUNCATE, re-run Migration 0011, and confirm both rows remain. This validation passed in run `45821276554` at exact tested Head `01d91ff972b5e0d97549c11e6f058c9a09b8dfa2`. The artifact is `one-jarvis-stage12-backup-restore` (ID `15116979275`, 9,575 bytes). Backup size was 42,604 bytes; SHA-256 `54da41091c2c9d31d0dc1fd360611cb0a303b4b0e901a282c462e47d9ebea39c`. Migration 0011 has not been applied to production.

## 6. DB Chaos / outcome_unknown / Dashboard

- The soak harness deliberately terminates the isolated PostgreSQL LISTEN backend; the pool and durable polling path must recover. It does not stop/restart the PostgreSQL service container or simulate a full network partition.
- Notification suppression is implemented at the listener callback boundary while the durable Outbox poll loop continues. It tests that the application does not depend on wakeups for correctness.
- Existing Task Registry tests cover durable replay and cursor bounds/gaps. The long-run soak adds real HTTP streaming/reconnect evidence when completed.
- Existing Handoff recovery and `outcome_unknown` tests remain normal CI coverage. No real external side effect or human reconciliation was performed.
- Dashboard responsive and 13-department automated tests are not physical device testing.

## 7. Current Stage 12 status

Completed with evidence:
- Isolated PostgreSQL 16 migration application.
- Physical custom-format backup.
- Restore to a separate empty database.
- SHA-256 and row/key/event/outbox/cursor/revocation comparison.
- Restored append-only behavior and safe rerun of migrations 0009/0010.
- Backup/restore artifact upload.

Pending:
- Exact latest-Head normal CI confirmation after the final harness edits.
- SSE 60-minute workflow completion and artifact review.
- Any separate full PostgreSQL server restart/network partition test.
- OIDC server-side code exchange/session/CSRF/logout implementation and live IdP approval.
- Owner audit migration proposal approval and isolated implementation validation.
- Physical device checks.

Do not claim production readiness or enable production SSE/Dispatcher/migrations based on this rehearsal. Production Neon Migration 0010 remains unapplied. PR #78 must remain Draft/Open/unmerged.
