"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const RETRYABLE_CODES = new Set([
  "08000", "08003", "08006", "08001", "08004", "57P01", "57P02", "57P03",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(error) {
  return Boolean(error && (RETRYABLE_CODES.has(error.code) || error.retryable === true));
}

async function withRetry(operation, {
  attempts = 3,
  baseDelayMs = 100,
  maxDelayMs = 1500,
  sleepImpl = sleep,
  random = Math.random,
  shouldRetry = isRetryable
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new TypeError("attempts must be an integer between 1 and 5");
  }
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt + 1);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !shouldRetry(error)) throw error;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      await sleepImpl(Math.floor(ceiling * (0.5 + random() * 0.5)));
    }
  }
  throw lastError;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function createPool({ connectionString = process.env.NEON_DATABASE_URL, PoolClass, poolOptions = {} } = {}) {
  if (!connectionString) return null;
  const Pool = PoolClass || require("pg").Pool;
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: true },
    allowExitOnIdle: false,
    ...poolOptions
  });
}

function createDbStore({ pool, connectionString, PoolClass, migrationsDir = path.join(__dirname, "migrations"), retryOptions } = {}) {
  const dbPool = pool || createPool({ connectionString, PoolClass });
  if (!dbPool) throw new Error("NEON_DATABASE_URL is not configured");

  async function query(text, values = [], { retry = true } = {}) {
    const run = () => dbPool.query(text, values);
    return retry ? withRetry(run, retryOptions) : run();
  }

  async function ping() {
    const result = await query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }

  async function migrate() {
    const client = await dbPool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", ["one-jarvis-schema-migrations"]);
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      const files = (await fs.readdir(migrationsDir)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
      for (const file of files) {
        const version = file.slice(0, file.indexOf("_"));
        const found = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
        if (found.rowCount) continue;
        const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      return { applied: files.length };
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["one-jarvis-schema-migrations"]); }
      finally { client.release(); }
    }
  }

  async function createJob({ idempotencyKey, type, payload, maxAttempts = 5, runAfter = new Date() }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new TypeError("A valid idempotencyKey is required");
    }
    if (typeof type !== "string" || !/^[a-z][a-z0-9_.-]{1,79}$/.test(type)) throw new TypeError("Invalid job type");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError("Invalid maxAttempts");
    const requestHash = hashPayload({ type, payload });
    const inserted = await query(
      "INSERT INTO jarvis_jobs(idempotency_key, request_hash, type, payload, max_attempts, run_after) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *",
      [idempotencyKey, requestHash, type, payload, maxAttempts, runAfter]
    );
    if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
    const existing = await query("SELECT * FROM jarvis_jobs WHERE idempotency_key = $1", [idempotencyKey]);
    if (!existing.rows[0]) throw new Error("Idempotent job lookup failed");
    if (existing.rows[0].request_hash !== requestHash) {
      const error = new Error("Idempotency key was already used with a different request");
      error.code = "IDEMPOTENCY_CONFLICT";
      error.statusCode = 409;
      throw error;
    }
    return { job: existing.rows[0], created: false };
  }

  async function claimNextJob() {
    const result = await query(
      "WITH candidate AS (SELECT id FROM jarvis_jobs WHERE status = 'queued' AND run_after <= NOW() ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jarvis_jobs j SET status = 'running', attempts = attempts + 1, locked_at = NOW(), updated_at = NOW() FROM candidate WHERE j.id = candidate.id RETURNING j.*",
      [],
      { retry: false }
    );
    return result.rows[0] || null;
  }

  async function recordAttempt({ jobId, attemptNo, status, errorCode = null, errorMessage = null }) {
    if (!["running", "succeeded", "failed", "retrying"].includes(status)) throw new TypeError("Invalid attempt status");
    const result = await query(
      "INSERT INTO jarvis_job_attempts(job_id, attempt_no, status, error_code, error_message, finished_at) VALUES ($1,$2,$3,$4,$5,CASE WHEN $3 = 'running' THEN NULL ELSE NOW() END) ON CONFLICT (job_id, attempt_no) DO NOTHING RETURNING *",
      [jobId, attemptNo, status, errorCode, errorMessage ? String(errorMessage).slice(0, 1000) : null]
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await query("SELECT * FROM jarvis_job_attempts WHERE job_id = $1 AND attempt_no = $2", [jobId, attemptNo]);
    return existing.rows[0] || null;
  }

  async function finishJob({ jobId, success, retryDelayMs = 30000 }) {
    if (typeof success !== "boolean") throw new TypeError("success must be a boolean");
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 86400000) throw new TypeError("Invalid retryDelayMs");
    const sql = success
      ? "UPDATE jarvis_jobs SET status = 'succeeded', completed_at = NOW(), locked_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'running' RETURNING *"
      : "UPDATE jarvis_jobs SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, run_after = CASE WHEN attempts < max_attempts THEN NOW() + ($2 * INTERVAL '1 millisecond') ELSE run_after END, completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE NOW() END, locked_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'running' RETURNING *";
    const result = await query(sql, success ? [jobId] : [jobId, retryDelayMs], { retry: false });
    if (!result.rows[0]) {
      const error = new Error("Job is missing or is not running");
      error.code = "JOB_NOT_RUNNING";
      error.statusCode = 409;
      throw error;
    }
    return result.rows[0];
  }

  async function createApproval({ idempotencyKey, jobId = null, requestedBy, action, payload = {} }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new TypeError("A valid idempotencyKey is required");
    const result = await query(
      "INSERT INTO jarvis_approvals(idempotency_key, job_id, requested_by, action, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *",
      [idempotencyKey, jobId, requestedBy, action, payload]
    );
    if (result.rows[0]) return { approval: result.rows[0], created: true };
    const existing = await query("SELECT * FROM jarvis_approvals WHERE idempotency_key = $1", [idempotencyKey]);
    return { approval: existing.rows[0], created: false };
  }

  async function decideApproval({ approvalId, reviewedBy, decision, reason = null }) {
    if (!["approved", "rejected"].includes(decision)) throw new TypeError("Invalid approval decision");
    const result = await query(
      "UPDATE jarvis_approvals SET status = $2, reviewed_by = $3, decision_reason = $4, reviewed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *",
      [approvalId, decision, reviewedBy, reason ? String(reason).slice(0, 1000) : null]
    );
    if (!result.rows[0]) {
      const error = new Error("Approval is missing or has already been decided");
      error.code = "APPROVAL_ALREADY_DECIDED";
      error.statusCode = 409;
      throw error;
    }
    return result.rows[0];
  }

  async function appendAuditEvent({ eventId = crypto.randomUUID(), actor, action, resourceType, resourceId = null, metadata = {} }) {
    const result = await query(
      "INSERT INTO jarvis_audit_events(event_id, actor, action, resource_type, resource_id, metadata) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO NOTHING RETURNING *",
      [eventId, actor, action, resourceType, resourceId, metadata]
    );
    if (result.rows[0]) return { event: result.rows[0], created: true };
    const existing = await query("SELECT * FROM jarvis_audit_events WHERE event_id = $1", [eventId]);
    return { event: existing.rows[0], created: false };
  }

  async function close() {
    await dbPool.end();
  }

  return { pool: dbPool, query, ping, migrate, createJob, claimNextJob, recordAttempt, finishJob, createApproval, decideApproval, appendAuditEvent, close };
}

module.exports = { createDbStore, createPool, withRetry, isRetryable, hashPayload };
