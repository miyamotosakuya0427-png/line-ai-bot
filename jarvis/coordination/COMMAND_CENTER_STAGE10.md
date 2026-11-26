# ONE JARVIS Command Center — Stage 10
## Post-commit Handoff recovery, isolated Owner OIDC, and pre-production verification boundary

- Repository: `miyamotosakuya0427-png/line-ai-bot`
- PR: #78
- Branch: `integration/one-jarvis-command-center-ui`
- Baseline: `37f2139b88003fcc21408b442a12c39962567aaa`
- PostgreSQL target for automated integration: 16
- Production changes: none

## 1. Post-commit Handoff recovery implemented on this branch

Added `createTaskRegistry().recoverPostCommitHandoff` as a dedicated internal transition. It does not accept or manufacture a Task Lease and does not call the ordinary Fenced Writer.

The recovery transaction:
- Serializes recovery attempts with a Task-specific advisory lock and re-reads the latest Task version.
- Requires an existing append-only `agent_handoff` event and verifies the Project, Conversation, Department, and current Agent scope against the original Handoff chain.
- Locks the previous destination and replacement Worker rows in stable `worker_id` order, then checks active Project/Conversation Grants and Agent revocation state before the final Task-version check.
- Treats the old destination as unavailable if its Worker is missing/stopped/busy, its heartbeat is stale, its Grant is revoked/missing, its Agent is revoked, or the live Agent authorization callback says the token is expired/invalid.
- Selects only an idle replacement Worker in the same destination Department with a recent heartbeat, an active scope Grant, a live Agent authorization, and an Agent/Worker identity not already visited in the Handoff route.
- Appends `handoff_reselected` when a replacement is valid; otherwise moves the Task to `waiting` and appends `handoff_recovery_waiting`.
- Preserves the original Handoff version and previous/new Agent and Worker identities in the append-only event.
- Uses a deterministic recovery idempotency key, Task-version fencing, a maximum of three recovery attempts, and route-cycle prevention.
- Leaves a Task waiting without appending repeated no-candidate events until a candidate becomes available. Exhausted Tasks remain waiting for Owner/operator review.

The PostgreSQL dispatch runtime runs a bounded, non-overlapping, 15-second internal recovery scan over queued/waiting Tasks. It checks both prior destination authorization and replacement eligibility. The scheduler only reassigns a Task; it does not perform an external provider action.

### Verification added
- PostgreSQL 16 integration scenario: commit Handoff, revoke the destination Agent, register a replacement Worker/Grant, and verify a lease-free replacement event and queued Task.
- Concurrent recovery attempts using the same pre-recovery Task version: exactly one transition may commit; the stale contender fails closed.
- Runtime unit tests: authorized replacement selection and safe waiting when no replacement exists.

The final exact-Head results are recorded in the PR body after all workflows complete.

## 2. Owner OIDC — isolated module and Mock IdP verification

Added independent module `jarvis/core/owner-oidc.js`. It is not wired into production routes and does not replace the current shared Owner-token authentication.

Implemented in the isolated module:
- Authorization Code + PKCE S256 request construction, cryptographically random State/Nonce/Verifier, and callback State/Nonce validation.
- Explicit RS256/ES256 algorithm allowlist; rejects `none` and unsupported algorithms.
- Signature verification against a JWKS key selected by `kid`, exact Issuer/Audience checks, `azp` validation for multi-audience tokens, `exp`, `nbf`, `iat`, Nonce, and exact Owner Group claim.
- HTTPS-only Issuer/JWKS configuration, bounded JWKS cache, forced refresh on unknown `kid`, and fail-closed behavior when no valid trusted key is available.
- Stable identity is returned only as verified `issuer` + `subject` plus an optional request ID. Caller-supplied `actor` / `operatorName` is not used.

Mock tests use locally generated test-only signing keys and cover valid identity, forged signature, wrong issuer/audience, expiry, not-before, nonce, missing Owner Group, unsupported algorithm, JWKS failure, and key rotation. No live IdP, client, secret, callback, production Owner token, or environment variable was configured.

### Owner approval still required
1. Approved IdP and exact Issuer URL.
2. Client ID / Audience and approved signing algorithms.
3. Exact Owner Group/Role claim and value.
4. Redirect URI and approved domain.
5. Audit retention, access, and operator identity policy.
6. Shared Owner-token migration window and retirement date.
7. Break-glass custody, expiry, dual control, alerting, and emergency revocation.
8. Recent re-authentication / dual approval policy for sensitive actions.

### Audit migration proposal — not applied
A future additive migration may add nullable `operator_issuer`, `operator_subject`, `request_id`, and `action` fields to the relevant append-only Owner audit ledger. Issuer and subject must be both present or both absent. Legacy shared-token events remain explicitly unattributed; no historical identity backfill is allowed. The write boundary must accept a typed identity object only from verified OIDC middleware.

The OIDC module currently provides verification primitives and a PKCE request/callback validator. It does not yet implement the complete server-side authorization-code exchange/session-cookie lifecycle or production HTTP/JWKS transport. A trusted resolver must enforce TLS, redirect rejection, response size/time limits, and issuer metadata pinning before any live use.\n\n### Shared-token transition / Break-glass proposal — requires Owner approval\n- Keep the current shared Owner token unchanged during an explicitly time-limited parallel-validation window; do not silently convert its audit entries into named human identities.\n- During the window, all shared-token actions remain recorded as unattributed legacy actions. New high-risk Owner actions should move to verified OIDC plus explicit approval before the shared-token retirement date.\n- After the approved cutoff, disable ordinary shared-token use. Do not remove the legacy audit trail or backfill operator identity.\n- Emergency Break-glass should use a separately held credential, dual control, a short approved expiry (proposed maximum 15 minutes), mandatory reason/request ID, immediate alerting, and mandatory post-use rotation/review. It must never bypass append-only audit or external-action approval gates.\n- No such migration window, expiry, credential, or policy has been configured.

