# ONE JARVIS Command Center — Stage 9
## Handoff concurrency, Owner identity readiness, SSE connection soak, and Migration 0010 review

- Repository: `miyamotosakuya0427-png/line-ai-bot`
- PR: #78
- Branch: `integration/one-jarvis-command-center-ui`
- Baseline Head: `9ae4370eb2f67f4b730b52a0c0479618a5f00f07`
- PostgreSQL: 16
- Production changes: none

## 1. Handoff lock-order hardening

Stage 8 correctly locked the source Worker and target Worker inside the Handoff transaction, but acquired those locks source-first. Two opposite-direction Handoffs could therefore lock the same pair in reverse order and deadlock.

Stage 9 changes the Handoff transaction to select and lock both Worker rows in a single query ordered by `worker_id` (`ORDER BY worker_id FOR UPDATE`). It then resolves source and target from the locked set, validates target identity/Department/idle state/no active Task/heartbeat, locks the active Project/Conversation Grant `FOR SHARE`, and validates Agent revocation. This establishes a consistent Worker → Grant → Agent-revocation lock order for Handoff and Grant revocation.

## 2. Added PostgreSQL 16 integration coverage

- Duplicate Handoff is now submitted by two independent OS child processes with separate PostgreSQL pools; exactly one process creates the Handoff and the other receives the idempotent replay.
- Added rejection/rollback assertions for missing destination Worker, mismatched Agent ID, mismatched Department, missing Grant, revoked Grant, and stopped destination Worker.
- Each rejected Handoff asserts the source Task state/version, source Worker binding, Task Lease, Task event history, and durable Outbox remain unchanged; the fixture then performs explicit test cleanup.
- Added a concurrent Grant-revocation vs Handoff test. Both operations serialize on destination Worker/Grant locks. If revocation wins, Handoff fails without partial state; if Handoff commits first, the subsequent revocation prevents destination Claim.
- Added a concurrent Agent-revocation vs Handoff test using separate Handoff child process and PostgreSQL advisory-lock serialization. A revocation that wins prevents Handoff; a Handoff that wins first is still prevented from later Claim after revocation.
- Added a concurrent destination Worker stop vs Handoff test. The Worker row lock serializes the operations. If Worker stop commits first, Handoff fails. If Handoff commits first and the Worker is then stopped, destination Claim fails closed.
- Migration 0010 is re-executed against an existing populated test schema; the prior revocation audit row must remain present. Existing tests continue to reject UPDATE, DELETE, and TRUNCATE on the append-only ledger.

These are isolated PostgreSQL integration tests. They are not production database tests.

## 3. Handoff post-commit destination failure — known operational gap

The transaction guarantees the destination is eligible at Handoff commit. It cannot guarantee the Worker remains available forever after commit. The new Worker-stop race test verifies that a later stopped Worker cannot Claim.

The current Dispatcher does not yet include a dedicated no-Lease system transition that atomically moves a queued Handoff Task back to `waiting` and reselects a different target Worker after a post-commit destination failure. Until that recovery path is implemented and tested, an affected Task may remain queued and require controlled operator/Dispatcher recovery. Do not claim automatic post-commit target reselection is complete.

## 4. Owner individual identity — implementation-ready design, not enabled

The existing Owner endpoint still authenticates a shared bearer token and writes the fixed actor label `owner-token`. This proves shared-secret possession only. It does not identify a human. The API body field `ownerApproval: true` is a workflow confirmation flag, not a human identity credential.

### Required OIDC profile

- Owner interactive login must use Authorization Code + PKCE with an organization-approved IdP.
- Server-side verification must use trusted issuer metadata/JWKS over TLS and a pinned allowlist of signing algorithms (no `none`, no caller-selected algorithm).
- Validate signature, exact `iss`, expected `aud`, `exp`, `nbf`, reasonable `iat`/clock skew, `azp` where applicable, nonce for the browser login flow, and an exact approved Owner group/role claim.
- Reject missing, ambiguous, oversized, expired, wrong-issuer, wrong-audience, or unapproved-group claims. Fail closed if JWKS cannot be refreshed and no still-valid trusted key is cached.
- Derive the audit identity only from verified `iss` + `sub`. Display name/email are non-authoritative metadata and must not be used as the stable identity key.
- Never accept `actor`, `operatorName`, `iss`, or `sub` from the request body as proof of identity.
- Never log or persist ID tokens, access tokens, refresh tokens, cookies, Authorization headers, JWTs, or credential hashes.

