"use strict";
const crypto = require("node:crypto");

function createWorker({ store, handlers = {}, maxAttempts = 3, leaseMs = 60000, heartbeatMs = 20000, workerId = crypto.randomUUID() } = {}) {
  if (!store || typeof store.list !== "function" || typeof store.transition !== "function") throw new Error("A compatible durable job store is required");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid max attempts");
  if (!Number.isInteger(leaseMs) || leaseMs < 5000 || leaseMs > 3600000 || !Number.isInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs >= leaseMs) throw new Error("Invalid worker lease settings");
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) throw new Error("Invalid worker id");
  const registry = new Map(Object.entries(handlers));
  for (const [type, handler] of registry) if (!/^[a-z][a-z0-9._-]{1,63}$/.test(type) || typeof handler !== "function") throw new Error("Invalid job handler registration");
  let active = Promise.resolve(), started = false, poller = null, polling = false;

  async function recoverInterrupted() {
    let recovered = 0;
    while (true) {
      const interrupted = await store.list({ status: "running", limit: 200 });
      for (const job of interrupted) { await store.transition(job.id, "queued"); recovered += 1; }
      if (interrupted.length < 200) break;
    }
    return recovered;
  }

  async function runNext() {
    if (!started) throw new Error("Worker has not been started");
    const operation = active.then(async () => {
      let running;
      if (typeof store.claimNext === "function") {
        running = await store.claimNext({ workerId, leaseMs });
      } else {
        const queued = await store.list({ status: "queued", limit: 200 });
        if (!queued.length) return { processed: false, job: null };
        const candidate = queued.sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0];
        running = await store.transition(candidate.id, "running");
      }
      if (!running) return { processed: false, job: null };
      const leaseOwner = typeof store.claimNext === "function" ? workerId : null;
      const transition = (status, options = {}) => store.transition(running.id, status, { ...options, ...(leaseOwner ? { leaseOwner } : {}) });
      const handler = registry.get(running.type);
      if (!handler) {
        const failed = await transition("failed", { error: "No handler registered for job type: " + running.type });
        return { processed: true, job: failed };
      }
      let heartbeat = null, leaseLost = false, heartbeatBusy = false;
      if (leaseOwner && typeof store.heartbeat === "function") {
        heartbeat = setInterval(async () => {
          if (heartbeatBusy || leaseLost) return;
          heartbeatBusy = true;
          try { await store.heartbeat(running.id, { workerId, leaseMs }); }
          catch { leaseLost = true; }
          finally { heartbeatBusy = false; }
        }, heartbeatMs);
        heartbeat.unref?.();
      }
      try {
        const result = await handler(running.payload, { jobId: running.id, attempt: running.attempts, workerId });
        if (leaseLost) return { processed: true, job: null, leaseLost: true };
        const succeeded = await transition("succeeded", { result: result === undefined ? undefined : (result && typeof result === "object" && !Array.isArray(result) ? result : { value: String(result).slice(0, 8000) }) });
        return { processed: true, job: succeeded };
      } catch (error) {
        if (leaseLost) return { processed: true, job: null, leaseLost: true };
        const message = error && typeof error.message === "string" ? error.message : "Job failed";
        if (error?.retryable === true && running.attempts < maxAttempts) {
          const queued = await transition("queued");
          return { processed: true, job: queued, retryScheduled: true };
        }
        const failed = await transition("failed", { error: message.slice(0, 500) });
        return { processed: true, job: failed, retryScheduled: false };
      } finally { if (heartbeat) clearInterval(heartbeat); }
    });
    active = operation.catch(() => {});
    return operation;
  }

  return {
    async start() {
      if (started) return { ok: true, recovered: 0 };
      await store.init();
      const recovered = typeof store.claimNext === "function" ? 0 : await recoverInterrupted();
      started = true;
      return { ok: true, recovered };
    },
    startPolling({ intervalMs = 1500 } = {}) {
      if (!started) throw new Error("Worker has not been started");
      if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw new Error("Invalid polling interval");
      if (poller) return;
      poller = setInterval(() => { if (polling) return; polling = true; runNext().catch(() => {}).finally(() => { polling = false; }); }, intervalMs);
      poller.unref?.();
    },
    stop() { if (poller) clearInterval(poller); poller = null; },
    runNext
  };
}
module.exports = { createWorker };
