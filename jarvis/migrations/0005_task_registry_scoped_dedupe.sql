-- Scope Task Registry idempotency to project, agent, and conversation.
-- This replaces the legacy global dedupeKey uniqueness rule without changing
-- the append-only event history or existing task payloads.
DROP INDEX IF EXISTS jarvis.events_task_dedupe_key;

CREATE UNIQUE INDEX IF NOT EXISTS events_task_dedupe_key
  ON jarvis.events (
    (payload->>'projectId'),
    (payload->>'ownerAgent'),
    (payload->>'ownerConversation'),
    (payload->>'dedupeKey')
  )
  WHERE aggregate_type = 'task'
    AND event_type = 'created'
    AND payload ? 'dedupeKey';

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0005_task_registry_scoped_dedupe')
ON CONFLICT (version) DO NOTHING;