### Audit schema proposal (requires a separately reviewed migration)

Retain the existing append-only revocation ledger and add nullable structured fields in a future additive migration:
- `operator_issuer`
- `operator_subject`
- `request_id`
- `action`

Require issuer and subject to be either both present or both absent. Legacy shared-token records remain explicitly unattributed (e.g. `legacy_shared_owner`); do not backfill a human identity. The server must supply structured identity only from a successfully verified authentication middleware result. The revocation store should reject caller-supplied actor strings and accept a typed, verified identity object from that trusted boundary.

### Owner decisions required before implementation

1. Approved IdP and exact issuer URL.
2. Client ID / audience and approved signing algorithms.
3. Exact Owner group/role claim and claim value.
4. Operator identity retention and audit access policy.
5. Whether the shared Owner bearer token remains available during a time-limited migration window.
6. Break-glass access, credential custody, expiry, dual-control requirements, and incident revocation procedure.
7. Approval policy for sensitive operations and whether recent re-authentication is required.

No IdP, client, secret, callback URL, Owner token, or production environment variable was configured or changed in Stage 9.

## 5. SSE connection-capacity / reconnect test

Added an HTTP-level test against the actual Command Center SSE route:
- Three distinct Agents can hold the three global connection slots.
- A second connection for the same Agent is rejected with HTTP 429.
- A fourth distinct Agent is rejected with HTTP 429.
- Cancelling a stream releases its slot and listener; a new Agent can connect.
- Twenty-five sequential connect/cancel cycles assert that all 29 listeners are closed.
- Added a periodic authorization test that waits through the 15-second revalidation boundary and confirms the stream closes and listener cleanup occurs when authorization is withdrawn.

This is a bounded automated HTTP test, not a high-volume production-like soak. It does not measure CPU/memory/DB pool pressure under thousands of clients, nor does it simulate PostgreSQL network partitions, NOTIFY loss, process restart, or long-duration listener leaks. Those remain separate pre-production tests.

## 6. outcome_unknown and Dashboard

The existing Task State Machine continues to require a reconciliation ID and operator identity to resolve `outcome_unknown`; expired running Tasks are quarantined and are not automatically replayed. No external provider action was executed. Stage 9 did not perform a new provider-side reconciliation or a physical-device browser test.

Automated Dashboard/SSE regression tests are not equivalent to PC/iPhone real-device validation. No physical iPhone or desktop browser test was performed.

## 7. Migration 0010 final review

- The PostgreSQL 16 integration setup applies migrations 0001 and 0003–0010 to an isolated test schema.
- Stage 9 additionally reruns Migration 0010 against a populated test schema and checks that the existing revocation row remains present.
- UPDATE, DELETE, and TRUNCATE rejection assertions remain in place.
- Production Neon has not been accessed for this stage; Migration 0010 has not been applied to production.
- A real backup/restore drill using the production-equivalent backup artifact and isolated restore target was not performed. The written backup/restore and forward-fix plan remains a precondition, not a passed test.
- No destructive rollback or audit-ledger erasure is permitted.

## 8. Verification boundary and outstanding items

Stage 9 CI must be evaluated on the exact final PR Head. Report individual workflow outcomes and PostgreSQL test counts only from the corresponding completed run logs.

Not performed:
- High-volume / multi-hour SSE soak and CPU/memory/DB-pool measurements.
- PostgreSQL network partition, process restart, NOTIFY-loss chaos test.
- Physical iPhone / PC browser test.
- Production-equivalent backup/restore drill.
- Live OIDC Owner login integration.
- Automatic post-commit Handoff target reselection to `waiting`.
- Production Neon Migration 0010.

No production Neon writes/migration, Render config/deploy, LINE send, Google Sheets edit, paid API, external publication, production Agent token operation, or production Owner credential change was performed.

PR #78 remains Draft / Open / unmerged. PR #77 and all other Worker branches remain untouched.
