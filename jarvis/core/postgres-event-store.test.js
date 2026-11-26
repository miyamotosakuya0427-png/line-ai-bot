"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPostgresEventStore, retryTransient, isTransient } = require("./postgres-event-store");

function fakePool() {
  const state = { rows: [], queries: [], released: 0 };
  const pool = {
    state,
    async connect() {
      return { async query(sql, params = []) {
        state.queries.push({ sql, params });
        if (sql.startsWith("SELECT version FROM")) return { rowCount: 1, rows: [{ version: "0001_neon_event_store" }] };
        if (sql.startsWith("SELECT pg_advisory")) return { rowCount: 1, rows: [{}] };
        if (sql.startsWith("SELECT aggregate_version")) {
          const row = state.rows.find(x => x.aggregate_type === params[0] && x.aggregate_id === params[1] && x.idempotency_key === params[2]);
          return { rowCount: row ? 1 : 0, rows: row ? [{ aggregate_version: row.aggregate_version, event_type: row.event_type, payload: row.payload, created_at: row.created_at }] : [] };
        }
        if (sql.includes("COALESCE(MAX(aggregate_version)")) {
          const rows = state.rows.filter(x => x.aggregate_type === params[0] && x.aggregate_id === params[1]);
          return { rowCount: 1, rows: [{ version: rows.reduce((n, x) => Math.max(n, x.aggregate_version), 0) }] };
        }
        if (sql.startsWith("INSERT INTO jarvis.events")) {
          const row = { event_id: state.rows.length + 1, aggregate_type: params[0], aggregate_id: params[1], aggregate_version: params[2], event_type: params[3], payload: JSON.parse(params[4]), idempotency_key: params[5], created_at: params[6] };
          state.rows.push(row); return { rowCount: 1, rows: [row] };
        }
        return { rowCount: 0, rows: [] };
      }, release() { state.released++; } };
    },
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (sql.includes("to_regclass")) return { rows: [{ events: "jarvis.events", migrations: "jarvis.schema_migrations" }] };
      if (sql.startsWith("SELECT EXISTS") && sql.includes("schema_migrations")) return { rows: [{ migration: true }] };
      if (sql.startsWith("SELECT event_id")) return { rows: state.rows.filter(x => x.aggregate_type === params[0] && x.aggregate_id === params[1] && x.aggregate_version > params[2]).slice(0, params[3]).map(x => ({ ...x, idempotency_key: x.idempotency_key })) };
      return { rows: [{ ok: 1 }] };
    },
    async end() {}
  };
  return pool;
}

test("migrates idempotently and does not expose database connection details", async () => {
  const pool = fakePool(); const store = createPostgresEventStore({ pool });
  assert.deepEqual(await store.migrate(), { ok: true, version: "0001_neon_event_store" });
  assert.deepEqual(await store.migrate(), { ok: true, version: "0001_neon_event_store" });
  assert.equal(pool.state.queries.filter(x => x.sql === "BEGIN").length, 1);
  assert.equal((await store.health()).ok, true);
});

test("appends ordered aggregate versions and returns existing idempotent event", async () => {
  const pool = fakePool(); const store = createPostgresEventStore({ pool, clock: () => "2026-11-17T00:00:00.000Z" });
  const first = await store.append({ aggregateType: "job", aggregateId: "job-1", eventType: "queued", payload: { status: "queued" }, idempotencyKey: "request-1", expectedVersion: 0 });
  const duplicate = await store.append({ aggregateType: "job", aggregateId: "job-1", eventType: "queued", payload: { status: "queued" }, idempotencyKey: "request-1", expectedVersion: 0 });
  const second = await store.append({ aggregateType: "job", aggregateId: "job-1", eventType: "running", payload: { status: "running" }, expectedVersion: 1 });
  assert.equal(first.created, true); assert.equal(first.version, 1);
  assert.equal(duplicate.created, false); assert.equal(duplicate.version, 1);
  assert.equal(second.version, 2);
  assert.equal((await store.list({ aggregateType: "job", aggregateId: "job-1" })).length, 2);
});

test("rejects stale aggregate version and invalid payload", async () => {
  const store = createPostgresEventStore({ pool: fakePool() });
  await store.append({ aggregateType: "approval", aggregateId: "a-1", eventType: "created", payload: {}, expectedVersion: 0 });
  await assert.rejects(store.append({ aggregateType: "approval", aggregateId: "a-1", eventType: "decided", payload: {}, expectedVersion: 0 }), /version conflict/);
  await assert.rejects(store.append({ aggregateType: "approval", aggregateId: "a-2", eventType: "created", payload: [] }), /must be an object/);
});

test("retries transient failures with bounded attempts only", async () => {
  let calls = 0, delays = [];
  const result = await retryTransient(async () => { calls++; if (calls < 3) throw Object.assign(new Error("temporary"), { code: "40001" }); return "ok"; }, { attempts: 3, baseDelayMs: 5, maxDelayMs: 10, sleep: async ms => delays.push(ms) });
  assert.equal(result, "ok"); assert.equal(calls, 3); assert.deepEqual(delays, [5, 10]);
  assert.equal(isTransient({ code: "23505" }), false);
  await assert.rejects(retryTransient(async () => { throw Object.assign(new Error("constraint"), { code: "23505" }); }, { sleep: async () => {} }), /constraint/);
});

test("connection errors are sanitized at health boundary", async () => {
  const pool = fakePool(); pool.query = async () => { throw new Error("postgres://secret@host/db"); };
  const store = createPostgresEventStore({ pool });
  const result = await store.health();
  assert.deepEqual(result, { ok: false, storage: "postgresql", error: "database_unavailable" });
});
