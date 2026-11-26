"use strict";

const { parentPort, workerData } = require("node:worker_threads");

async function main() {
  if (workerData && workerData.mode === "hold") {
    parentPort.postMessage({ ready: true });
    setInterval(() => {}, 1000);
    return;
  }

  const { Pool } = require("pg");
  const { MarketDataStore } = require("./market-data-store");
  const pool = new Pool({ connectionString: workerData.databaseUrl, max: 1 });
  try {
    const store = new MarketDataStore({ pool });
    const result = await store.ingest(workerData.input);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  if (parentPort) parentPort.postMessage({
    ok: false,
    error: String(error && error.message ? error.message : error)
  });
  process.exitCode = 1;
});
