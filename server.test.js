"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createServer,
  verifySignature,
  readRequestBody,
  extractOutputText,
  claimEvent
} = require("./server");

test("LINE signature is verified against the raw body", () => {
  const body = Buffer.from('{"events":[]}');
  const secret = "test-channel-secret";
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifySignature(body, signature, secret), true);
  assert.equal(verifySignature(body, signature + "x", secret), false);
  assert.equal(verifySignature(body, signature, ""), false);
});

test("request body reader enforces the byte limit", async () => {
  async function* request() {
    yield Buffer.from("1234");
    yield Buffer.from("5678");
  }
  await assert.rejects(readRequestBody(request(), 6), { statusCode: 413 });
});

test("Responses API output text is extracted", () => {
  assert.equal(extractOutputText({ output_text: " hello " }), "hello");
  assert.equal(extractOutputText({
    output: [{ type: "message", content: [{ type: "output_text", text: " world " }] }]
  }), "world");
  assert.equal(extractOutputText({ output: [] }), "");
});

test("duplicate webhook event IDs are claimed once", () => {
  const id = "line-test-" + crypto.randomUUID();
  assert.equal(claimEvent(id, 100), true);
  assert.equal(claimEvent(id, 101), false);
});

test("health endpoint responds without calling external services", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/health");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /LINE AI Bot is running/);
});
