# ONE JARVIS Command Center — Stage 5 Outbox Foundation

## Implemented in this commit
- Additive migration 0009 creates `jarvis.task_event_outbox`.
- An AFTER INSERT trigger copies scoped Task event references into the outbox in the same PostgreSQL transaction as the append-only `jarvis.events` insert.
- PostgreSQL NOTIFY carries only an outbox cursor hint. The durable event body remains in `jarvis.events` and is read by cursor from the outbox.
- `createTaskEventOutbox` provides Project/Conversation-scoped cursor replay and a dedicated LISTEN client helper.
- The listener is only a wake-up optimization; callers must replay from the durable cursor after connect/reconnect and periodically to recover missed notifications.

## Security and rollout boundary
- Replay requires exact Project and Conversation IDs and bounds cursor/limit.
- The helper does not expose an HTTP endpoint or authorize principals itself; callers must authorize on every replay.
- Do not enable SSE until the server endpoint revalidates Dashboard and Task Registry credentials during the connection, bounds connection lifetime and output buffering, and closes on revocation.
- Migration 0009 is additive and is not applied at production startup. Only isolated PostgreSQL 16 CI may apply it.
- Existing authenticated 15-second polling remains active.

## Still incomplete
- Authenticated SSE HTTP endpoint and Last-Event-ID integration.
- Server-side periodic token/scope revalidation and disconnect handling.
- Worker Scope Grant management UI.
- Automatic cross-department handoff routing; current Dispatcher handoff remains explicit.
- End-to-end UI tests for real-device iPhone and desktop.
