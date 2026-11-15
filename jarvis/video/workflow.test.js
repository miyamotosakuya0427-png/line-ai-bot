"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createVideoJob, advanceVideoJob } = require("./workflow");

function job() {
  return createVideoJob({
    channel: "時をかける日本史",
    topic: "織田信長の生涯",
    title: "織田信長はなぜ天下統一目前まで進めたのか"
  });
}

test("creates a planned YouTube video job", () => {
  const result = job();
  assert.equal(result.platform, "youtube");
  assert.equal(result.stage, "planned");
  assert.equal(result.channel, "時をかける日本史");
});

test("requires channel, topic, and title", () => {
  assert.throws(() => createVideoJob({ topic: "topic", title: "title" }), /channel/);
});

test("moves through the workflow in order", () => {
  let result = job();
  result = advanceVideoJob(result, "scripted", { script: "歴史動画の台本です。" });
  result = advanceVideoJob(result, "assets_ready", { assets: ["voice.wav", "scene-01.png"] });
  result = advanceVideoJob(result, "edited", { editProjectUrl: "https://example.com/project/1" });
  result = advanceVideoJob(result, "published", { publishedUrl: "https://youtu.be/abcdefghijk" });
  result = advanceVideoJob(result, "analyzed", { analytics: { views: 100 } });
  assert.equal(result.stage, "analyzed");
  assert.equal(result.analytics.views, 100);
});

test("rejects skipped stages and non-YouTube publishing URLs", () => {
  assert.throws(() => advanceVideoJob(job(), "published", { publishedUrl: "https://youtu.be/abcdefghijk" }), /順番/);
  let result = advanceVideoJob(job(), "scripted", { script: "台本" });
  result = advanceVideoJob(result, "assets_ready", { assets: ["voice.wav"] });
  assert.throws(() => advanceVideoJob(result, "edited", {}), /順番/);
  result = advanceVideoJob(result, "edited", {});
  assert.throws(() => advanceVideoJob(result, "published", { publishedUrl: "https://example.com/video" }), /YouTube/);
});
