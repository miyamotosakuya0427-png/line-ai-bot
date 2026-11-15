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


test("assistant handler includes only supplied bounded company aggregate context", async () => {
  let body;
  const handler = createOpenAIHandler({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: "日報サンプルでは岡山現場が最多です。" }) };
    }
  });
  const result = await handler({ request: "どの現場が多い？", companyContext: { reportCount: 12, topSites: [{ name: "岡山現場", count: 5 }] } });
  assert.equal(result.answer, "日報サンプルでは岡山現場が最多です。");
  assert.match(body.input, /岡山現場/);
  assert.match(body.instructions, /売上・経費・利益/);
});
