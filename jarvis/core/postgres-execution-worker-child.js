"use strict";
const { Pool } = require("pg");
const { createTaskRegistry } = require("./task-registry-store");
const { createPostgresTaskRegistryRateLimiter } = require("./postgres-task-registry-rate-limiter");
const { createPostgresExecutionKernel } = require("./postgres-execution-kernel");

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
    else if (mode === "heartbeat") {
      const lease = JSON.parse(process.env.JARVIS_EXECUTION_CHILD_HEARTBEAT_LEASE || "null");
      const kernel = createPostgresExecutionKernel({ pool });
      result = await kernel.heartbeatWorker({ workerId, lease });
    }
    else if (mode === "idempotency") {
      const input = JSON.parse(process.env.JARVIS_EXECUTION_CHILD_WRITE_INPUT || "{}");
      const kernel = createPostgresExecutionKernel({ pool, allowedOperationScopes: ["resource.update"] });
      result = await kernel.writeResource(input);
    }
    else if (mode === "rate-limit") {
      const limiter = createPostgresTaskRegistryRateLimiter({ pool, limits: { agent: 5, project: 100, conversation: 100, worker: 100, operation: 100 } });
      result = await limiter.consume("shared-agent", { projectIds: ["one-jarvis"], conversationId: "shared-conversation", workerId: "shared-worker", operation: "tasks.claim" });
    } else throw new Error("Unsupported child test mode");
    if (process.send) process.send({ ok: true, acquired: mode === "rate-limit" ? result.allowed : Boolean(result), retryAfter: result?.retryAfter ?? 0, replayed: result?.replayed ?? false, workerId, fencingToken: result?.lease?.fencingToken ?? result?.fencingToken ?? null });
  } catch (error) {
    if (process.send) process.send({ ok: false, workerId, error: error.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
    if (process.connected) process.disconnect();
  }
}
main().catch(error => { if (process.send) process.send({ ok: false, error: error.message }); process.exitCode = 1; });
