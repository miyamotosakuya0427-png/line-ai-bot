# ONE JARVIS Command Center — Stage 3 findings and design

## Verified department inventory

Source of truth: `jarvis/core/department-agents.js`. The array contains 13 definitions and `jarvis/core/department-agent-handlers.js` creates handlers directly from that array. The UI must not count the three missing definitions as Agents.

Existing department IDs:
`jarvis`, `management`, `tax`, `office`, `construction`, `hr`, `procurement`, `recycling`, `safety`, `content`, `affiliate`, `invest`, `trader`.

### Three proposed department candidates — NOT registered

These are organizational proposals only, not existing departments or active Agents. They require owner approval before code registration:
1. 法務・契約管理部 — contract/document review, legal deadline tracking, and escalation to qualified professionals.
2. 営業・顧客管理部 — lead/customer pipeline, proposal drafts, and follow-up scheduling.
3. 情報システム・セキュリティ部 — access inventory, security monitoring, incident triage, and IT asset lifecycle.

No Agent IDs, handlers, online state, or execution permissions are created for these candidates.

## Worker Registry visibility

Migration `0007_execution_kernel_fencing.sql` defines Worker Registry columns for worker/agent/department identity, process/instance, status, current Task, heartbeat, Lease resource key, fencing token and version. It does not define Project or Conversation ownership columns.

The current endpoint therefore safely lists only Workers derived from authorized scoped Tasks' persisted `leaseOwner`, followed by a point lookup. It cannot safely enumerate unrelated idle Workers. Do not infer their Project/Conversation ownership from Agent ID or department.

### Future scope model

Before enabling full idle-Worker listing, add an additive migration for explicit Worker authorization grants, not broad implicit columns:
- `worker_scope_grants(worker_id, project_id, conversation_id, grant_id, granted_by, created_at, revoked_at)`
- Unique active grant semantics for worker/project/conversation.
- Grant/revoke must be an authenticated administrative operation, append-only audited, and transactionally serialized with Worker claim/heartbeat.
- List query must join active grants to the authenticated Project and Conversation and must not expose other scopes.
- Worker registration without a grant remains unscoped and invisible to scoped listings.
- Revocation must block new claims and telemetry visibility; active Lease handling must be separately fenced and audited.
- Token hashes and credentials must never be returned.

This migration is not applied or implemented in this stage.

## Task event history and Agent handoffs

The Task Registry now exposes a bounded `listTaskEvents({taskIds, limit})` read for explicit Task IDs. The command-center endpoint supplies only IDs returned by the authenticated Agent + Conversation + Project Task query. The response allow-lists event fields and does not expose raw payloads.

Handoffs are emitted only for persisted events whose type is one of `agent_handoff`, `department_handoff`, or `task_handoff` and which contain explicit `fromAgentId` and `toAgentId`. Department edges are drawn only when both source and destination department IDs match known departments.

The existing Task Registry transition code primarily writes `created`, `claimed`, `lease_reclaimed`, and `status_changed` events. It does not yet emit formal Agent/Department handoff events. Therefore the handoff panel may correctly show no events; no inferred edges are drawn.

## Realtime transport decision

SSE remains deferred. There is no implemented durable global event cursor, scoped replay endpoint, or PostgreSQL LISTEN/NOTIFY delivery contract. A safe SSE implementation requires:
- Monotonic durable event cursor with stable ordering.
- Replay after Last-Event-ID with bounded retention and gap detection.
- Authorization revalidation during long-lived connections and on replay.
- Backpressure, heartbeat, disconnect, duplicate and out-of-order handling.
- No sensitive event payload broadcast.
Until these are implemented and tested, authenticated 15-second polling remains active.

## Remaining stage gaps

- Full idle Worker listing: blocked on explicit scope grants.
- Formal handoff event production: not yet implemented in Dispatcher/Task Registry.
- Durable SSE + replay: not implemented.
- iPhone/desktop real-device testing: not performed; automated HTML/API tests only.
- Department candidates: awaiting owner approval.
- Existing 13 departments are the only active formal department definitions.
