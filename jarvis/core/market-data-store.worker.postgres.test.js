"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { Pool } = require("pg");
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
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await worker.terminate();
      reject(new Error("Worker timed out"));
    }, timeoutMs);
    worker.once("message", message => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ message, worker });
    });
    worker.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", code => {
      if (!settled && code !== 0) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("Worker exited with code " + code));
      }
    });
  });
}

async function runIngest(databaseUrl, input, timeoutMs) {
  const { message, worker } = await startWorker({ databaseUrl, input }, timeoutMs);
  await worker.terminate();
  if (!message.ok) throw new Error(message.error);
  return message.result;
}

test("independent worker_threads: concurrency, idempotency, revision and audit-chain safety", {
  skip: !enabled
}, async t => {
  const parsed = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname),
    "Worker integration tests may only use isolated localhost PostgreSQL");

  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const sourceId = crypto.randomUUID();
  const counters = { success: 0, failure: 0, duplicate: 0, retry: 0, rollback: 0 };
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
      runIngest(databaseUrl, sameInput()),
      runIngest(databaseUrl, sameInput())
    ]);
    counters.success += two.filter(x => !x.idempotentReplay).length;
    counters.duplicate += two.filter(x => x.idempotentReplay).length;
    assert.equal(counters.success, 1);
    assert.equal(counters.duplicate, 1);

    const fiveBar = fixtureBar(sourceId, new Date(base + 60000).toISOString());
    const five = await Promise.all(Array.from({ length: 5 }, () => runIngest(databaseUrl, {
      sourceId, batchId: crypto.randomUUID(),
      idempotencyKey: "worker-5-" + sourceId,
      bars: [fiveBar], findings: []
    })));
    counters.success += five.filter(x => !x.idempotentReplay).length;
    counters.duplicate += five.filter(x => x.idempotentReplay).length;
    assert.equal(five.filter(x => !x.idempotentReplay).length, 1);
    assert.equal(five.filter(x => x.idempotentReplay).length, 4);

    await assert.rejects(() => runIngest(databaseUrl, {
      sourceId, batchId: crypto.randomUUID(),
      idempotencyKey: "worker-2-" + sourceId,
      bars: [fixtureBar(sourceId, new Date(base).toISOString(), "102")],
      findings: []
    }), /different source or payload/);
    counters.failure++;

    const revisionTime = new Date(base + 120000).toISOString();
    const revisions = await Promise.all(["101", "102"].map((close, i) => runIngest(databaseUrl, {
      sourceId, batchId: crypto.randomUUID(),
      idempotencyKey: "worker-revision-" + sourceId + "-" + i,
      bars: [fixtureBar(sourceId, revisionTime, close)], findings: []
    })));
    const revisionRows = await pool.query(
      "SELECT revision_no FROM market_bar_revisions r JOIN market_bars b ON b.id=r.bar_id WHERE b.source_id=$1 AND b.open_time_utc=$2 ORDER BY revision_no",
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
    const retried = await runIngest(databaseUrl, retryInput);
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
    assert.deepEqual(counters, { success: 3, failure: 1, duplicate: 5, retry: 1, rollback: 0 });
  } finally {
    await pool.end();
  }
});

test("independent Worker timeout and forced termination are bounded", {
  skip: !enabled
}, async () => {
  const parsed = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname));
  const worker = new Worker(workerPath, { workerData: { mode: "hold" } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker readiness timeout")), 5000);
    worker.once("message", message => {
      clearTimeout(timer);
      assert.equal(message.ready, true);
      resolve();
    });
    worker.once("error", reject);
  });
  const terminated = await worker.terminate();
  assert.equal(typeof terminated, "number");
});
