"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const { verifyChain } = require("./market-data-audit");

const databaseUrl = process.env.MARKET_DATA_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const workerPath = path.join(__dirname, "market-data-store.worker.js");

function fixtureBar(sourceId, openTimeUtc, close = "101") {
  const value = {
    sourceId, provider: "Stage6 independent Worker fixture",
    licenseId: "synthetic-worker-license", venue: "BINANCE_PUBLIC",
    symbol: "ETHJPY", currency: "JPY", interval: "1m",
    openTimeUtc,
    closeTimeUtc: new Date(Date.parse(openTimeUtc) + 59999).toISOString(),
    sourceTimestampRaw: openTimeUtc, sourceTimezone: "UTC",
    sourceRecordId: "worker:" + openTimeUtc,
    rawPayload: { openTimeUtc, close },
    receivedAtUtc: "2026-11-22T12:00:00.000Z",
    open: "100", high: "103", low: "99", close, volume: "10",
    quoteVolume: null, adjustmentState: "raw"
  };
  value.normalizedHash = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  value.rawPayloadHash = crypto.createHash("sha256").update("raw:" + JSON.stringify(value)).digest("hex");
  return value;
}

function startWorker(data, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: data });
    let settled = false;
    let messageReceived = false;
    let exited = false;
    let message;
    let exitCode;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().then(
        code => reject(new Error("Worker timed out (termination code " + code + ")")),
        error => reject(new Error("Worker timed out; termination failed: " + error.message))
      );
    }, timeoutMs);

    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      reject(error);
    };
    const finishIfReady = () => {
      if (settled || !messageReceived || !exited) return;
      settled = true;
      clearTimeout(timer);
      if (exitCode !== 0) {
        reject(new Error("Worker exited with code " + exitCode));
      } else if (!message || message.ok !== true) {
        reject(new Error(message && message.error ? message.error : "Worker exited without a successful result"));
      } else {
        resolve({ message, exitCode });
      }
    };

    worker.once("message", value => {
      if (messageReceived) return fail(new Error("Worker sent more than one completion message"));
      messageReceived = true;
      message = value;
      finishIfReady();
    });
    worker.once("error", fail);
    worker.once("exit", code => {
      exited = true;
      exitCode = code;
      if (!messageReceived || code !== 0) {
        fail(new Error("Worker exited before successful completion (code " + code + ")"));
        return;
      }
      finishIfReady();
    });
  });
}

async function runIngest(testDatabaseUrl, input, timeoutMs) {
  const { message } = await startWorker({ databaseUrl: testDatabaseUrl, input }, timeoutMs);
  return message.result;
}

