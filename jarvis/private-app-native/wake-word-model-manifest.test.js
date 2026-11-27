"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyWakeWordModelBundle } = require("./wake-word-model-manifest");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-jarvis-kws-"));
  fs.mkdirSync(path.join(root, "model"), { recursive: true });
  const bytes = Buffer.from("test-model-bytes-not-audio");
  fs.writeFileSync(path.join(root, "model", "model.onnx"), bytes);
  const manifest = {
    modelId: "fixture-only-not-a-real-model",
    engine: "sherpa-onnx",
    keyword: "ジャービス",
    modelFile: "model/model.onnx",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    modelLicense: "Apache-2.0",
    runtimeLicense: "Apache-2.0",
    commercialUse: true,
    redistribution: true,
    licenseEvidence: "https://example.invalid/fixture-license"
  };
  return { root, manifest, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("model manifest verifies file SHA-256 and explicit license metadata", () => {
  const f = fixture();
  try {
    const result = verifyWakeWordModelBundle({ manifest: f.manifest, modelsRoot: f.root });
    assert.equal(result.status, "verified");
    assert.equal(result.keyword, "ジャービス");
    assert.equal(result.sha256, f.manifest.sha256);
  } finally { f.cleanup(); }
});

test("model manifest rejects modified model bytes", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "model", "model.onnx"), "changed");
    assert.throws(() => verifyWakeWordModelBundle({ manifest: f.manifest, modelsRoot: f.root }), /SHA256_MISMATCH/);
  } finally { f.cleanup(); }
});

test("model manifest rejects missing or unapproved redistribution rights", () => {
  const f = fixture();
  try {
    f.manifest.redistribution = false;
    assert.throws(() => verifyWakeWordModelBundle({ manifest: f.manifest, modelsRoot: f.root }), /LICENSE_NOT_APPROVED/);
  } finally { f.cleanup(); }
});

test("model manifest rejects path traversal", () => {
  const f = fixture();
  try {
    f.manifest.modelFile = "../outside.onnx";
    assert.throws(() => verifyWakeWordModelBundle({ manifest: f.manifest, modelsRoot: f.root }), /PATH_OUTSIDE_ROOT/);
  } finally { f.cleanup(); }
});

test("model manifest rejects a different keyword and malformed hash", () => {
  const f = fixture();
  try {
    f.manifest.keyword = "別の単語";
    assert.throws(() => verifyWakeWordModelBundle({ manifest: f.manifest, modelsRoot: f.root }), /KEYWORD_MISMATCH/);
    f.manifest.keyword = "ジャービス";
    f.manifest.sha256 = "not-a-hash";
    assert.throws(() => verifyWakeWordModelBundle({ manifest: f.manifest, modelsRoot: f.root }), /SHA256_INVALID/);
  } finally { f.cleanup(); }
});
