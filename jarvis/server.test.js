"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./server");

const token = "test-token-that-is-at-least-32-bytes-long";
let server;
let base;

test.before(async () => {
  server = createServer({ token });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
});

test("health endpoint is public and reports running", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "running");
});

test("protected status rejects missing token", async () => {
  const response = await fetch(`${base}/v1/status`);
  assert.equal(response.status, 401);
});

test("protected status accepts valid token", async () => {
  const response = await fetch(`${base}/v1/status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "read-only");
});

test("command endpoint requires JSON", async () => {
  const response = await fetch(`${base}/v1/command`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: "command=status"
  });
  assert.equal(response.status, 415);
});

test("command endpoint accepts status command", async () => {
  const response = await fetch(`${base}/v1/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ command: "status" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "read-only");
});

test("unknown commands are rejected", async () => {
  const response = await fetch(`${base}/v1/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ command: "delete-everything" })
  });
  assert.equal(response.status, 400);
});

test("unknown routes are not found", async () => {
  const response = await fetch(`${base}/missing`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 404);
});


test("Google Sheets list route forwards authenticated request to Apps Script", async () => {
  let sent;
  const sheetsUrl = "https://script.google.com/macros/s/test-id/exec";
  const app = createServer({
    token,
    sheetsUrl,
    sheetsToken: "a".repeat(128),
    fetchImpl: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ ok: true, sheets: ["01従業員", "日報"] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/sheets/list`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).sheets, ["01従業員", "日報"]);
    assert.equal(sent.url, sheetsUrl);
    assert.equal(sent.body.action, "listSheets");
    assert.equal(sent.body.token, "a".repeat(128));
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});

test("Google Sheets routes reject invalid sheet names", async () => {
  const app = createServer({ token, sheetsUrl: "https://script.google.com/macros/s/test-id/exec", sheetsToken: "b".repeat(128) });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/sheets/read?sheetName=missing`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});


test("public Sheets health check verifies Apps Script without exposing secrets", async () => {
  const sent = [];
  const app = createServer({
    token,
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "c".repeat(128),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      return { ok: true, json: async () => body.action === "listSheets"
        ? ({ ok: true, sheets: ["01従業員", "15設定"] })
        : ({ ok: true, rows: [["設定項目"]] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result, { ok: true, googleSheets: "connected", sheetCount: 2, readTest: "success", rowsRead: 1, columnsRead: 1 });
    assert.deepEqual(sent.map(x => x.action), ["listSheets", "readRows"]);
    assert.equal(sent[1].sheetName, "15設定");
    assert.equal(sent[0].token, "c".repeat(128));
    assert.equal(JSON.stringify(result).includes("cccc"), false);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});
