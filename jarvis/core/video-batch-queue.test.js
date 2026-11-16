"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createJobStore } = require("./job-store");
const { createVideoBatchStore } = require("./video-batch-store");
const { enqueueVideoBatchPlans } = require("./video-batch-queue");

test("batch queue enqueues eligible history drafts and is safe to retry", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-video-batch-queue-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const videoBatchStore = createVideoBatchStore({ filePath: path.join(dir, "videos.jsonl") });
  const jobStore = createJobStore({ filePath: path.join(dir, "jobs.jsonl") });
  await videoBatchStore.createBatch({
    idempotencyKey: "queue-test-batch",
    items: Array.from({ length: 3 }, (_, i) => ({
      id: "V" + String(i + 1).padStart(2, "0"),
      title: "歴史企画 " + (i + 1),
      topic: "歴史テーマ " + (i + 1)
    }))
  });

  const first = await enqueueVideoBatchPlans({ videoBatchStore, jobStore });
  assert.equal(first.selected, 3);
  assert.equal(first.queued.length, 3);
  assert.equal(first.existing.length, 0);
  assert.equal(first.failed.length, 0);
  assert.equal(first.externalActionsEnabled, false);

  const second = await enqueueVideoBatchPlans({ videoBatchStore, jobStore });
  assert.equal(second.selected, 3);
  assert.equal(second.queued.length, 0);
  assert.equal(second.existing.length, 3);
  assert.equal((await jobStore.list({ status: "queued", limit: 20 })).length, 3);

  const payload = (await jobStore.list({ status: "queued", limit: 20 }))[0].payload;
  assert.equal(payload.taskKind, "video-batch-plan");
  assert.ok(payload.request.split("\n").some(line => line.startsWith("動画ID：V")));
  assert.ok(payload.request.includes("要一次資料確認"));
  assert.ok(payload.request.includes("YouTube公開"));
});

test("batch queue rejects invalid batch IDs and ignores non-eligible stages", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-video-batch-filter-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const videoBatchStore = createVideoBatchStore({ filePath: path.join(dir, "videos.jsonl") });
  const jobStore = createJobStore({ filePath: path.join(dir, "jobs.jsonl") });
  await videoBatchStore.createBatch({ items: [{ id: "V01", title: "企画", topic: "テーマ" }] });
  await assert.rejects(
    enqueueVideoBatchPlans({ videoBatchStore, jobStore, batchId: "not-a-batch" }),
    /Invalid video batch ID/
  );
  const result = await enqueueVideoBatchPlans({ videoBatchStore, jobStore, batchId: "B-00000000-0000-4000-8000-000000000000" });
  assert.equal(result.selected, 0);
  assert.equal(result.queued.length, 0);
});

test("queue advances through backlogs larger than 100 without skipping later plans", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-video-batch-backlog-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const videoBatchStore = createVideoBatchStore({ filePath: path.join(dir, "videos.jsonl") });
  const jobStore = createJobStore({ filePath: path.join(dir, "jobs.jsonl") });
  await videoBatchStore.createBatch({
    idempotencyKey: "backlog-first",
    items: Array.from({ length: 100 }, (_, i) => ({
      id: "V" + String(i + 1).padStart(3, "0"),
      title: "歴史企画 " + (i + 1),
      topic: "歴史テーマ " + (i + 1)
    }))
  });
  await videoBatchStore.createBatch({
    idempotencyKey: "backlog-second",
    items: [{ id: "V101", title: "最後の企画", topic: "最後のテーマ" }]
  });

  const first = await enqueueVideoBatchPlans({ videoBatchStore, jobStore });
  assert.equal(first.selected, 100);
  assert.equal(first.queued.length, 100);
  for (let i = 1; i <= 100; i++) {
    const id = "V" + String(i).padStart(3, "0");
    await videoBatchStore.saveDraft(id, { script: "下書き", jobId: "completed-" + id });
  }
  const second = await enqueueVideoBatchPlans({ videoBatchStore, jobStore });
  assert.equal(second.selected, 1);
  assert.equal(second.queued.length, 1);
  assert.equal(second.queued[0].videoId, "V101");
});
