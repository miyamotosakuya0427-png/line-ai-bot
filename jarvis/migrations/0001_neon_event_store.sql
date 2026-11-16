CREATE SCHEMA IF NOT EXISTS jarvis;

CREATE TABLE IF NOT EXISTS jarvis.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jarvis.events (
  event_id BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 200),
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_unique
  ON jarvis.events (aggregate_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_aggregate_read
  ON jarvis.events (aggregate_type, aggregate_id, aggregate_version);

CREATE INDEX IF NOT EXISTS events_created_at
  ON jarvis.events (created_at);

INSERT INTO jarvis.schema_migrations (version)
VALUES ('0001_neon_event_store')
ON CONFLICT (version) DO NOTHING;

REVOKE ALL ON SCHEMA jarvis FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA jarvis FROM PUBLIC;
