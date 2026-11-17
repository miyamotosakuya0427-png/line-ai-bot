-- ONE JARVIS Stage 4: worker registry and DB-enforced fenced resource snapshots.
-- Apply only in an isolated test database during this phase. Never auto-run at startup.
CREATE TABLE IF NOT EXISTS jarvis.worker_registry (
  worker_id text PRIMARY KEY,
  agent_id text NOT NULL,
  department_id text NOT NULL,
  instance_id text NOT NULL,
  process_id text,
  status text NOT NULL CHECK (status IN ('idle','assigned','running','waiting','retrying','stopping','stopped','failed','recovering')),
  current_task_id text,
  heartbeat_at timestamptz NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz,
  lease_resource_key text,
  fencing_token bigint,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_registry_status_heartbeat
  ON jarvis.worker_registry(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS worker_registry_task
  ON jarvis.worker_registry(current_task_id) WHERE current_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS jarvis.fenced_resources (
  resource_id text PRIMARY KEY,
  project_id text NOT NULL,
  payload jsonb NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS jarvis.fenced_operations (
  operation_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  resource_id text NOT NULL,
  project_id text NOT NULL,
  worker_id text NOT NULL,
  task_id text NOT NULL,
  lease_resource_key text NOT NULL,
  fencing_token bigint NOT NULL,
  operation_scope text NOT NULL,
  payload_hash text NOT NULL,
  result_version bigint NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS fenced_operations_resource
  ON jarvis.fenced_operations(resource_id, created_at DESC);

INSERT INTO jarvis.schema_migrations(version)
VALUES ('0007_execution_kernel_fencing')
ON CONFLICT (version) DO NOTHING;

-- Shared, cross-process API quotas. Keys are hashed by the application.
CREATE TABLE IF NOT EXISTS jarvis.api_rate_limit_buckets (
  scope_type text NOT NULL CHECK (scope_type IN ('agent','project','conversation','worker','operation')),
  scope_key text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (scope_type, scope_key)
);
CREATE INDEX IF NOT EXISTS api_rate_limit_buckets_updated
  ON jarvis.api_rate_limit_buckets(updated_at);
