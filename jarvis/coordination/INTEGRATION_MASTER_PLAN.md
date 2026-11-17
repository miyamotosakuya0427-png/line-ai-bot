# ONE JARVIS Integration Master Plan

監査基準日: 2026-11-18
対象: `miyamotosakuya0427-png/line-ai-bot`
監査対象: PR #43, #46, #55-#71。関連する補完PR #48、今回の検証追加PR #73も記録する。
安全条件: 全PR Draft/Open/未マージ。本書作成時点で本番Neon、Render、LINE、Apps Script、Google Sheetsには接続・変更していない。

## 1. Executive summary

- PR番号順は統合順ではない。PRのBase/Head SHAと実際のブランチ系列を優先する。
- #43はPostgreSQL基盤系列。#46は古い#43 Base SHAに対する試みで、作者説明上は#48に置き換えられた。#46はClosed/未マージ。統合候補は#48だが、#43系列と他のTask Registry系列の統合は別途必要。
- Task Registry系は複数の枝に分岐している。#55から#59/#60/#61/#63が分岐し、#64は#61、#67は#63に積まれている。#58/#62/#65/#68は別の認証・スコープ系列。
- #69/#70/#71はすべて#68をBaseにする兄弟PR。従って#71には#69のPostgreSQL部門Dispatcher、#70のRate Limit実装は自動的に含まれない。
- #71の予約StoreはテストでPostgreSQL接続されるが、JARVIS Server実行時の標準Storeとして接続済みとは確認できない。外部予約Providerも実接続・冪等性契約確認済みではない。
- #71の予約Storeテストは元々0001/0003/0006のみを適用していた。PR #73で0001〜0006連続適用と2回目再適用を追加。PR #73のPostgreSQL 16 CIは成功し、260/260、失敗0、スキップ0。
- この監査では統合・マージを実施していない。各機能の正式実装元は、現状では「統合候補」として扱い、単一の正式基盤として確定するのは依存系列を統合した後とする。

## 2. PR dependency graph

```text
Neon / append-only:
jarvis-paper-trading-learning
  └─ #43 (4e20775) PostgreSQL event + operational stores, migrations 0001-0002
       ├─ #46 (7794022) CLOSED, old base 1bf3620; superseded
       └─ #48 (47c3c41) append-only migration 0003; base is #43 HEAD

Task Registry / Lease:
feature/one-jarvis-task-registry-api (external base branch)
  ├─ #55 (6cfdb82) task/resource lock enforcement
  │    ├─ #59 (653eba0) release/recovery; PG16 CI failure
  │    ├─ #60 (4217cea) claimed lease recovery test
  │    ├─ #61 (2f61200) direct lease release
  │    │    └─ #64 (e13ad37) Worker abort on lease loss
  │    └─ #63 (d1ae3e6) fenced resource writer
  │         └─ #67 (52ca679) fenced writer operation scope
  ├─ #58 (c5011a1) runtime agent auth
  └─ #62 (928db53) agent/task/conversation isolation
       └─ #65 (79a7cdf) project/resource scope
            └─ #68 (3c03946) token expiry/revocation
                 ├─ #69 (e571661) department PostgreSQL dispatch
                 ├─ #70 (5e823f8) API rate limiting
                 └─ #71 (c48880e) scheduling/reservation + dashboard voice
                      └─ #73 (d1a7ab9) full migration-chain test (new)

Department contracts:
jarvis-departments-subsidy-agents (external base branch)
  └─ #56 (3377267) functional departments

feature/one-jarvis-task-registry-api (external base branch)
  └─ #57 (6ce415e) department contracts
       └─ #66 (8b3c87a) department registry + dispatcher
```

注: 図はPRのBase branch / Base SHAとHead branchから確認した系列を表す。外部Base branchの完全な祖先履歴はこのPR群だけでは確定していない。#43系列とTask Registry系列の統合祖先も未確定。PR #46のBase SHAは#43の現在Head SHAではなく、#48が#43の現在HeadをBaseにしている。

## 3. PR inventory

