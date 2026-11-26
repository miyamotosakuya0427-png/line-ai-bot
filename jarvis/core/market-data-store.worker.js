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
      "INSERT INTO market_data_sources(source_key,provider,license_id,venue_allowlist,currency_allowlist,enabled,license_approved,license_evidence_ref,license_reviewed_at) " +
      "VALUES($1,'Stage6 rollback probe','synthetic-worker-license',ARRAY['BINANCE_PUBLIC'],ARRAY['JPY'],TRUE,TRUE,'synthetic-worker-evidence',now())",
      [workerData.sourceKey]
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
