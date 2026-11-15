"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createJobStore } = require("./job-store");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-jobs-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "jobs.jsonl");
}

test("job journal persists and recovers job state", async t => {
  const filePath = await fixture(t);
  const first = createJobStore({ filePath, clock: () => "2026-11-16T00:00:00.000Z" });
  const created = await first.create({ type: "report.generate", payload: { date: "2026-11-16" } });
  assert.equal(created.created, true);
  await first.transition(created.job.id, "running");
  await first.transition(created.job.id, "succeeded");
  const second = createJobStore({ filePath });
  const recovered = await second.get(created.job.id);
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attempts, 1);
});

test("idempotency key prevents duplicate jobs", async t => {
  const filePath = await fixture(t);
  const store = createJobStore({ filePath });
  const a = await store.create({ type: "report.generate", payload: { date: "2026-11-16" }, idempotencyKey: "daily-2026-11-16" });
  const b = await store.create({ type: "report.generate", payload: { date: "2026-11-16" }, idempotencyKey: "daily-2026-11-16" });
  assert.equal(a.job.id, b.job.id);
  assert.equal(b.created, false);
});

test("invalid transitions and malformed payloads are rejected", async t => {
  const filePath = await fixture(t);
  const store = createJobStore({ filePath });
  await assert.rejects(store.create({ type: "bad type", payload: {} }), /Invalid job type/);
  await assert.rejects(store.create({ type: "report.generate", payload: [] }), /payload/);
  const job = (await store.create({ type: "report.generate", payload: {} })).job;
  await assert.rejects(store.transition(job.id, "succeeded"), /transition/);
});

test("journal corruption fails closed instead of silently losing history", async t => {
  const filePath = await fixture(t);
  await fs.writeFile(filePath, "{broken}\n");
  const store = createJobStore({ filePath });
  await assert.rejects(store.init(), /corrupt/);
});

test("concurrent creates are serialized and unique", async t => {
  const filePath = await fixture(t);
  const store = createJobStore({ filePath });
  const results = await Promise.all(Array.from({length:20}, (_,i) =>
    store.create({ type: "task.run", payload: { index: i } })));
  assert.equal(new Set(results.map(x => x.job.id)).size, 20);
  assert.equal((await store.list({ limit: 200 })).length, 20);
});
