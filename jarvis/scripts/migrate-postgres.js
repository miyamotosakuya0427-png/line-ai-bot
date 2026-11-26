"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

const MIGRATION_FILES = Object.freeze([
  "0001_neon_event_store.sql",
  "0002_job_approval_stores.sql",
  "0003_append_only_event_ledger.sql",
  "0004_task_registry.sql",
  "0005_task_registry_scoped_dedupe.sql",
  "0006_scheduling_reservation_store.sql",
  "0007_execution_kernel_fencing.sql",
  "0008_worker_scope_grants.sql",
  "0009_task_event_outbox.sql",
  "0010_task_registry_agent_revocations.sql"
]);

function assertLoopbackTarget(connectionString) {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    throw new Error("A local PostgreSQL connection string is required");
  }
  let parsed;
  try { parsed = new URL(connectionString); }
  catch { throw new Error("PostgreSQL connection string is invalid"); }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error("PostgreSQL migrations are restricted to loopback hosts; remote databases are prohibited");
  }
  return parsed;
}

async function applyMigration(pool, filename, sql) {
  if (!pool || typeof pool.connect !== "function") throw new Error("PostgreSQL pool is required");
  if (typeof filename !== "string" || !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(filename)) {
    throw new Error("Invalid migration filename");
  }
  if (typeof sql !== "string" || !sql.trim()) throw new Error("Migration SQL is empty");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    return { filename, committed: true };
  } catch {
    try { await client.query("ROLLBACK"); } catch {}
    throw new Error("Migration " + filename + " failed; its transaction was rolled back");
  } finally {
    client.release();
  }
}

async function runMigrations({ pool, migrationDir = path.join(__dirname, "..", "migrations"), files = MIGRATION_FILES } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new Error("PostgreSQL pool is required");
  }
  if (!Array.isArray(files) || files.length !== MIGRATION_FILES.length || files.some((file, i) => file !== MIGRATION_FILES[i])) {
    throw new Error("The complete ordered ONE JARVIS migration set 0001-0010 is required");
  }
  const completed = [];
  for (const filename of files) {
    const sql = await fs.readFile(path.join(migrationDir, filename), "utf8");
    await applyMigration(pool, filename, sql);
    const version = filename.slice(0, -4);
    const result = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM jarvis.schema_migrations WHERE version = $1) AS applied",
      [version]
    );
    if (result.rows[0]?.applied !== true) {
      throw new Error("Migration " + filename + " did not record its version");
    }
    completed.push(filename);
  }
  return { applied: completed, count: completed.length };
}

async function main() {
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "";
  assertLoopbackTarget(connectionString);
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString, max: 1, ssl: false, application_name: "one-jarvis-migration-cli" });
  try {
    const result = await runMigrations({ pool });
    process.stdout.write("ONE JARVIS local migrations verified: " + result.count + " files (0001-0010).\n");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}

module.exports = { MIGRATION_FILES, assertLoopbackTarget, applyMigration, runMigrations };
