-- Durable reservation state and append-only audit events share the existing jarvis.events ledger.
-- This migration is for isolated PostgreSQL test environments only in this phase.
CREATE INDEX IF NOT EXISTS events_reservation_latest
  ON jarvis.events (aggregate_id, aggregate_version DESC)
  WHERE aggregate_type = 'reservation';

CREATE UNIQUE INDEX IF NOT EXISTS events_reservation_idempotency
  ON jarvis.events ((payload->>'idempotencyKey'))
  WHERE aggregate_type = 'reservation'
    AND event_type = 'created'
    AND payload ? 'idempotencyKey';

CREATE INDEX IF NOT EXISTS events_reservation_audit_latest
  ON jarvis.events (aggregate_id, aggregate_version DESC)
  WHERE aggregate_type = 'reservation_audit';

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0006_scheduling_reservation_store')
ON CONFLICT (version) DO NOTHING;
