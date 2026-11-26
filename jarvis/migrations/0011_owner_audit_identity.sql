-- ONE JARVIS Stage 12: append-only, human-attributable Owner audit ledger.
-- Additive and isolated-testable. Do not apply to production without separate Owner approval.
CREATE TABLE IF NOT EXISTS jarvis.owner_audit_events (
  audit_event_id bigserial PRIMARY KEY,
  actor_kind text NOT NULL CHECK (actor_kind IN ('oidc_owner','legacy_shared_owner_token','system')),
  operator_issuer text,
  operator_subject text,
  request_id text,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (operator_issuer IS NULL AND operator_subject IS NULL)
    OR (operator_issuer IS NOT NULL AND operator_subject IS NOT NULL)
  ),
  CHECK (
    (actor_kind='oidc_owner'
      AND operator_issuer IS NOT NULL
      AND operator_issuer ~ '^https://'
      AND length(operator_issuer) BETWEEN 1 AND 512
      AND length(operator_subject) BETWEEN 1 AND 255
      AND request_id IS NOT NULL
      AND length(request_id) BETWEEN 1 AND 128)
    OR
    (actor_kind IN ('legacy_shared_owner_token','system')
      AND operator_issuer IS NULL
      AND operator_subject IS NULL)
  ),
  CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS owner_audit_events_request_id
  ON jarvis.owner_audit_events(request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_audit_events_operator
  ON jarvis.owner_audit_events(operator_issuer,operator_subject,occurred_at DESC)
  WHERE operator_issuer IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_audit_events_action_time
  ON jarvis.owner_audit_events(action,occurred_at DESC);

CREATE OR REPLACE FUNCTION jarvis.reject_owner_audit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'jarvis.owner_audit_events is append-only' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS owner_audit_events_append_only_row ON jarvis.owner_audit_events;
CREATE TRIGGER owner_audit_events_append_only_row
BEFORE UPDATE OR DELETE ON jarvis.owner_audit_events
FOR EACH ROW EXECUTE FUNCTION jarvis.reject_owner_audit_event_mutation();
DROP TRIGGER IF EXISTS owner_audit_events_append_only_truncate ON jarvis.owner_audit_events;
CREATE TRIGGER owner_audit_events_append_only_truncate
BEFORE TRUNCATE ON jarvis.owner_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION jarvis.reject_owner_audit_event_mutation();

REVOKE ALL ON TABLE jarvis.owner_audit_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE jarvis.owner_audit_events_audit_event_id_seq FROM PUBLIC;

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0011_owner_audit_identity')
ON CONFLICT (version) DO NOTHING;