test("independent worker_threads: concurrency, idempotency, revision and audit-chain safety", {
  skip: !enabled
}, async t => {
  const parsed = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname),
    "Worker integration tests may only use isolated localhost PostgreSQL");

  const schemaName = "stage6_worker_" + crypto.randomUUID().replace(/-/g, "");
  const { Pool } = require("pg");
  const bootstrapPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await bootstrapPool.query('CREATE SCHEMA "' + schemaName + '"');
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set("options", "-c search_path=" + schemaName + ",public");
  const testDatabaseUrl = isolatedUrl.toString();
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
  const migrationsDir = path.join(__dirname, "..", "migrations");
  try {
    try {
      await pool.query("CREATE ROLE jarvis_audit_readonly NOLOGIN");
    } catch (error) {
      if (error.code !== "42710") throw error;
    }
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY)");
    for (const file of ["002_market_data_quality.sql", "003_market_data_license_and_currency.sql", "004_market_data_raw_provenance.sql"]) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await pool.query(sql);
      await pool.query(sql);
    }
  } catch (error) {
    await pool.end();
    await bootstrapPool.query('DROP SCHEMA IF EXISTS "' + schemaName + '" CASCADE');
    await bootstrapPool.end();
    throw error;
  }
  const sourceId = crypto.randomUUID();
  const counters = { success: 0, failure: 0, duplicate: 0, retry: 0 };
  const base = Date.parse("2026-11-22T13:00:00.000Z");

  try {
    await pool.query(
      "INSERT INTO market_data_sources(id,source_key,provider,license_id,venue_allowlist,currency_allowlist,enabled,license_approved,license_evidence_ref,license_reviewed_at) " +
      "VALUES($1,$2,'Stage6 independent Worker fixture','synthetic-worker-license',ARRAY['BINANCE_PUBLIC'],ARRAY['JPY'],TRUE,TRUE,'synthetic-worker-evidence',now())",
      [sourceId, "worker-fixture-" + sourceId]
    );

    const samePayload = fixtureBar(sourceId, new Date(base).toISOString());
    const sameInput = () => ({
      sourceId, batchId: crypto.randomUUID(),
      idempotencyKey: "worker-2-" + sourceId,
      bars: [samePayload], findings: []
    });
    const two = await Promise.all([
      runIngest(testDatabaseUrl, sameInput()),
      runIngest(testDatabaseUrl, sameInput())
    ]);
    counters.success += two.filter(x => !x.idempotentReplay).length;
    counters.duplicate += two.filter(x => x.idempotentReplay).length;
    assert.equal(counters.success, 1);
    assert.equal(counters.duplicate, 1);

    const fiveBar = fixtureBar(sourceId, new Date(base + 60000).toISOString());
    const five = await Promise.all(Array.from({ length: 5 }, () => runIngest(testDatabaseUrl, {
      sourceId, batchId: crypto.randomUUID(),
      idempotencyKey: "worker-5-" + sourceId,
      bars: [fiveBar], findings: []
    })));
    counters.success += five.filter(x => !x.idempotentReplay).length;
    counters.duplicate += five.filter(x => x.idempotentReplay).length;
    assert.equal(five.filter(x => !x.idempotentReplay).length, 1);
    assert.equal(five.filter(x => x.idempotentReplay).length, 4);

    await assert.rejects(() => runIngest(testDatabaseUrl, {
      sourceId, batchId: crypto.randomUUID(),
      idempotencyKey: "worker-2-" + sourceId,
      bars: [fixtureBar(sourceId, new Date(base).toISOString(), "102")],
      findings: []
    }), /different source or payload/);
    counters.failure++;

    const revisionTime = new Date(base + 120000).toISOString();
    const revisions = await Promise.all(["101", "102"].map((close, i) => runIngest(testDatabaseUrl, {
      sourceId, batchId: crypto.randomUUID(),
      idempotencyKey: "worker-revision-" + sourceId + "-" + i,
      bars: [fixtureBar(sourceId, revisionTime, close)], findings: []
    })));
    assert.equal(revisions.filter(result => result.inserted === 1).length, 1,
      "concurrent revision race must create exactly one initial bar");
    assert.equal(revisions.filter(result => result.revised === 1).length, 1,
      "concurrent revision race must record exactly one changed-candle revision");
    counters.success += revisions.filter(result => !result.idempotentReplay).length;
    const revisionRows = await pool.query(
      "SELECT r.revision_no FROM market_bar_revisions r JOIN market_bars b ON b.id=r.bar_id WHERE b.source_id=$1 AND b.open_time_utc=$2 ORDER BY r.revision_no",
      [sourceId, revisionTime]
    );
    assert.deepEqual(revisionRows.rows.map(row => row.revision_no), [1]);
    assert.equal(revisions.length, 2);

    const hold = new Worker(workerPath, { workerData: { mode: "hold" } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hold worker did not become ready")), 5000);
      hold.once("message", message => {
        clearTimeout(timer);
        assert.equal(message.ready, true);
        resolve();
      });
      hold.once("error", reject);
    });
    await hold.terminate();
    const retryKey = "worker-restart-" + sourceId;
    const retryInput = {
      sourceId, batchId: crypto.randomUUID(), idempotencyKey: retryKey,
      bars: [fixtureBar(sourceId, new Date(base + 180000).toISOString())], findings: []
    };
    const rollbackKey = "worker-rollback-" + sourceId;
    const rollbackWorker = new Worker(workerPath, {
      workerData: { mode: "transaction-hold", databaseUrl: testDatabaseUrl, sourceKey: rollbackKey }
    });
    await new Promise((resolve, reject) => {
      const readyTimer = setTimeout(() => reject(new Error("Transaction-hold Worker readiness timeout")), 5000);
      rollbackWorker.once("message", message => {
        clearTimeout(readyTimer);
        if (!message.ready) return reject(new Error("Transaction-hold Worker did not enter its transaction"));
        resolve();
      });
      rollbackWorker.once("error", error => {
        clearTimeout(readyTimer);
        reject(error);
      });
      rollbackWorker.once("exit", code => {
        clearTimeout(readyTimer);
        reject(new Error("Transaction-hold Worker exited before readiness (code " + code + ")"));
      });
    });
    const forcedExitCode = await rollbackWorker.terminate();
    assert.equal(typeof forcedExitCode, "number");
    let rollbackRowCount = 1;
    for (let attempt = 0; attempt < 20; attempt++) {
      const rollbackCheck = await pool.query(
        "SELECT count(*)::int AS count FROM market_data_sources WHERE source_key=$1",
        [rollbackKey]
      );
      rollbackRowCount = Number(rollbackCheck.rows[0].count);
      if (rollbackRowCount === 0) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(rollbackRowCount, 0, "uncommitted source row must disappear after forced Worker termination");
    const rollbackKeyHash = crypto.createHash("sha256").update(rollbackKey).digest("hex");
    console.log("STAGE6_ROLLBACK_EVIDENCE " + JSON.stringify({
      probe: "market_data_sources",
      sourceKeySha256: rollbackKeyHash,
      rowCountAfterForcedTermination: rollbackRowCount,
      workerTerminationCode: forcedExitCode
    }));

    const activeWorkerConnections = await pool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('one-jarvis-market-data-worker','one-jarvis-stage6-worker-rollback-probe')"
    );
    assert.equal(Number(activeWorkerConnections.rows[0].count), 0, "worker Pool connections must be closed before parent completion");
    console.log("STAGE6_POOL_CLOSE_EVIDENCE " + JSON.stringify({
      activeWorkerConnections: Number(activeWorkerConnections.rows[0].count)
    }));

    const retried = await runIngest(testDatabaseUrl, retryInput);
    counters.retry++;
    assert.equal(retried.quality, "completed");

    const audit = await pool.query(
      "SELECT payload, previous_hash AS \"previousHash\", event_hash AS \"eventHash\" FROM market_data_audit_events ORDER BY id"
    );
    assert.equal(verifyChain(audit.rows.map(row => ({
      payload: row.payload, previousHash: row.previousHash, eventHash: row.eventHash
    })).filter((row, index, rows) => {
      // Verify the complete chain, including earlier fixtures, not only this test's rows.
      return true;
    })).valid, true);

    const ownBatches = await pool.query(
      "SELECT count(*)::int AS count FROM market_ingest_batches WHERE idempotency_key LIKE $1",
      ["worker-%-" + sourceId + "%"]
    );
    assert.ok(ownBatches.rows[0].count >= 4);
    assert.deepEqual(counters, { success: 5, failure: 1, duplicate: 5, retry: 1 });
  } finally {
    await pool.end();
    await bootstrapPool.query('DROP SCHEMA IF EXISTS "' + schemaName + '" CASCADE');
    await bootstrapPool.end();
  }
});

test("independent Worker timeout is bounded and terminates the Worker", {
  skip: !enabled
}, async () => {
  const parsed = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname));
  await assert.rejects(
    () => startWorker({ mode: "hold" }, 100),
    /Worker timed out/
  );
});
