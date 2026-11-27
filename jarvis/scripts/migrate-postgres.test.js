"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertLoopbackTarget, applyMigration, MIGRATION_FILES, runMigrations } = require("./migrate-postgres");

test("migration CLI accepts loopback PostgreSQL targets only", () => {
  assert.equal(assertLoopbackTarget("postgres://postgres:postgres@localhost:5432/jarvis_test").hostname, "localhost");
  assert.equal(assertLoopbackTarget("postgres://postgres:postgres@127.0.0.1:5432/jarvis_test").hostname, "127.0.0.1");
  assert.throws(() => assertLoopbackTarget("postgres://user:pass@db.example.com:5432/prod"), /loopback/);
});

test("migration CLI requires the complete ordered migration set 0001-0010", async () => {
  await assert.rejects(runMigrations({ pool: { connect() {}, query() {} }, files: MIGRATION_FILES.slice(0, 9) }), /complete ordered/);
});

test("failed migration rolls back its transaction and returns no SQL details", async () => {
  const statements = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          statements.push(sql);
          if (sql.includes("FORCED_MIGRATION_FAILURE")) throw new Error("private connection detail");
          return { rows: [] };
        },
        release() {}
      };
    }
  };
  await assert.rejects(
    applyMigration(pool, "9999_fixture_failure.sql", "CREATE TABLE jarvis.rollback_probe(id integer); SELECT FORCED_MIGRATION_FAILURE;"),
    /9999_fixture_failure.sql failed; its transaction was rolled back/
  );
  assert.deepEqual(statements, [
    "BEGIN",
    "CREATE TABLE jarvis.rollback_probe(id integer); SELECT FORCED_MIGRATION_FAILURE;",
    "ROLLBACK"
  ]);
  assert.equal(statements.some(sql => sql.includes("private connection detail")), false);
});
