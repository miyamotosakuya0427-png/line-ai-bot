-- ONE JARVIS Stage 5: durable, transactionally coupled Task event outbox.
-- Apply only in isolated PostgreSQL 16 test databases. Never auto-run at startup.
CREATE TABLE IF NOT EXISTS jarvis.task_event_outbox (
  outbox_id bigserial PRIMARY KEY,
  source_event_id bigint NOT NULL UNIQUE REFERENCES jarvis.events(event_id),
  scope_cursor bigint NOT NULL CHECK (scope_cursor > 0),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  conversation_id text NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 128),
  task_id text NOT NULL CHECK (length(task_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_event_outbox_scope_cursor
  ON jarvis.task_event_outbox(project_id,conversation_id,scope_cursor);
CREATE TABLE IF NOT EXISTS jarvis.task_event_outbox_cursors (
  project_id text NOT NULL,
  conversation_id text NOT NULL,
  last_cursor bigint NOT NULL CHECK (last_cursor >= 0),
  PRIMARY KEY(project_id,conversation_id)
);
CREATE OR REPLACE FUNCTION jarvis.enqueue_task_event_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p_project text;
  p_conversation text;
  v_cursor bigint;
BEGIN
  IF NEW.aggregate_type <> 'task' THEN RETURN NEW; END IF;
  p_project := NEW.payload->>'projectId';
  p_conversation := NEW.payload->>'ownerConversation';
  IF p_project IS NULL OR p_conversation IS NULL OR length(p_project) NOT BETWEEN 1 AND 128
     OR length(p_conversation) NOT BETWEEN 1 AND 128 THEN
    RETURN NEW;
  END IF;
  -- Serialize commits within each Project/Conversation so a later cursor cannot
  -- become visible before an earlier cursor in the same replay scope.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project || ':' || p_conversation, 0));
  INSERT INTO jarvis.task_event_outbox_cursors(project_id,conversation_id,last_cursor)
  VALUES(p_project,p_conversation,1)
  ON CONFLICT(project_id,conversation_id) DO UPDATE
    SET last_cursor=jarvis.task_event_outbox_cursors.last_cursor+1
  RETURNING last_cursor INTO v_cursor;
  INSERT INTO jarvis.task_event_outbox(source_event_id,project_id,conversation_id,task_id,event_type,created_at,scope_cursor)
  VALUES(NEW.event_id,p_project,p_conversation,NEW.aggregate_id,NEW.event_type,NEW.created_at,v_cursor)
  ON CONFLICT(source_event_id) DO NOTHING;
  PERFORM pg_notify('jarvis_task_events', v_cursor::text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_event_outbox_after_insert ON jarvis.events;
CREATE TRIGGER task_event_outbox_after_insert
AFTER INSERT ON jarvis.events
FOR EACH ROW EXECUTE FUNCTION jarvis.enqueue_task_event_outbox();

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0009_task_event_outbox')
ON CONFLICT (version) DO NOTHING;

CREATE OR REPLACE FUNCTION jarvis.reject_task_event_outbox_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'jarvis.task_event_outbox is append-only' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS task_event_outbox_append_only_row ON jarvis.task_event_outbox;
CREATE TRIGGER task_event_outbox_append_only_row
BEFORE UPDATE OR DELETE ON jarvis.task_event_outbox
FOR EACH ROW EXECUTE FUNCTION jarvis.reject_task_event_outbox_mutation();
DROP TRIGGER IF EXISTS task_event_outbox_append_only_truncate ON jarvis.task_event_outbox;
CREATE TRIGGER task_event_outbox_append_only_truncate
BEFORE TRUNCATE ON jarvis.task_event_outbox
FOR EACH STATEMENT EXECUTE FUNCTION jarvis.reject_task_event_outbox_mutation();
