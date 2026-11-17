"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createJobStore } = require("./job-store");
const { createWorker } = require("./worker");

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-worker-"));
  const store = createJobStore({ filePath: path.join(dir, "jobs.jsonl") });
  await store.init();
  return { dir, store, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("worker executes an allowlisted job and marks it succeeded", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const { job } = await f.store.create({ type: "report.generate", payload: { reportId: "R1" } });
    const worker = createWorker({
      store: f.store,
      handlers: { "report.generate": async (payload, context) => { calls.push({ payload, context }); return { answer: "done" }; } }
    });
    await worker.start();
    const result = await worker.runNext();
    assert.equal(result.processed, true);
    assert.equal(result.job.status, "succeeded");
    assert.equal(result.job.attempts, 1);
    assert.deepEqual(result.job.result, { answer: "done" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload, { reportId: "R1" });
    assert.equal(calls[0].context.jobId, job.id);
    assert.deepEqual(await worker.runNext(), { processed: false, job: null });
  } finally { await f.cleanup(); }
});

test("worker records handler failures without crashing the queue", async () => {
  const f = await fixture();
  try {
    const { job } = await f.store.create({ type: "report.fail", payload: {} });
    const worker = createWorker({ store: f.store, handlers: { "report.fail": async () => { throw new Error("temporary failure"); } } });
    await worker.start();
    const result = await worker.runNext();
    assert.equal(result.job.id, job.id);
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.error, "temporary failure");
  } finally { await f.cleanup(); }
});

test("worker fails closed for job types without a registered handler", async () => {
  const f = await fixture();
  try {
    await f.store.create({ type: "unknown.task", payload: {} });
    const worker = createWorker({ store: f.store });
    await worker.start();
    const result = await worker.runNext();
    assert.equal(result.job.status, "failed");
    assert.match(result.job.error, /No handler registered/);
  } finally { await f.cleanup(); }
});

test("worker quarantines interrupted execution as outcome unknown instead of rerunning it", async () => {
  const f = await fixture();
  try {
    const { job } = await f.store.create({ type: "task.resume", payload: {} });
    await f.store.transition(job.id, "running");
    let calls = 0;
    const worker = createWorker({ store: f.store, handlers: { "task.resume": async () => { calls += 1; } } });
    const started = await worker.start();
    assert.equal(started.recovered, 1);
    const recovered = await f.store.get(job.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.outcomeUnknown, true);
    const result = await worker.runNext();
    assert.equal(result.processed, false);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("worker requires start before processing", async () => {
  const f = await fixture();
  try {
    const worker = createWorker({ store: f.store });
    await assert.rejects(worker.runNext(), /not been started/);
  } finally { await f.cleanup(); }
});

test("worker polling can be started and stopped", async () => {
  const f = await fixture();
  try {
    const worker = createWorker({ store: f.store });
    await worker.start();
    worker.startPolling({ intervalMs: 500 });
    worker.startPolling({ intervalMs: 500 });
    worker.stop();
    assert.throws(() => worker.startPolling({ intervalMs: 50 }), /Invalid polling interval/);
  } finally { await f.cleanup(); }
});

test("worker applies exponential backoff only to explicitly retry-safe transient failures", async () => {
  const f = await fixture();
  try {
    const { job } = await f.store.create({ type: "task.transient", payload: {} });
    let calls = 0;
    let now = "2026-11-17T00:00:00.000Z";
    const worker = createWorker({
      store: f.store, clock: () => now, retryBaseMs: 1000, retryMaxMs: 4000, maxAttempts: 3,
      handlers: { "task.transient": async () => {
        calls += 1;
        if (calls < 3) { const error = new Error("provider confirmed no effect"); error.retryable = true; error.retrySafe = true; throw error; }
        return { answer: "recovered" };
      } }
    });
    await worker.start();
    const first = await worker.runNext();
    assert.equal(first.retryScheduled, true);
    assert.equal(first.retryDelayMs, 1000);
    assert.equal(first.job.retryAt, "2026-11-17T00:00:01.000Z");
    assert.equal((await worker.runNext()).waiting, true);
    now = first.job.retryAt;
    const second = await worker.runNext();
    assert.equal(second.retryDelayMs, 2000);
    assert.equal(second.job.retryAt, "2026-11-17T00:00:03.000Z");
    now = second.job.retryAt;
    const third = await worker.runNext();
    assert.equal(third.job.id, job.id);
    assert.equal(third.job.status, "succeeded");
    assert.equal(third.job.attempts, 3);
    assert.deepEqual(third.job.result, { answer: "recovered" });
  } finally { await f.cleanup(); }
});

test("worker stops after maxAttempts even when a failure is retry-safe", async () => {
  const f = await fixture();
  try {
    await f.store.create({ type: "task.exhausted", payload: {} });
    const worker = createWorker({ store: f.store, maxAttempts: 1, handlers: { "task.exhausted": async () => {
      const error = new Error("provider rejected before execution");
      error.retryable = true;
      error.retrySafe = true;
      throw error;
    } } });
    await worker.start();
    const result = await worker.runNext();
    assert.equal(result.retryScheduled, false);
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.outcomeUnknown, false);
    assert.equal((await worker.runNext()).processed, false);
  } finally { await f.cleanup(); }
});

test("worker does not retry an external operation when its outcome is not confirmed safe", async () => {
  const f = await fixture();
  try {
    await f.store.create({ type: "task.uncertain", payload: {} });
    let calls = 0;
    const worker = createWorker({ store: f.store, handlers: { "task.uncertain": async () => {
      calls += 1;
      const error = new Error("connection lost after request");
      error.retryable = true;
      error.outcomeUnknown = true;
      throw error;
    } } });
    await worker.start();
    const first = await worker.runNext();
    assert.equal(first.retryScheduled, false);
    assert.equal(first.outcomeUnknown, true);
    assert.equal(first.job.status, "failed");
    assert.equal(first.job.outcomeUnknown, true);
    assert.equal((await worker.runNext()).processed, false);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test("worker processes queued jobs in FIFO order", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-fifo-"));
  try {
    let tick = 0;
    const store = createJobStore({ filePath: path.join(dir, "jobs.jsonl"), clock: () => new Date(1763251200000 + tick++ * 1000).toISOString() });
    const first = await store.create({ type: "task.order", payload: { label: "first" } });
    await store.create({ type: "task.order", payload: { label: "second" } });
    const processed = [];
    const worker = createWorker({ store, handlers: { "task.order": async payload => { processed.push(payload.label); } } });
    await worker.start();
    await worker.runNext();
    assert.deepEqual(processed, ["first"]);
    worker.stop();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
