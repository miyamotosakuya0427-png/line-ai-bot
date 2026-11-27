"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KEYWORD = "ジャービス";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REQUIRED_LICENSE_FIELDS = [
  "modelLicense",
  "runtimeLicense",
  "commercialUse",
  "redistribution",
  "licenseEvidence"
];

async function verifyWakeWordModelBundle({ manifest, modelsRoot }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("MODEL_MANIFEST_REQUIRED");
  }
  if (manifest.keyword !== KEYWORD) throw new Error("MODEL_KEYWORD_MISMATCH");
  if (typeof manifest.modelId !== "string" || !manifest.modelId.trim()) {
    throw new Error("MODEL_ID_REQUIRED");
  }
  if (typeof manifest.engine !== "string" || !manifest.engine.trim()) {
    throw new Error("MODEL_ENGINE_REQUIRED");
  }
  if (typeof manifest.modelFile !== "string" || !manifest.modelFile.trim()) {
    throw new Error("MODEL_FILE_REQUIRED");
  }
  if (!SHA256_PATTERN.test(manifest.sha256 || "")) {
    throw new Error("MODEL_SHA256_INVALID");
  }
  for (const field of REQUIRED_LICENSE_FIELDS) {
    if (!(field in manifest)) throw new Error("MODEL_LICENSE_METADATA_INCOMPLETE");
  }
  if (typeof manifest.modelLicense !== "string" || !manifest.modelLicense.trim() ||
      typeof manifest.runtimeLicense !== "string" || !manifest.runtimeLicense.trim() ||
      manifest.commercialUse !== true || manifest.redistribution !== true ||
      typeof manifest.licenseEvidence !== "string" || !manifest.licenseEvidence.trim()) {
    throw new Error("MODEL_LICENSE_NOT_APPROVED");
  }
  if (typeof modelsRoot !== "string" || !modelsRoot.trim()) {
    throw new TypeError("MODELS_ROOT_REQUIRED");
  }

  const root = fs.realpathSync(modelsRoot);
  const candidate = path.resolve(root, manifest.modelFile);
  if (!candidate.startsWith(root + path.sep)) throw new Error("MODEL_PATH_OUTSIDE_ROOT");
  const file = fs.realpathSync(candidate);
  if (!file.startsWith(root + path.sep)) throw new Error("MODEL_PATH_OUTSIDE_ROOT");
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("MODEL_FILE_NOT_REGULAR");
  const actualSha256 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
  if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
    throw new Error("MODEL_SHA256_MISMATCH");
  }

  return Object.freeze({
    status: "verified",
    modelId: manifest.modelId,
    engine: manifest.engine,
    keyword: KEYWORD,
    modelPath: file,
    sha256: actualSha256,
    modelLicense: manifest.modelLicense,
    runtimeLicense: manifest.runtimeLicense,
    commercialUse: true,
    redistribution: true,
    licenseEvidence: manifest.licenseEvidence
  });
}

module.exports = Object.freeze({ verifyWakeWordModelBundle });
