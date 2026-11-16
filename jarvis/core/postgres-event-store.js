"use strict";

const MIGRATION_VERSION = "0001_neon_event_store";
const TRANSIENT_CODES = new Set(["40001", "40P01", "53300", "57P01", "57P02", "57P03", "08000", "08003", "08006", "08001", "08004"]);

function safeInteger(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid " + name);
  return value;
}
function validText(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid " + name);
  return value.trim();
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isTransient(error) { return Boolean(error && (TRANSIENT_CODES.has(error.code) || error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.code === "EPIPE")); }

function createNeonPool({ connectionString = process.env.DATABASE_URL, max = 5, connectionTimeoutMillis = 10000, idleTimeoutMillis = 30000, ssl = true } = {}) {
  if (typeof connectionString !== "string" || !connectionString.trim()) throw new Error("DATABASE_URL is required");
  let Pool;
  try { ({ Pool } = require("pg")); }
  catch { throw new Error("The pg package is required for PostgreSQL storage"); }
  return new Pool({
    connectionString,
    max: safeInteger(max, "pool size", 1, 20),
    connectionTimeoutMillis: safeInteger(connectionTimeoutMillis, "connection timeout", 1000, 60000),
    idleTimeoutMillis: safeInteger(idleTimeoutMillis, "idle timeout", 1000, 120000),
    application_name: "one-jarvis",
    ssl: ssl ? { rejectUnauthorized: true } : false
  });
}

async function retryTransient(operation, { attempts = 3, baseDelayMs = 100, maxDelayMs = 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  safeInteger(attempts, "retry attempts", 1, 5);
  safeInteger(baseDelayMs, "retry base delay", 1, 5000);
  safeInteger(maxDelayMs, "retry maximum delay", baseDelayMs, 10000);
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      if (!isTransient(error) || attempt >= attempts) throw new Error("PostgreSQL operation failed; retry safely after checking transaction outcome");
      await sleep(Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1))));
    }
  }
}

function createPostgresEventStore({ pool, clock = () => new Date().toISOString(), retry = retryTransient } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw new Error("A PostgreSQL pool is required");
  let migrated = false;
  let migrationPromise = null;

  async function migrate() {
    if (migrated) return { ok: true, version: MIGRATION_VERSION };
    if (migrationPromise) return migrationPromise;
    migrationPromise = retry(async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("CREATE SCHEMA IF NOT EXISTS jarvis");
        await client.query("CREATE TABLE IF NOT EXISTS jarvis.schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
        const existing = await client.query("SELECT version FROM jarvis.schema_migrations WHERE version = $1", [MIGRATION_VERSION]);
        if (existing.rowCount === 0) {
          await client.query(`CREATE TABLE IF NOT EXISTS jarvis.events (
            event_id BIGSERIAL PRIMARY KEY,
            aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
            aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 200),
            aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
            event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
            payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
            idempotency_key TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (aggregate_type, aggregate_id, aggregate_version)
          )`);
          await client.query("CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_unique ON jarvis.events (aggregate_type, aggregate_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
          await client.query("CREATE INDEX IF NOT EXISTS events_aggregate_read ON jarvis.events (aggregate_type, aggregate_id, aggregate_version)");
          await client.query("CREATE INDEX IF NOT EXISTS events_created_at ON jarvis.events (created_at)");
          await client.query("INSERT INTO jarvis.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [MIGRATION_VERSION]);
        }
        await client.query("REVOKE ALL ON SCHEMA jarvis FROM PUBLIC");
        await client.query("REVOKE ALL ON ALL TABLES IN SCHEMA jarvis FROM PUBLIC");
        await client.query("COMMIT");
        migrated = true;
        return { ok: true, version: MIGRATION_VERSION };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    });
    try { return await migrationPromise; }
    catch (error) { migrationPromise = null; throw error; }
  }

  async function append({ aggregateType, aggregateId, eventType, payload, idempotencyKey = null, expectedVersion = null } = {}) {
    await migrate();
    aggregateType = validText(aggregateType, "aggregate type", 80);
    aggregateId = validText(aggregateId, "aggregate id", 200);
    eventType = validText(eventType, "event type", 100);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Event payload must be an object");
    if (idempotencyKey !== null) idempotencyKey = validText(idempotencyKey, "idempotency key", 128);
    if (expectedVersion !== null) safeInteger(expectedVersion, "expected version", 0);
    return retry(async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [aggregateType + ":" + aggregateId]);
        if (idempotencyKey) {
          const prior = await client.query("SELECT aggregate_version, event_type, payload, created_at FROM jarvis.events WHERE aggregate_type = $1 AND aggregate_id = $2 AND idempotency_key = $3", [aggregateType, aggregateId, idempotencyKey]);
          if (prior.rows.length) {
            await client.query("COMMIT");
            return { created: false, version: Number(prior.rows[0].aggregate_version), eventType: prior.rows[0].event_type, payload: prior.rows[0].payload, createdAt: prior.rows[0].created_at };
          }
        }
        const current = await client.query("SELECT COALESCE(MAX(aggregate_version), 0)::bigint AS version FROM jarvis.events WHERE aggregate_type = $1 AND aggregate_id = $2", [aggregateType, aggregateId]);
        const version = Number(current.rows[0].version);
        if (expectedVersion !== null && version !== expectedVersion) throw Object.assign(new Error("Aggregate version conflict"), { code: "JARVIS_VERSION_CONFLICT" });
        const createdAt = clock();
        const inserted = await client.query(
          "INSERT INTO jarvis.events (aggregate_type, aggregate_id, aggregate_version, event_type, payload, idempotency_key, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING event_id, aggregate_version, event_type, payload, created_at",
          [aggregateType, aggregateId, version + 1, eventType, JSON.stringify(clone(payload)), idempotencyKey, createdAt]
        );
        await client.query("COMMIT");
        const row = inserted.rows[0];
        return { created: true, eventId: Number(row.event_id), version: Number(row.aggregate_version), eventType: row.event_type, payload: row.payload, createdAt: row.created_at };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    });
  }

  async function list({ aggregateType, aggregateId, afterVersion = 0, limit = 500 } = {}) {
    await migrate();
    aggregateType = validText(aggregateType, "aggregate type", 80);
    aggregateId = validText(aggregateId, "aggregate id", 200);
    safeInteger(afterVersion, "after version", 0);
    safeInteger(limit, "event limit", 1, 1000);
    const result = await pool.query(
      "SELECT event_id, aggregate_version, event_type, payload, idempotency_key, created_at FROM jarvis.events WHERE aggregate_type = $1 AND aggregate_id = $2 AND aggregate_version > $3 ORDER BY aggregate_version ASC LIMIT $4",
      [aggregateType, aggregateId, afterVersion, limit]
    );
    return result.rows.map(row => ({ eventId: Number(row.event_id), version: Number(row.aggregate_version), eventType: row.event_type, payload: row.payload, idempotencyKey: row.idempotency_key, createdAt: row.created_at }));
  }

  async function health() {
    try { await migrate(); await pool.query("SELECT 1"); return { ok: true, storage: "postgresql", schemaVersion: MIGRATION_VERSION }; }
    catch { return { ok: false, storage: "postgresql", error: "database_unavailable" }; }
  }

  return { migrate, append, list, health, close: () => pool.end() };
}

module.exports = { MIGRATION_VERSION, createNeonPool, createPostgresEventStore, retryTransient, isTransient };
