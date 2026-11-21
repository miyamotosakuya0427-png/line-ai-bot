-- ONE JARVIS Stage 5 finalization: shared Task Registry credential revocation.
-- Apply only in isolated PostgreSQL 16 test databases; never auto-run at startup.
CREATE TABLE IF NOT EXISTS jarvis.task_registry_agent_revocations (
  agent_id text PRIMARY KEY CHECK (length(agent_id) BETWEEN 1 AND 128),
  revoked_at timestamptz NOT NULL,
  revoked_by text NOT NULL CHECK (length(revoked_by) BETWEEN 1 AND 128)
);
CREATE OR REPLACE FUNCTION jarvis.reject_task_registry_revocation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'jarvis.task_registry_agent_revocations is append-only' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS task_registry_agent_revocations_append_only ON jarvis.task_registry_agent_revocations;
CREATE TRIGGER task_registry_agent_revocations_append_only
BEFORE UPDATE OR DELETE ON jarvis.task_registry_agent_revocations
FOR EACH ROW EXECUTE FUNCTION jarvis.reject_task_registry_revocation_mutation();
DROP TRIGGER IF EXISTS task_registry_agent_revocations_append_only_truncate ON jarvis.task_registry_agent_revocations;
CREATE TRIGGER task_registry_agent_revocations_append_only_truncate
BEFORE TRUNCATE ON jarvis.task_registry_agent_revocations
FOR EACH STATEMENT EXECUTE FUNCTION jarvis.reject_task_registry_revocation_mutation();
INSERT INTO jarvis.schema_migrations(version)
VALUES ('0010_task_registry_agent_revocations')
ON CONFLICT (version) DO NOTHING;
