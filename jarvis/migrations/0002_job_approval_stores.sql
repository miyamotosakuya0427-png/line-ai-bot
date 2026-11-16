-- ONE JARVIS operational store migration.
-- Uses the append-only jarvis.events ledger from migration 0001.
CREATE INDEX IF NOT EXISTS events_job_idempotency_lookup
  ON jarvis.events ((payload->>'idempotencyKey'), event_id DESC)
  WHERE aggregate_type = 'job' AND payload ? 'idempotencyKey';

CREATE INDEX IF NOT EXISTS events_approval_idempotency_lookup
  ON jarvis.events ((payload->>'idempotencyKey'), event_id DESC)
  WHERE aggregate_type = 'approval' AND payload ? 'idempotencyKey';

CREATE INDEX IF NOT EXISTS events_operational_latest
  ON jarvis.events (aggregate_type, aggregate_id, aggregate_version DESC)
  WHERE aggregate_type IN ('job', 'approval');

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0002_job_approval_stores')
ON CONFLICT (version) DO NOTHING;