| PR | Base → Head | Head SHA | 状態 | CI at observed head | 主な変更 / dependency |
|---|---|---|---|---|---|
| #43 | jarvis-paper-trading-learning → feature/one-jarvis-neon-postgres-foundation | 4e20775 | Draft/Open | 3 workflows success | Event/approval/job stores、0001-0002 |
| #46 | feature/one-jarvis-neon-postgres-foundation → security/jarvis-postgres-append-only-ledger | 7794022 | Closed, not merged | 2 workflows success | 古い#43 Base。作者説明では#48に superseded |
| #55 | feature/one-jarvis-task-registry-api → fix/one-jarvis-task-resource-lock-enforcement | 6cfdb82 | Draft/Open | 3 success | Task Registry store / Lease enforcement |
| #56 | jarvis-departments-subsidy-agents → feature/one-jarvis-16-functional-departments | 3377267 | Draft/Open | 2 success | Functional departments |
| #57 | feature/one-jarvis-task-registry-api → feature/one-jarvis-sixteen-department-contracts | 6ce415e | Draft/Open | 2 success | Department contracts |
| #58 | feature/one-jarvis-task-registry-api → feature/one-jarvis-task-registry-runtime-auth | c5011a1 | Draft/Open | 3 success | Runtime agent auth |
| #59 | fix/one-jarvis-task-resource-lock-enforcement → fix/one-jarvis-task-release-recovery | 653eba0 | Draft/Open | 2 success, PG16 failure | Lease release/recovery; known regression |
| #60 | fix/one-jarvis-task-resource-lock-enforcement → test/one-jarvis-claimed-lease-recovery | 4217cea | Draft/Open | 3 success | Lease recovery test only |
| #61 | fix/one-jarvis-task-resource-lock-enforcement → fix/one-jarvis-direct-task-lease-release | 2f61200 | Draft/Open | 3 success | Lease release fix |
| #62 | feature/one-jarvis-task-registry-api → security/one-jarvis-agent-task-conversation-isolation | 928db53 | Draft/Open | 3 success | Agent/Conversation/Project scope, migration 0005 |
| #63 | fix/one-jarvis-task-resource-lock-enforcement → feature/one-jarvis-fenced-resource-writer | d1ae3e6 | Draft/Open | 3 success | Fenced writer adapter boundary |
| #64 | fix/one-jarvis-direct-task-lease-release → fix/one-jarvis-worker-abort-on-lease-loss | e13ad37 | Draft/Open | 2 success | Worker abort on lease loss |
| #65 | security/one-jarvis-agent-task-conversation-isolation → security/one-jarvis-project-resource-scope | 79a7cdf | Draft/Open | 3 success | Project/resource scope auth |
| #66 | feature/one-jarvis-sixteen-department-contracts → feature/one-jarvis-department-task-dispatch | 8b3c87a | Draft/Open | 2 success | Department Registry + dispatcher |
| #67 | feature/one-jarvis-fenced-resource-writer → security/one-jarvis-fenced-writer-operation-scope | 52ca679 | Draft/Open | 3 success | Fenced writer operation scope |
| #68 | security/one-jarvis-project-resource-scope → security/one-jarvis-agent-token-expiry-revocation | 3c03946 | Draft/Open | 3 success | Token expiry/revocation |
| #69 | security/one-jarvis-agent-token-expiry-revocation → integration/one-jarvis-department-postgres-dispatch | e571661 | Draft/Open | 3 success | Department PG16 dispatch |
| #70 | security/one-jarvis-agent-token-expiry-revocation → security/one-jarvis-task-registry-rate-limit | 5e823f8 | Draft/Open | 3 success | Rate limit |
| #71 | security/one-jarvis-agent-token-expiry-revocation → feature/one-jarvis-scheduling-reservation-agent | c48880e | Draft/Open | 3 success | Reservation store, approval, browser voice |
| #73 | feature/one-jarvis-scheduling-reservation-agent → audit/one-jarvis-full-migration-chain | d1a7ab9 | Draft/Open | 3 success | Full 0001-0006 migration chain test |

CI summary above reports workflow conclusions at the observed PR head commits. Exact per-PR test counts were not extracted for every workflow; do not infer counts from green workflow badges. Confirmed counts: #43 PG16 229/229 (historical parent run); #62 PG16 248/248; #65 PG16 250/250; #68 PG16 252/252; #69 PG16 265/265; #70 PG16 253/253; #71 PG16 260/260; #73 PG16 260/260. #59 PG16 run 44074942791 failed with 243 pass, 1 fail, 0 skipped. #61 and #67 historical PG16 summaries include one skipped test; skipped is not success.

## 4. Changed-file overlaps and integration conflicts

- Task store overlap: #55, #59, #61, #62, #63 touch `task-registry-store.js` and/or its integration test. #60 changes the integration test only. #64 changes `worker.js` and its tests. These are not safe to merge by cherry-pick without a line-level reconciliation.
- Auth/API overlap: #58, #62, #65, #68 share `task-registry-auth.js`, tests, workflow, runtime docs, and/or Task Registry store/API. #70 and #71 also touch `task-registry-api.js`, tests, docs and `server.js`.
- Department overlap: #56/#66 share `functional-departments.js`; #57/#69 share `department-contracts.js`; #66/#69 share `department-registry.js` and tests.
- Fencing overlap: #63/#67 share `fenced-resource-writer.js` and tests. #67 is a child of #63.
- Neon ledger overlap: #43/#46/#48 touch `postgres-event-store.js`, event-store tests, operational-store integration and Neon workflow/docs. #46 must not be revived; use #48's newer Base as the append-only candidate.
- Reservation overlap: #71 touches `server.js`, `task-registry-api.js`, Task Registry API tests, workflow, migration 0006 and dashboard. It is not a clean isolated feature branch relative to #69/#70.

