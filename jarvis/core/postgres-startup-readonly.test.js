"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPostgresEventStore } = require("./postgres-event-store");
const { createPostgresOperationalStores } = require("./postgres-operational-stores");

function recordingPool() {
  const state = { statements: [] };
  async function query(sql) {
    state.statements.push(String(sql));
    if (sql.startsWith("SELECT to_regclass")) return { rows: [{ events: "jarvis.events", migrations: "jarvis.schema_migrations", migration: true }], rowCount: 1 };
    if (/^\s*SELECT EXISTS/i.test(sql)) return { rows: [{ migration: true, migration_0002: true, migration_0003: true, append_only_row: true, append_only_truncate: true }], rowCount: 1 };
    if (/^\s*SELECT\s+version\s+FROM/i.test(sql)) {
      return { rows: [{ version: "0001_neon_event_store" }], rowCount: 1 };
    }
    if (/^\s*SELECT\s+1\b/i.test(sql)) return { rows: [{ one: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  const client = {
    query,
    release() {}
  };
  return {
    state,
    query,
    async connect() { return client; },
    async end() {}
  };
}

function mutatingStatements(pool) {
  return pool.state.statements.filter(sql =>
    /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|REVOKE|GRANT)\b/i.test(sql)
  );
}

test("event store health is read-only and never applies migrations", async () => {
  const pool = recordingPool();
  const store = createPostgresEventStore({ pool });
  const result = await store.health();
  assert.equal(result.ok, true);
  assert.deepEqual(mutatingStatements(pool), []);
});

test("operational store init is a read-only schema check", async () => {
  const pool = recordingPool();
  const stores = createPostgresOperationalStores({ pool });
  assert.deepEqual(await stores.init(), { ok: true });
  assert.deepEqual(mutatingStatements(pool), []);
});

test("event and operational migrations remain explicit maintenance operations", () => {
  const pool = recordingPool();
  const eventStore = createPostgresEventStore({ pool });
  const operational = createPostgresOperationalStores({ pool });
  assert.equal(typeof eventStore.assertSchema, "function");
  assert.equal(typeof operational.assertSchema, "function");
  assert.equal(typeof eventStore.migrate, "function");
  assert.equal(typeof operational.migrate, "function");
});

test("PostgreSQL server startup uses schema checks and does not call migration methods", () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  const start = source.indexOf('if(process.env.JARVIS_STORAGE_MODE==="postgres")');
  const end = source.indexOf("let taskRegistry=", start);
  assert.ok(start >= 0 && end > start, "PostgreSQL startup block must be found");
  const startup = source.slice(start, end);
  assert.doesNotMatch(startup, /\.migrate\s*\(/);
  assert.match(startup, /eventStore\.assertSchema\s*\(/);
  assert.match(startup, /operational\.assertSchema\s*\(/);
});
