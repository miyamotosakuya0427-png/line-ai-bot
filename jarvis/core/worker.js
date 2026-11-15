"use strict";

function createWorker({ store, handlers = {}, maxAttempts = 3 } = {}) {
  if (!store || typeof store.list !== "function" || typeof store.transition !== "function") {
    throw new Error("A compatible durable job store is required");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid max attempts");
  const registry = new Map(Object.entries(handlers));
  for (const [type, handler] of registry) {
    if (!/^[a-z][a-z0-9._-]{1,63}$/.test(type) || typeof handler !== "function") {
      throw new Error("Invalid job handler registration");
    }
  }

  let active = Promise.resolve();
  let started = false;
  let poller = null;
  let polling = false;

  async function recoverInterrupted() {
    let recovered = 0;
    while (true) {
      const interrupted = await store.list({ status: "running", limit: 200 });
      for (const job of interrupted) {
        await store.transition(job.id, "queued");
        recovered += 1;
      }
      if (interrupted.length < 200) break;
    }
    return recovered;
  }

  async function runNext() {
    if (!started) throw new Error("Worker has not been started");
    const operation = active.then(async () => {
      const queued = await store.list({ status: "queued", limit: 200 });
      if (!queued.length) return { processed: false, job: null };
      const candidate = queued.sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0];
      const handler = registry.get(candidate.type);
      const running = await store.transition(candidate.id, "running");
      if (!running) return { processed: false, job: null };
      if (!handler) {
        const failed = await store.transition(running.id, "failed", {
          error: "No handler registered for job type: " + candidate.type
        });
        return { processed: true, job: failed };
      }

      try {
        const result = await handler(running.payload, { jobId: running.id, attempt: running.attempts });
        const succeeded = await store.transition(running.id, "succeeded", { result: result === undefined ? undefined : (result && typeof result === "object" && !Array.isArray(result) ? result : { value: String(result).slice(0, 8000) }) });
        return { processed: true, job: succeeded };
      } catch (error) {
        const message = error && typeof error.message === "string" ? error.message : "Job failed";
        if (error?.retryable === true && running.attempts < maxAttempts) {
          const queued = await store.transition(running.id, "queued");
          return { processed: true, job: queued, retryScheduled: true };
        }
        const failed = await store.transition(running.id, "failed", { error: message.slice(0, 500) });
        return { processed: true, job: failed, retryScheduled: false };
      }
    });
    active = operation.catch(() => {});
    return operation;
  }

  return {
    async start() {
      if (started) return { ok: true, recovered: 0 };
      await store.init();
      const recovered = await recoverInterrupted();
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
