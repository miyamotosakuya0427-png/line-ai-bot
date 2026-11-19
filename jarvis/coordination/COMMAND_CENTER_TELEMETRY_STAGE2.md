# ONE JARVIS Command Center telemetry — Stage 2

## Current verified source inventory

- The authoritative `jarvis/core/department-agents.js` currently defines 13 department records. The UI renders these 13 source-backed departments and three neutral `未定義部門` placeholders to preserve the requested 16-slot layout. The placeholders are not Agents and are never marked online. Do not invent the missing definitions.
- `createCommandCenter().snapshot()` reports department handler configuration and recent Job Store activity. Handler configuration is not proof that an Agent process is online.
- The Task Registry API uses a separate agent-token authorizer with explicit `tasks:read`, Project IDs, and Conversation identity.
- PostgreSQL Worker Registry has point lookup by worker ID; there is no authorized global worker-list API in this stage.

## Scoped telemetry endpoint

`GET /v1/command-center/telemetry` requires both:
1. The normal JARVIS Dashboard bearer token.
2. A separate Task Registry agent token in `X-Task-Registry-Authorization`.

The server validates `tasks:read`, the authenticated Agent ID, Project IDs, and Conversation identity. It queries Task Registry only for those scopes and uses the shared PostgreSQL Rate Limiter. Worker IDs are derived only from the scoped Tasks' persisted lease owners; point lookups then return sanitized Worker status, heartbeat timestamp, Lease expiry, fencing token, and version. No global Worker enumeration is exposed.

Task and Worker token hashes and raw lease tokens are excluded from the response. Task payloads are allow-listed to operational fields. A missing credential, scope, PostgreSQL kernel, or shared limiter fails closed.

## Dashboard behavior

- 15-second polling is retained.
- Task Registry credential is optional at UI connection time, but Task/Worker telemetry remains unavailable until supplied and authorized.
- The dashboard displays only scoped Tasks and Workers. Worker visibility is limited to workers associated with Tasks in the caller's authorized Project/Conversation scope; idle unrelated Workers are intentionally not enumerated.
- Unknown Agent status remains unknown. Configured handlers and historical jobs do not cause an Agent to appear online.
- The 16-slot visual contains 13 defined departments plus three explicit undefined placeholders.
- External SNS metrics and developer Agent status remain unconnected until a verified source exists.

## Realtime transport decision

SSE/WebSocket is deferred. The current codebase does not expose a durable, authenticated event stream backed by PostgreSQL `LISTEN/NOTIFY` or a replayable cursor contract. Adding a socket now without durable ordering, replay, authorization revalidation, and reconnect semantics would overstate realtime guarantees. The dashboard therefore retains 15-second authenticated polling.

## Remaining work

- Establish authoritative definitions for the three missing departments before replacing placeholders.
- Add a scoped Worker Registry query for idle Workers, with explicit Project/Conversation ownership metadata, before showing all Workers.
- Add durable event cursor + PostgreSQL notification/replay design before SSE.
- Add a verified Worker heartbeat freshness policy; do not infer offline from a stale heartbeat while its Lease remains valid.
- Extend API to provide per-Agent event handoffs and structured progress only when such records are persisted.
- Browser UI has no access to production DB or external systems directly; all access stays behind server-side auth and scope checks.
