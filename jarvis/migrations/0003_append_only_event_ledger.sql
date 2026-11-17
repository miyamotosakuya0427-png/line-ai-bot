CREATE OR REPLACE FUNCTION jarvis.reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'jarvis.events is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS jarvis_events_append_only_row ON jarvis.events;
CREATE TRIGGER jarvis_events_append_only_row
BEFORE UPDATE OR DELETE ON jarvis.events
FOR EACH ROW EXECUTE FUNCTION jarvis.reject_event_mutation();

DROP TRIGGER IF EXISTS jarvis_events_append_only_truncate ON jarvis.events;
CREATE TRIGGER jarvis_events_append_only_truncate
BEFORE TRUNCATE ON jarvis.events
FOR EACH STATEMENT EXECUTE FUNCTION jarvis.reject_event_mutation();

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0003_append_only_event_ledger')
ON CONFLICT (version) DO NOTHING;
