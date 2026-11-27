"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createAssetGateway, detectMimeType, validateKey } = require("./asset-gateway");

function wavFixture() {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from([36,0,0,0]), Buffer.from("WAVE"), Buffer.alloc(28)]);
}
function isoBmffBox(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}
function mp4Fixture(handlerTypes) {
  const ftyp = isoBmffBox("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom")]));
  const tracks = handlerTypes.map((handlerType) => {
    const hdlr = isoBmffBox("hdlr", Buffer.concat([
      Buffer.alloc(4), Buffer.alloc(4), Buffer.from(handlerType), Buffer.alloc(12)
    ]));
    return isoBmffBox("trak", isoBmffBox("mdia", hdlr));
  });
  return Buffer.concat([ftyp, isoBmffBox("moov", Buffer.concat(tracks)), isoBmffBox("mdat", Buffer.alloc(4))]);
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

test("download enforces the byte limit while consuming async-iterable streams", async () => {
  const chunks = [Buffer.alloc(40, 1), Buffer.alloc(40, 2), Buffer.alloc(40, 3)];
  let yieldedChunks = 0;
  let transformCalls = 0;
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yieldedChunks += 1;
        yield chunk;
      }
    },
    async transformToByteArray() {
      transformCalls += 1;
      return Buffer.concat(chunks);
    }
  };
  const store = {
    async putObject() {},
    async headObject() {},
    async getObject() {
      return { Body: body, ContentType: "audio/wav", ContentLength: null, Metadata: {} };
    }
  };
  const gateway = createAssetGateway({
    objectStore: store, bucket: "jarvis-test", maxBytes: 64,
    commitAssetMetadata: async () => {}
  });
  await assert.rejects(
    gateway.download({ key: "audio/large.wav", expectedSha256: "0".repeat(64) }),
    /maximum size/
  );
  assert.equal(yieldedChunks, 2);
  assert.equal(transformCalls, 0);
});

test("download rejects transform-only bodies rather than buffering without a streaming bound", async () => {
  let transformCalls = 0;
  const body = {
    async transformToByteArray() {
      transformCalls += 1;
      return wavFixture();
    }
  };
  const store = {
    async putObject() {},
    async headObject() {},
    async getObject() {
      return { Body: body, ContentType: "audio/wav", ContentLength: null, Metadata: {} };
    }
  };
  const gateway = createAssetGateway({
    objectStore: store, bucket: "jarvis-test", maxBytes: 64,
    commitAssetMetadata: async () => {}
  });
  await assert.rejects(
    gateway.download({ key: "audio/unbounded.wav", expectedSha256: "0".repeat(64) }),
    /bounded async iterable required/
  );
  assert.equal(transformCalls, 0);
});

test("download rejects an oversized declared ContentLength before reading the body", async () => {
  let iterated = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      iterated = true;
      yield wavFixture();
    }
  };
  const store = {
    async putObject() {},
    async headObject() {},
    async getObject() {
      return { Body: body, ContentType: "audio/wav", ContentLength: 128, Metadata: {} };
    }
  };
  const gateway = createAssetGateway({
    objectStore: store, bucket: "jarvis-test", maxBytes: 64,
    commitAssetMetadata: async () => {}
  });
  await assert.rejects(
    gateway.download({ key: "audio/declared-large.wav", expectedSha256: "0".repeat(64) }),
    /maximum size/
  );
  assert.equal(iterated, false);
});


test("detects audio-only, video-only, and mixed MP4 tracks from handler metadata", () => {
  assert.equal(detectMimeType(mp4Fixture(["soun"])), "audio/mp4");
  assert.equal(detectMimeType(mp4Fixture(["vide"])), "video/mp4");
  assert.equal(detectMimeType(mp4Fixture(["soun", "vide"])), "video/mp4");
});

test("rejects MP4 containers without readable audio or video track metadata", () => {
  const ftypOnly = isoBmffBox("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom")]));
  assert.equal(detectMimeType(ftypOnly), null);
  const noMediaTracks = Buffer.concat([
    isoBmffBox("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom")])),
    isoBmffBox("moov", isoBmffBox("trak", isoBmffBox("mdia", isoBmffBox("hdlr", Buffer.alloc(4)))))
  ]);
  assert.equal(detectMimeType(noMediaTracks), null);
});
