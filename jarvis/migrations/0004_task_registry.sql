-- ONE JARVIS Task Registry v1.
-- Apply only in an isolated PostgreSQL test database during this phase.
-- Production Neon is intentionally not modified.
CREATE TABLE IF NOT EXISTS jarvis.coordination_leases (
  resource_key TEXT PRIMARY KEY CHECK (length(resource_key) BETWEEN 1 AND 240),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coordination_leases_expiry
  ON jarvis.coordination_leases (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS events_task_dedupe_key
  ON jarvis.events ((payload->>'dedupeKey'))
  WHERE aggregate_type = 'task'
    AND event_type = 'created'
    AND payload ? 'dedupeKey';

CREATE INDEX IF NOT EXISTS events_task_latest
  ON jarvis.events (aggregate_id, aggregate_version DESC)
  WHERE aggregate_type = 'task';

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0004_task_registry')
ON CONFLICT (version) DO NOTHING;
