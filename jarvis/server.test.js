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
