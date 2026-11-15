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
      handlers: { "report.generate": async (payload, context) => calls.push({ payload, context }) }
    });
    await worker.start();
    const result = await worker.runNext();
    assert.equal(result.processed, true);
    assert.equal(result.job.status, "succeeded");
    assert.equal(result.job.attempts, 1);
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
