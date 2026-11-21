"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createAssetGateway, detectMimeType, validateKey } = require("./asset-gateway");

function wavFixture() {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from([36,0,0,0]), Buffer.from("WAVE"), Buffer.alloc(28)]);
}
function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async putObject({ bucket, key, body, contentType, metadata }) {
      objects.set(bucket + "/" + key, { Body: Buffer.from(body), ContentLength: body.length, ContentType: contentType, Metadata: metadata });
    },
    async headObject({ bucket, key }) {
      const item = objects.get(bucket + "/" + key);
      if (!item) throw new Error("NotFound");
      return { ContentLength: item.ContentLength, ContentType: item.ContentType, Metadata: item.Metadata };
    },
    async getObject({ bucket, key }) {
      const item = objects.get(bucket + "/" + key);
      if (!item) throw new Error("NotFound");
      return { ...item, Body: Buffer.from(item.Body) };
    }
  };
}

test("detects supported audio signatures and rejects unknown bytes", () => {
  assert.equal(detectMimeType(wavFixture()), "audio/wav");
  assert.equal(detectMimeType(Buffer.from("not-a-real-media-file")), null);
});

test("validates object keys against traversal and control characters", () => {
  assert.equal(validateKey("audio/2026/voice.wav"), "audio/2026/voice.wav");
  assert.throws(() => validateKey("../private.wav"), /Invalid asset key/);
  assert.throws(() => validateKey("audio\\..\\private.wav"), /Invalid asset key/);
});

test("uploads, re-reads metadata and atomically records the asset audit metadata", async () => {
  const store = memoryStore();
  const committed = [];
  const gateway = createAssetGateway({
    objectStore: store, bucket: "jarvis-test",
    commitAssetMetadata: async (asset) => committed.push(asset)
  });
  const body = wavFixture();
  const result = await gateway.upload({ key: "audio/test.wav", body, mimeType: "audio/wav", ownerId: "test-owner", source: "unit-test" });
  assert.equal(result.verified, true);
  assert.equal(result.sizeBytes, body.length);
  assert.equal(result.sha256, crypto.createHash("sha256").update(body).digest("hex"));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].assetId, result.assetId);
});

test("rejects MIME spoofing and oversized files before upload", async () => {
  const store = memoryStore();
  const gateway = createAssetGateway({ objectStore: store, bucket: "jarvis-test", maxBytes: 64, commitAssetMetadata: async () => {} });
  await assert.rejects(gateway.upload({ key: "audio/fake.wav", body: Buffer.from("not a wav file"), mimeType: "audio/wav" }), /signature/);
  await assert.rejects(gateway.upload({ key: "audio/large.wav", body: Buffer.alloc(128), mimeType: "audio/wav" }), /maximum size/);
  assert.equal(store.objects.size, 0);
});

test("download re-computes SHA-256 and refuses tampered content", async () => {
  const store = memoryStore();
  const gateway = createAssetGateway({ objectStore: store, bucket: "jarvis-test", commitAssetMetadata: async () => {} });
  const body = wavFixture();
  const uploaded = await gateway.upload({ key: "audio/verified.wav", body, mimeType: "audio/wav" });
  const read = await gateway.download({ key: uploaded.key, expectedSha256: uploaded.sha256, expectedMimeType: "audio/wav" });
  assert.equal(read.verified, true);
  assert.deepEqual(read.body, body);
  await assert.rejects(gateway.download({ key: uploaded.key, expectedSha256: "0".repeat(64) }), /integrity/);
});