## 3. SSE and event delivery

Existing automated coverage confirms:
- 3 global SSE connections and 1 connection per Agent.
- 25 sequential reconnect/cancel cycles with listener cleanup.
- 15-second principal revalidation and stream closure on authorization withdrawal.\n- Stage 10 moved periodic reauthorization onto an independent timer so quiet polling or slow notification wakeups cannot defer the check; the timer is cleared when the stream closes.
- Scoped Last-Event-ID replay and durable Outbox reads; NOTIFY is a wake-up hint rather than the source of truth.
- SSE payload allowlisting excludes credentials and hashes.

Not performed in Stage 10:
- Multi-hour/high-volume concurrent-client soak.
- CPU, memory, DB-pool, listener, and socket pressure measurements.
- PostgreSQL network partition/reconnect or process-restart chaos.
- Deliberate LISTEN/NOTIFY loss test under a disconnected listener.
- Physical iPhone/desktop browser test.

The bounded CI reconnect test must not be described as a high-volume soak or production resilience proof.

## 4. outcome_unknown, Dashboard, and Migration 0010

- Existing Task State Machine continues to quarantine ambiguous external outcomes as `outcome_unknown`; reconciliation requires an explicit reconciliation ID and operator identity, and no automatic external replay is permitted. No provider action was run.
- Dashboard responsive/secret-redaction automated regression tests remain in CI. No physical device was available or tested.
- Migration 0010 is tested in isolated PostgreSQL 16, including populated-schema rerun and append-only UPDATE/DELETE/TRUNCATE rejection. No production Neon migration was performed.
- A real isolated backup artifact + restore drill and post-restore row-by-row reconciliation were not performed. Do not treat the migration rerun test as backup/restore evidence.
- Forward-fix and recovery instructions remain documentation until a real isolated backup/restore artifact is exercised.

## 5. Production Neon approval record — no operation performed

Target previously identified for planning only:
- Neon organization: `org-spring-rice-31510024`
- Project: `one-jarvis` / Project ID `super-fog-73704467`
- Intended region: Sydney `aws-ap-southeast-2`
- Production branch ID: `br-floral-field-a71odam5`
- Database: `neondb`

These identifiers are included only to make a future Owner approval request precise. They do not authorize connection, write, migration, restore, branch protection changes, or production cutover. Migration 0010 remains unapplied.

## 6. Explicit Stage 10 completion boundary

Implemented in branch:
- Lease-free, version-fenced post-commit Handoff recovery transition.
- Bounded 15-second recovery scanner.
- Agent expiry/revocation, Worker state/heartbeat, Grant, Project/Conversation scope, attempt limit, idempotency, and cycle checks.
- Isolated Owner OIDC verification module and Mock IdP tests.

Still not completed / not proven:
- Exact final-Head CI is complete; results are recorded in the verification addendum below.
- Multi-hour SSE soak and DB/NOTIFY chaos.
- Full production OIDC code exchange, secure session lifecycle, and approved IdP configuration.
- Owner audit schema migration and approval.
- Real backup/restore drill.
- Physical PC/iPhone validation.
- Production Neon Migration 0010, Render deployment, or production cutover.

PR #78 must remain Draft/Open/unmerged. PR #77 and all other Worker branches remain untouched.


## 7. Final exact-Head verification addendum — 2026-11-26

Exact PR #78 Head: `ba8d8ffa06deed60514a6970a22567e3fd6cc024`

- JARVIS tests — run `45813991652`: success; **322 passed / 0 failed / 4 skipped**.
- ONE JARVIS tests — run `45813992081`: success; **322 passed / 0 failed / 4 skipped**.
- PostgreSQL 16 Task Registry — run `45813991683`: success; **326 passed / 0 failed / 0 skipped**.
- PostgreSQL 16 integration log confirms post-commit recovery with replacement Worker and safe waiting without replacement; bounded non-overlapping recovery scheduler; `outcome_unknown` quarantine/no automatic retry and explicit reconciliation; append-only event/revocation/outbox protections.
- JARVIS and ONE JARVIS logs confirm Mock IdP signature/claims/JWKS/rotation and PKCE/State/Nonce tests, 25 reconnect/cancel cycles, 3-global/1-per-Agent SSE limits, and independent 15-second authorization revalidation (measured approximately 15.0 seconds).
- Dashboard responsive rendering, authenticated API use, and credential non-persistence tests passed. These are automated tests, not physical device checks.
- The CI log intentionally contains PostgreSQL ERROR lines for rejected UPDATE/DELETE attempts against append-only tables; these are expected negative-test assertions, not workflow failures.
- Combined status endpoint returned no individual status contexts; the three workflow runs above are the verified CI evidence.

Not performed: multi-hour/high-volume SSE soak; CPU/memory/DB-pool/socket/listener pressure metrics; PostgreSQL disconnect/reconnect or deliberate NOTIFY-loss chaos; actual backup artifact/restore/post-restore row reconciliation; physical iPhone/PC tests; live IdP integration; production OIDC route/session exchange; production audit migration; production Neon migration 0010.

The three successful CI workflows do not establish production readiness. PR #78 remains Draft/Open/unmerged and PR #77 remains unchanged.
