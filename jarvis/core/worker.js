"use strict";

function createWorker({ store, handlers = {} } = {}) {
  if (!store || typeof store.list !== "function" || typeof store.transition !== "function") {
    throw new Error("A compatible durable job store is required");
  }
  const registry = new Map(Object.entries(handlers));
  for (const [type, handler] of registry) {
    if (!/^[a-z][a-z0-9._-]{1,63}$/.test(type) || typeof handler !== "function") {
      throw new Error("Invalid job handler registration");
    }
  }

  let active = Promise.resolve();
  let started = false;

  async function recoverInterrupted() {
    const interrupted = await store.list({ status: "running", limit: 200 });
    for (const job of interrupted) {
      await store.transition(job.id, "queued");
    }
    return interrupted.length;
  }

  async function runNext() {
    if (!started) throw new Error("Worker has not been started");
    const operation = active.then(async () => {
      const queued = await store.list({ status: "queued", limit: 1 });
      if (!queued.length) return { processed: false, job: null };
      const candidate = queued[0];
      const handler = registry.get(candidate.type);
      const running = await store.transition(candidate.id, "running");
      if (!running) return { processed: false, job: null };
      if (!handler) {
        const failed = await store.transition(running.id, "failed", {
          error: "No handler registered for job type: " + candidate.type
        });
        return { processed: true, job: failed };
      }

      if (!running) return { processed: false, job: null };
      try {
        await handler(running.payload, { jobId: running.id, attempt: running.attempts });
        const succeeded = await store.transition(running.id, "succeeded");
        return { processed: true, job: succeeded };
      } catch (error) {
        const message = error && typeof error.message === "string" ? error.message : "Job failed";
        const failed = await store.transition(running.id, "failed", { error: message.slice(0, 500) });
        return { processed: true, job: failed };
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
    runNext
  };
}

module.exports = { createWorker };
