CREATE TABLE IF NOT EXISTS jarvis_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jarvis_jobs_claim_idx ON jarvis_jobs(status, run_after, created_at);

CREATE TABLE IF NOT EXISTS jarvis_job_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jarvis_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('running','retrying','succeeded','failed')),
  error_code VARCHAR(100),
  error_message VARCHAR(1000),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE(job_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS jarvis_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  job_id UUID REFERENCES jarvis_jobs(id) ON DELETE SET NULL,
  requested_by VARCHAR(200) NOT NULL,
  action VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  reviewed_by VARCHAR(200),
  decision_reason VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  CHECK ((status = 'pending' AND reviewed_at IS NULL) OR (status IN ('approved','rejected','expired') AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jarvis_approvals_pending_idx ON jarvis_approvals(status, created_at);

CREATE TABLE IF NOT EXISTS jarvis_audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  actor VARCHAR(200) NOT NULL,
  action VARCHAR(120) NOT NULL,
  resource_type VARCHAR(120) NOT NULL,
  resource_id VARCHAR(200),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS jarvis_audit_resource_idx ON jarvis_audit_events(resource_type, resource_id, created_at);
