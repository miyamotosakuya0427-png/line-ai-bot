"use strict";

const STAGES = Object.freeze([
  "planned",
  "scripted",
  "assets_ready",
  "edited",
  "published",
  "analyzed"
]);

const STAGE_LABELS = Object.freeze({
  planned: "企画",
  scripted: "台本完成",
  assets_ready: "音声・画像素材完成",
  edited: "編集完了",
  published: "YouTube投稿済み",
  analyzed: "分析完了"
});

function cleanText(value, field, maxLength = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new TypeError(field + " は1〜" + maxLength + "文字で入力してください");
  }
  return value.trim();
}

function createVideoJob(input = {}) {
  const now = new Date().toISOString();
  return Object.freeze({
    id: cleanText(input.id || "video-" + Date.now(), "id", 80),
    channel: cleanText(input.channel, "channel", 120),
    topic: cleanText(input.topic, "topic", 300),
    title: cleanText(input.title, "title", 200),
    platform: "youtube",
    stage: "planned",
    stageLabel: STAGE_LABELS.planned,
    createdAt: now,
    updatedAt: now,
    script: null,
    assets: [],
    editProjectUrl: null,
    publishedUrl: null,
    analytics: null
  });
}

function advanceVideoJob(job, nextStage, details = {}) {
  if (!job || !STAGES.includes(job.stage)) throw new TypeError("有効な動画ジョブではありません");
  const currentIndex = STAGES.indexOf(job.stage);
  if (STAGES[currentIndex + 1] !== nextStage) {
    throw new Error("工程は順番に進めてください: " + STAGE_LABELS[job.stage]);
  }

  const patch = {};
  if (nextStage === "scripted") patch.script = cleanText(details.script, "script", 30000);
  if (nextStage === "assets_ready") {
    if (!Array.isArray(details.assets) || details.assets.length < 1 || details.assets.length > 50) {
      throw new TypeError("assets は1〜50件の配列で指定してください");
    }
    patch.assets = details.assets.map((asset) => cleanText(asset, "asset", 1000));
  }
  if (nextStage === "edited" && details.editProjectUrl) {
    patch.editProjectUrl = cleanText(details.editProjectUrl, "editProjectUrl", 2000);
  }
  if (nextStage === "published") {
    patch.publishedUrl = cleanText(details.publishedUrl, "publishedUrl", 2000);
    if (!/^https:\/\/(www\.)?youtube\.com\//i.test(patch.publishedUrl) &&
        !/^https:\/\/youtu\.be\//i.test(patch.publishedUrl)) {
      throw new TypeError("publishedUrl はYouTubeのHTTPS URLを指定してください");
    }
  }
  if (nextStage === "analyzed") {
    if (!details.analytics || typeof details.analytics !== "object" || Array.isArray(details.analytics)) {
      throw new TypeError("analytics は分析データのオブジェクトで指定してください");
    }
    patch.analytics = { ...details.analytics };
  }

  return Object.freeze({
    ...job,
    ...patch,
    stage: nextStage,
    stageLabel: STAGE_LABELS[nextStage],
    updatedAt: new Date().toISOString()
  });
}

module.exports = { STAGES, STAGE_LABELS, createVideoJob, advanceVideoJob };
