"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const connectionString = process.env.JARVIS_MIGRATION_TEST_DATABASE_URL || "";
const enabled = Boolean(connectionString) && process.env.JARVIS_ALLOW_TEST_SCHEMA_RESET === "yes";

test("PostgreSQL migrations 0001-0010 apply, re-run idempotently, rollback, and preserve public schema", { skip: !enabled }, async () => {
  const { Pool } = require("pg");
  const { assertLoopbackTarget, applyMigration, MIGRATION_FILES, runMigrations } = require("./migrate-postgres");
  const parsed = assertLoopbackTarget(connectionString);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(^|[_-])test([_-]|$)/i.test(database)) throw new Error("Migration integration database name must include test");
  const pool = new Pool({ connectionString, max: 4, ssl: false });
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS public.one_jarvis_migration_fixture (id integer PRIMARY KEY)");
    await pool.query("INSERT INTO public.one_jarvis_migration_fixture(id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");

    const { createPostgresEventStore } = require("../core/postgres-event-store");
    const { createPostgresOperationalStores } = require("../core/postgres-operational-stores");
    const eventStore = createPostgresEventStore({ pool });
    const operational = createPostgresOperationalStores({ pool });
    assert.equal((await eventStore.health()).ok, false, "health must fail closed when migrations are absent");
    await assert.rejects(operational.init(), /not installed/);
    const before = await pool.query("SELECT to_regclass('jarvis.events') AS events");
    assert.equal(before.rows[0].events, null, "read-only startup checks must not create schema objects");

    const first = await runMigrations({ pool });
    assert.equal(first.count, 10);
    assert.deepEqual(first.applied, MIGRATION_FILES);
    const versions = await pool.query("SELECT version FROM jarvis.schema_migrations ORDER BY version");
    assert.deepEqual(versions.rows.map(row => row.version), MIGRATION_FILES.map(file => file.slice(0, -4)));

    const second = await runMigrations({ pool });
    assert.equal(second.count, 10, "all migrations must be safely re-runnable");
    const versionsAfter = await pool.query("SELECT version FROM jarvis.schema_migrations ORDER BY version");
    assert.deepEqual(versionsAfter.rows.map(row => row.version), versions.rows.map(row => row.version));

    await assert.rejects(
      applyMigration(pool, "9999_rollback_probe.sql", "CREATE TABLE jarvis.rollback_probe(id integer); SELECT 1 / 0;"),
      /9999_rollback_probe.sql failed/
    );
    const rolledBack = await pool.query("SELECT to_regclass('jarvis.rollback_probe') AS probe");
    assert.equal(rolledBack.rows[0].probe, null, "failed migration DDL must be rolled back");

    const publicMarker = await pool.query("SELECT id FROM public.one_jarvis_migration_fixture WHERE id=1");
    assert.equal(publicMarker.rowCount, 1, "existing public schema data must remain intact");
    assert.deepEqual(await operational.init(), { ok: true });
    assert.equal((await eventStore.health()).ok, true);

    const { createTaskRegistry } = require("../core/task-registry-store");
    const { createPostgresExecutionKernel } = require("../core/postgres-execution-kernel");
    const registry = createTaskRegistry({ pool, requireAgentRevocation: true });
    const kernel = createPostgresExecutionKernel({ pool, allowedOperationScopes: ["task.result.persist"] });
    assert.deepEqual(await registry.init(), { ok: true });
    assert.deepEqual(await kernel.init(), { ok: true });
  } finally {
    try { await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE"); }
    finally { await pool.end(); }
  }
});
