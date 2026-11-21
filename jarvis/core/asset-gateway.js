"use strict";

const crypto = require("node:crypto");
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const DEFAULT_ALLOWED_MIME_TYPES = Object.freeze([
  "audio/wav", "audio/mpeg", "audio/mp4", "audio/webm",
  "video/mp4", "video/webm",
  "image/png", "image/jpeg", "image/webp"
]);

function detectMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (buffer.toString("ascii", 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (buffer.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return "video/webm";
  return null;
}

function validateKey(key) {
  if (typeof key !== "string" || !key || key.length > 1024 || key.startsWith("/") ||
      key.includes("\\") || /[\u0000-\u001f\u007f]/.test(key) ||
      key.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("Invalid asset key");
  }
  return key;
}

async function toBuffer(body, maxBytes) {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw new RangeError("Asset exceeds maximum size");
    return body;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new RangeError("Asset exceeds maximum size");
    return Buffer.from(body);
  }
  if (body && typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new RangeError("Asset exceeds maximum size");
    return Buffer.from(bytes);
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > maxBytes) throw new RangeError("Asset exceeds maximum size");
      chunks.push(part);
    }
    return Buffer.concat(chunks, size);
  }
  throw new TypeError("Unsupported object body");
}

function createR2ObjectStore({ accountId, accessKeyId, secretAccessKey, client } = {}) {
  let s3 = client;
  if (!s3) {
    if (![accountId, accessKeyId, secretAccessKey].every((v) => typeof v === "string" && v.length > 0)) {
      throw new TypeError("R2 account credentials are required");
    }
    s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }
    });
  }
  return Object.freeze({
    putObject: ({ bucket, key, body, contentType, metadata }) =>
      s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata })),
    headObject: ({ bucket, key }) =>
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    getObject: ({ bucket, key }) =>
      s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  });
}

function createAssetGateway({ objectStore, bucket, commitAssetMetadata, maxBytes = 100 * 1024 * 1024,
  allowedMimeTypes = DEFAULT_ALLOWED_MIME_TYPES } = {}) {
  if (!objectStore || !["putObject", "headObject", "getObject"].every((name) => typeof objectStore[name] === "function")) {
    throw new TypeError("A compatible objectStore is required");
  }
  if (typeof bucket !== "string" || !bucket) throw new TypeError("A bucket is required");
  if (typeof commitAssetMetadata !== "function") throw new TypeError("commitAssetMetadata is required");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
  const allowed = new Set(allowedMimeTypes);

  return Object.freeze({
    async upload({ key, body, mimeType, ownerId, source = "unknown" } = {}) {
      const safeKey = validateKey(key);
      const bytes = await toBuffer(body, maxBytes);
      if (bytes.length === 0) throw new TypeError("Empty assets are not accepted");
      if (!allowed.has(mimeType)) throw new TypeError("MIME type is not allowed");
      const detected = detectMimeType(bytes);
      if (detected !== mimeType) throw new TypeError("Declared MIME type does not match file signature");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const assetId = crypto.randomUUID();

      await objectStore.putObject({
        bucket, key: safeKey, body: bytes, contentType: mimeType,
        metadata: { assetid: assetId, sha256 }
      });
      const head = await objectStore.headObject({ bucket, key: safeKey });
      if (Number(head.ContentLength) !== bytes.length || head.ContentType !== mimeType ||
          String(head.Metadata?.sha256 || "").toLowerCase() !== sha256) {
        throw new Error("Stored asset verification failed");
      }

      const asset = Object.freeze({
        assetId, bucket, key: safeKey, ownerId: ownerId || null, source,
        mimeType, sizeBytes: bytes.length, sha256, verified: true
      });
      // This callback must atomically persist the Asset Registry row and append-only audit event in Neon.
      // If it fails, the uploaded object is intentionally left for reconciliation; it is not silently deleted.
      await commitAssetMetadata(asset);
      return asset;
    },

    async download({ key, expectedSha256, expectedMimeType } = {}) {
      const safeKey = validateKey(key);
      if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
        throw new TypeError("A valid expected SHA-256 is required");
      }
      const result = await objectStore.getObject({ bucket, key: safeKey });
      const bytes = await toBuffer(result.Body, maxBytes);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const mimeType = result.ContentType;
      if (expectedMimeType && mimeType !== expectedMimeType) throw new Error("Stored MIME type mismatch");
      if (!allowed.has(mimeType) || detectMimeType(bytes) !== mimeType) throw new Error("Downloaded MIME verification failed");
      if (Number(result.ContentLength ?? bytes.length) !== bytes.length ||
          sha256 !== expectedSha256.toLowerCase() ||
          String(result.Metadata?.sha256 || "").toLowerCase() !== sha256) {
        throw new Error("Downloaded asset integrity verification failed");
      }
      return Object.freeze({ body: bytes, mimeType, sizeBytes: bytes.length, sha256, verified: true });
    }
  });
}

module.exports = { createAssetGateway, createR2ObjectStore, detectMimeType, validateKey };
