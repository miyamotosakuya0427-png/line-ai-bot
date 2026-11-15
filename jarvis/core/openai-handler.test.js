"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpenAIHandler } = require("./openai-handler");

test("assistant handler sends bounded request and returns text result", async () => {
  let request;
  const handler = createOpenAIHandler({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: "resp_test", output_text: "回答です" }) };
    }
  });
  const result = await handler({ request: "  今日の予定は？  " });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(request.options.body).model, "test-model");
  assert.equal(JSON.parse(request.options.body).input, "今日の予定は？");
  assert.equal(result.answer, "回答です");
  assert.equal(result.responseId, "resp_test");
});

test("assistant handler rejects missing API key and invalid payload", async () => {
  await assert.rejects(createOpenAIHandler({ apiKey: "" })({ request: "hello" }), /not configured/);
  await assert.rejects(createOpenAIHandler({ apiKey: "key" })({ request: "" }), /Invalid assistant request/);
});

test("assistant handler marks transient provider errors retryable", async () => {
  const handler = createOpenAIHandler({
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: false, status: 429 })
  });
  await assert.rejects(handler({ request: "hello" }), error => error.retryable === true);
});
