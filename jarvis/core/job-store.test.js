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
  assert.equal(recovered.result, null);
});

test("retry schedule and last error persist across store restart", async t => {
  const filePath = await fixture(t);
  const first = createJobStore({ filePath });
  const job = (await first.create({ type: "report.generate", payload: {} })).job;
  await first.transition(job.id, "running");
  const retryAt = "2026-11-16T00:00:05.000Z";
  await first.transition(job.id, "queued", { retryAt, lastError: "rate limited" });
  const second = createJobStore({ filePath });
  const recovered = await second.get(job.id);
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.retryAt, retryAt);
  assert.equal(recovered.lastError, "rate limited");
});

test("an incomplete final journal write is quarantined while prior jobs recover", async t => {
  const filePath = await fixture(t);
  const first = createJobStore({ filePath });
  const job = (await first.create({ type: "report.generate", payload: { date: "2026-11-17" } })).job;
  const validBytes = await fs.readFile(filePath);
  await fs.appendFile(filePath, '{"type":"job","job":{"id":"partial');
  const recoveredStore = createJobStore({ filePath });
  const initialized = await recoveredStore.init();
  assert.equal(initialized.count, 1);
  assert.equal((await recoveredStore.get(job.id)).status, "queued");
  const names = await fs.readdir(path.dirname(filePath));
  const quarantine = names.find(name => name.startsWith("jobs.jsonl.recovery-") && name.endsWith(".tail"));
  assert.ok(quarantine);
  assert.equal(await fs.readFile(path.join(path.dirname(filePath), quarantine), "utf8"), '{"type":"job","job":{"id":"partial');
  assert.deepEqual(await fs.readFile(filePath), validBytes);
});

test("a complete final JSON event without newline is retained and normalized", async t => {
  const filePath = await fixture(t);
  const first = createJobStore({ filePath });
  const job = (await first.create({ type: "report.generate", payload: {} })).job;
  const raw = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, raw.trimEnd());
  const recovered = createJobStore({ filePath });
  assert.equal((await recovered.get(job.id)).status, "queued");
  assert.equal((await fs.readFile(filePath, "utf8")).endsWith("\n"), true);
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

test("successful job results are persisted and recovered", async t => {
  const filePath = await fixture(t);
  const first = createJobStore({ filePath });
  const job = (await first.create({ type: "assistant.request", payload: { request: "hello" } })).job;
  await first.transition(job.id, "running");
  await first.transition(job.id, "succeeded", { result: { answer: "こんにちは" } });
  const second = createJobStore({ filePath });
  assert.deepEqual((await second.get(job.id)).result, { answer: "こんにちは" });
});
