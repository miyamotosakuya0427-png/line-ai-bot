-- ONE JARVIS Command Center Stage 4: explicit Worker Project/Conversation grants.
-- Apply only in isolated PostgreSQL 16 test databases. Never auto-run at startup.
CREATE TABLE IF NOT EXISTS jarvis.worker_scope_grants (
  grant_id uuid PRIMARY KEY,
  worker_id text NOT NULL REFERENCES jarvis.worker_registry(worker_id),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  conversation_id text NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 128),
  granted_by text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_scope_grants_active_unique
  ON jarvis.worker_scope_grants(worker_id,project_id,conversation_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS worker_scope_grants_scope_active
  ON jarvis.worker_scope_grants(project_id,conversation_id,worker_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS worker_scope_grants_worker_history
  ON jarvis.worker_scope_grants(worker_id,created_at DESC);

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0008_worker_scope_grants')
ON CONFLICT (version) DO NOTHING;
