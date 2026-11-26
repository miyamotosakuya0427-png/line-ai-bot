"use strict";

const { parentPort, workerData } = require("node:worker_threads");

async function main() {
  if (workerData && workerData.mode === "hold") {
    parentPort.postMessage({ ready: true });
    setInterval(() => {}, 1000);
    return;
  }

  const { Pool } = require("pg");

  if (workerData && workerData.mode === "transaction-hold") {
    const parsed = new URL(workerData.databaseUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) {
      throw new Error("Transaction-hold Worker is restricted to localhost test databases");
    }
    const pool = new Pool({
      connectionString: workerData.databaseUrl,
      max: 1,
      application_name: "one-jarvis-stage6-worker-rollback-probe"
    });
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO market_ingest_batches(id,source_id,idempotency_key,symbol,interval,status,input_count,raw_payload_hash) " +
      "VALUES($1,$2,$3,$4,$5,'running',$6,$7)",
      [workerData.batchId,workerData.sourceId,workerData.idempotencyKey,workerData.symbol,workerData.interval,workerData.inputCount,workerData.payloadHash]
    );
    parentPort.postMessage({ ready: true });
    setInterval(() => {}, 1000);
    return;
  }

  const { MarketDataStore } = require("./market-data-store");
  const pool = new Pool({
    connectionString: workerData.databaseUrl,
    max: 1,
    application_name: "one-jarvis-market-data-worker"
  });
  let response;
  try {
    const store = new MarketDataStore({ pool });
    const result = await store.ingest(workerData.input);
    response = { ok: true, result };
  } catch (error) {
    response = {
      ok: false,
      error: String(error && error.message ? error.message : error)
    };
  }

  // The result is not sent until every checked-out Pool client has been released
  // by MarketDataStore and Pool shutdown has completed.
  await pool.end();
  parentPort.postMessage(response);
  parentPort.close();
}

main().catch(error => {
  if (parentPort) {
    parentPort.postMessage({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
    parentPort.close();
  }
  process.exitCode = 1;
});
