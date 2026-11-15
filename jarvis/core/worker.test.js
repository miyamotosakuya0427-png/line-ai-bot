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

test("worker recovers interrupted running jobs before processing", async () => {
  const f = await fixture();
  try {
    const { job } = await f.store.create({ type: "task.resume", payload: {} });
    await f.store.transition(job.id, "running");
    const worker = createWorker({ store: f.store, handlers: { "task.resume": async () => {} } });
    const started = await worker.start();
    assert.equal(started.recovered, 1);
    const result = await worker.runNext();
    assert.equal(result.job.status, "succeeded");
    assert.equal(result.job.attempts, 2);
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

test("worker retries transient errors and succeeds on a later attempt", async () => {
  const f = await fixture();
  try {
    const { job } = await f.store.create({ type: "task.transient", payload: {} });
    let calls = 0;
    const worker = createWorker({ store: f.store, handlers: { "task.transient": async () => {
      calls += 1;
      if (calls === 1) { const error = new Error("rate limited"); error.retryable = true; throw error; }
      return { answer: "recovered" };
    } } });
    await worker.start();
    const first = await worker.runNext();
    assert.equal(first.retryScheduled, true);
    assert.equal(first.job.status, "queued");
    const second = await worker.runNext();
    assert.equal(second.job.id, job.id);
    assert.equal(second.job.status, "succeeded");
    assert.equal(second.job.attempts, 2);
    assert.deepEqual(second.job.result, { answer: "recovered" });
  } finally { await f.cleanup(); }
});