## 5. Canonical shared-platform responsibilities (provisional)

| Responsibility | Candidate canonical source | Status / required decision |
|---|---|---|
| Agent Registry | `task-registry-auth.js` (#58/#62/#65/#68) | Token-based authorizer exists; no separately persisted Agent Registry lifecycle verified |
| Department Registry | `department-registry.js` (#66/#69) | #66/#69 are separate PRs; reconcile with #56 functional handlers and #57 contracts |
| Worker Registry | `worker.js` + Task Registry lease owner fields | No independent durable Worker Registry established |
| Task Registry | `task-registry-store.js`, `task-registry-api.js` | Candidate core; reconcile #55/#59-#65/#70/#71 |
| Resource Lease | Task Registry store lease methods + `coordination_leases` | Migration 0004; avoid parallel lease implementations |
| Fenced resource writes | `fenced-resource-writer.js` (#63/#67) | Fake adapter tests do not prove real destination atomic fencing; adapter must enforce token at write boundary |
| Conversation Registry | Task ownerConversation / auth scope (#62) | Scoped identifiers exist; no standalone durable conversation/message registry confirmed |
| Project Registry | Task owner/project scope (#62/#65) | Authorization scope exists; no independent project lifecycle registry confirmed |
| Approval Registry | `approval-store.js` (#43) + reservation approval verifier (#71) | Separate approval journal and reservation approval flow need one API/identity contract |
| Audit Log | Append-only `jarvis.events`, migration 0003 (#48) | Trigger blocks UPDATE/DELETE/TRUNCATE; owner/superuser can alter triggers or DDL |
| Idempotency | events unique index, task dedupe (#1/#4/#5), reservation unique index (#6) | Multiple scopes/key formats; define one canonical key/retention contract |
| Rate Limit | `createInMemoryTaskRegistryRateLimiter` (#70) | 120 requests/60s default; process-local only, shared adapter required for multi-instance |
| Retry / Recovery | Worker retry + lease recovery (#55/#59-#64) | Unknown external outcome must be quarantined; never retry unsafe operations blindly |

Do not remove any existing implementation until call sites, data compatibility, tests and migration path have been reconciled.

## 6. PostgreSQL migrations 0001-0006

1. `0001_neon_event_store.sql`: creates schema, migration ledger and append-only event table; aggregate version uniqueness; event idempotency unique index.
2. `0002_job_approval_stores.sql`: expression indexes for job/approval idempotency and latest events; depends on 0001.
3. `0003_append_only_event_ledger.sql`: mutation-reject function and UPDATE/DELETE/TRUNCATE triggers; depends on 0001. PR #48 is the current append-only candidate.
4. `0004_task_registry.sql`: coordination_leases plus task dedupe/latest indexes; depends on events from 0001.
5. `0005_task_registry_scoped_dedupe.sql`: drops global task dedupe index and creates scoped unique index (project/agent/conversation/dedupe); depends on 0004 task event conventions.
6. `0006_scheduling_reservation_store.sql`: reservation latest, reservation idempotency and audit indexes; depends on 0001 events.

### Verified in PR #73

- PostgreSQL 16 workflow run 44126988429 succeeded.
- The integration test applies all six migrations in order, reapplies all six, and verifies all six migration ledger entries.
- Test summary: 260 tests, 260 passed, 0 failed, 0 skipped.
- The test DB is localhost-only, database name must include `test`, and schema reset is gated by `JARVIS_ALLOW_TEST_SCHEMA_RESET=yes`. No production DB is used.

### Remaining migration risks

- Full chain reapplication is tested, but injected mid-migration failure and restart/recovery are not yet tested.
- No down migrations or verified rollback path. Recovery should be forward-fix / restore from isolated snapshot, not destructive down migration.
- 0005 drops and recreates an index. Re-run is safe after a completed migration; an interruption between DROP and CREATE leaves a temporary missing constraint until rerun.
- Existing data compatibility and duplicate scoped keys must be checked before any real production migration.
- 0003 trigger is not an absolute immutability boundary against table owner/superuser/DDL privileges. Separate migration owner and least-privilege runtime role are required.
- RLS is not enabled. API-level project/agent scoping is not equivalent to DB row-level security.
- Reservation store uses transaction-scoped advisory locks; multi-instance safety depends on every writer using the same DB lock and transaction protocol.
- Migration SQL in #73 test is executed against isolated PG16; no Neon or production validation.

## 7. Task / Worker / Lease / Fencing

- Task Registry is event-backed with state transitions, scoped dedupe, and coordination lease metadata.
- #59 has a historical PG16 failure (243 pass, 1 fail). #61 is a separate release fix; #64 is stacked on #61. Do not treat #59's earlier failure as fixed merely because sibling PRs are green.
- #63/#67 provide a fenced writer abstraction and operation scope. A preflight read followed by an external write remains vulnerable to TOCTOU. The real destination must atomically compare the supplied monotonic fencing token with its accepted token in the same write boundary. If provider cannot do this, fail closed.
- #64's AbortSignal/stop-on-lease-loss change is not in #71's ancestry. #71 branch is based on #68, not #64.
- Test multi-worker and multi-instance contention on real PostgreSQL, including expired lease reclaim, token monotonicity, stale-token rejection at the destination, and retry-safe/idempotent side effects.

## 8. PR #71 scheduling and voice integration

Verified source-level properties:
- Proposal checks calendar conflicts and booking availability, persists proposal, and creates a Task Registry task.
- Confirmation requires approval matching operation digest, approval ID and approver identity; rechecks calendar conflict; provider must explicitly declare verified idempotency support.
- Unknown provider outcome is quarantined for reconciliation; do not blindly retry.
- Browser voice is push-to-talk; recognized text is placed in the request field and requires explicit user submit. It is not a wake word or always-on microphone.
- The isolated PostgreSQL reservation test persists state and append-only audit with concurrent transition fencing.

Not complete:
- PostgreSQL reservation adapter is not verified as the runtime-wired production Store.
- No real calendar or booking provider contract has been verified; provider-side idempotency is not established.
- LINE is not a unified conversation/session channel. Shared conversation identity and cross-channel continuation are not implemented.
- Web voice is not the native Windows wake-word assistant. No always-on mic or background recording.
- #69 department dispatch and #70 shared rate limit are siblings of #71, not inherited by it.

## 9. Integration order

1. Freeze and reconcile the Neon event ledger lineage: #43 + #48; retain #46 as closed/superseded reference only.
2. Choose one Task Registry/Lease base. Reconcile #55, #59, #60, #61, #63, #64, #67 at source/diff level; preserve failing regression evidence and prove atomic fencing.
3. Reconcile auth/scope chain #58/#62/#65/#68; define Agent, Project and Conversation identity contracts and decide DB RLS.
4. Integrate department contracts/functional handlers/registry/dispatch: #56/#57/#66/#69. Avoid duplicated definitions and map each department ID to one canonical handler.
5. Integrate #70 rate limiting with shared/distributed storage before multi-instance deployment.
6. Rebase conceptually (not by rewriting existing branches) #71 requirements on the selected common platform; wire Postgres reservation Store at runtime and retain fail-closed provider semantics.
7. Build cross-channel Conversation/Approval/Audit APIs for LINE + Web + Windows voice; keep human confirmation for external side effects.
8. Run full regression, migration recovery, multi-instance concurrency, auth, RLS and security tests in isolated environments.
9. Only after all gates pass, request human review. Do not merge automatically.

## 10. Current blockers and next actions

- [ ] Compare #43, #48 and Task Registry migrations on a common integration branch; prove a single migration directory and event-store contract.
- [ ] Inspect #59 failed test details and document the exact fix/coverage delta in #61/#64.
- [ ] Reconcile #63/#67 actual atomic writer semantics with real supported destinations; fake adapters are insufficient.
- [ ] Determine whether #64's Worker abort semantics can be integrated without regressing the #71 branch.
- [ ] Merge conceptual department registry/contracts/handlers from #56/#57/#66/#69 without duplicated IDs.
- [ ] Replace process-local rate limiter with a shared adapter for multi-instance deployments.
- [ ] Add full-chain injected-failure recovery test and verify rerun from each partial state.
- [ ] Add data compatibility checks for scoped task dedupe and reservation idempotency.
- [ ] Decide RLS and least-privilege database role strategy; do not apply to production in this phase.
- [ ] Wire reservation Store to the runtime through explicit dependency injection and test restart/reconnect behavior.
- [ ] Define shared Conversation IDs and LINE identity mapping before claiming LINE/Web/voice continuity.
- [ ] Keep every PR Draft/Open/unmerged; no production writes or deployment.

## 11. Safety and verification boundaries

Implemented in code ≠ tested. Tested with fake adapters ≠ externally connected. Connected in ChatGPT ≠ connected to deployed JARVIS. CI green ≠ production-ready.
No production Neon, Render, LINE, Apps Script, Google Sheets, Binance, tax filing/payment, paid API, public posting, deletion or secret exposure was performed in this audit.
