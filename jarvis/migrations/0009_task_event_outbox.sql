-- ONE JARVIS Stage 5: durable, transactionally coupled Task event outbox.
-- Apply only in isolated PostgreSQL 16 test databases. Never auto-run at startup.
CREATE TABLE IF NOT EXISTS jarvis.task_event_outbox (
  outbox_id bigserial PRIMARY KEY,
  source_event_id bigint NOT NULL UNIQUE REFERENCES jarvis.events(event_id),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  conversation_id text NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 128),
  task_id text NOT NULL CHECK (length(task_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS task_event_outbox_scope_cursor
  ON jarvis.task_event_outbox(project_id,conversation_id,outbox_id);
CREATE OR REPLACE FUNCTION jarvis.enqueue_task_event_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p_project text;
  p_conversation text;
BEGIN
  IF NEW.aggregate_type <> 'task' THEN RETURN NEW; END IF;
  p_project := NEW.payload->>'projectId';
  p_conversation := NEW.payload->>'ownerConversation';
  IF p_project IS NULL OR p_conversation IS NULL OR length(p_project) NOT BETWEEN 1 AND 128
     OR length(p_conversation) NOT BETWEEN 1 AND 128 THEN
    RETURN NEW;
  END IF;
  INSERT INTO jarvis.task_event_outbox(source_event_id,project_id,conversation_id,task_id,event_type,created_at)
  VALUES(NEW.event_id,p_project,p_conversation,NEW.aggregate_id,NEW.event_type,NEW.created_at)
  ON CONFLICT(source_event_id) DO NOTHING;
  PERFORM pg_notify('jarvis_task_events', currval(pg_get_serial_sequence('jarvis.task_event_outbox','outbox_id'))::text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_event_outbox_after_insert ON jarvis.events;
CREATE TRIGGER task_event_outbox_after_insert
AFTER INSERT ON jarvis.events
FOR EACH ROW EXECUTE FUNCTION jarvis.enqueue_task_event_outbox();
