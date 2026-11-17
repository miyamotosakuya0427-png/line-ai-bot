"use strict";
const { Pool } = require("pg");
const { createTaskRegistry } = require("./task-registry-store");

async function main() {
  const url = process.env.JARVIS_EXECUTION_TEST_DATABASE_URL || "";
  const workerId = process.env.JARVIS_EXECUTION_CHILD_WORKER_ID || "";
  const taskId = process.env.JARVIS_EXECUTION_CHILD_TASK_ID || "";
  const mode = process.env.JARVIS_EXECUTION_CHILD_MODE || "";
  const pool = new Pool({ connectionString: url, max: 1, ssl: new URL(url).searchParams.get("sslmode") === "disable" ? false : { rejectUnauthorized: true } });
  try {
    const registry = createTaskRegistry({ pool });
    let result;
    if (mode === "claim") result = await registry.claimTaskForWorker({ taskId, workerId, leaseMs: 30000 });
    else if (mode === "resource") result = await registry.acquireLease({ resourceKey: "resource:multi-process-race", ownerId: workerId, leaseMs: 30000 });
    else throw new Error("Unsupported child test mode");
    if (process.send) process.send({ ok: true, acquired: Boolean(result), workerId, fencingToken: result?.lease?.fencingToken ?? result?.fencingToken ?? null });
  } catch (error) {
    if (process.send) process.send({ ok: false, workerId, error: error.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
main().catch(error => { if (process.send) process.send({ ok: false, error: error.message }); process.exitCode = 1; });
