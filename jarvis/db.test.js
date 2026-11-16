"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry, hashPayload, createDbStore } = require("./db");

test("stable payload hashing ignores object key order", () => {
  assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
});

test("retry retries transient failures and returns successful result", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) { const error = new Error("temporary"); error.code = "ECONNRESET"; throw error; }
    return "ok";
  }, { attempts: 3, baseDelayMs: 0, sleepImpl: async () => {}, random: () => 0 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("retry does not retry non-transient errors", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    const error = new Error("constraint violation"); error.code = "23505"; throw error;
  }, { attempts: 4, sleepImpl: async () => {} }), /constraint violation/);
  assert.equal(calls, 1);
});

test("retry rejects invalid attempt limits", async () => {
  await assert.rejects(withRetry(async () => "unused", { attempts: 6 }), /attempts/);
});

test("job idempotency returns existing record and rejects conflicting payloads", async () => {
  const rows = new Map();
  const pool = {
    async query(sql, values) {
      if (sql.startsWith("INSERT INTO jarvis_jobs")) {
        const [key, hash, type, payload] = values;
        if (rows.has(key)) return { rows: [], rowCount: 0 };
        const row = { id: "job-1", idempotency_key: key, request_hash: hash, type, payload };
        rows.set(key, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("SELECT * FROM jarvis_jobs")) return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [], rowCount: rows.has(values[0]) ? 1 : 0 };
      throw new Error("Unexpected SQL");
    },
    async end() {}
  };
  const store = createDbStore({ pool });
  const first = await store.createJob({ idempotencyKey: "job-key-0001", type: "report.generate", payload: { report: 1 } });
  const duplicate = await store.createJob({ idempotencyKey: "job-key-0001", type: "report.generate", payload: { report: 1 } });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);
  await assert.rejects(store.createJob({ idempotencyKey: "job-key-0001", type: "report.generate", payload: { report: 2 } }), error => error.code === "IDEMPOTENCY_CONFLICT" && error.statusCode === 409);
});

test("approval decisions only transition pending approvals once", async () => {
  let status = "pending";
  const pool = {
    async query(sql, values) {
      if (sql.startsWith("UPDATE jarvis_approvals")) {
        if (status !== "pending") return { rows: [], rowCount: 0 };
        status = values[1];
        return { rows: [{ id: values[0], status, reviewed_by: values[2] }], rowCount: 1 };
      }
      throw new Error("Unexpected SQL");
    },
    async end() {}
  };
  const store = createDbStore({ pool });
  const approved = await store.decideApproval({ approvalId: "approval-1", reviewedBy: "admin", decision: "approved" });
  assert.equal(approved.status, "approved");
  await assert.rejects(store.decideApproval({ approvalId: "approval-1", reviewedBy: "admin", decision: "rejected" }), error => error.code === "APPROVAL_ALREADY_DECIDED");
});

test("audit event IDs make duplicate writes idempotent", async () => {
  const rows = new Map();
  const pool = {
    async query(sql, values) {
      if (sql.startsWith("INSERT INTO jarvis_audit_events")) {
        const [id, actor, action, resourceType] = values;
        if (rows.has(id)) return { rows: [], rowCount: 0 };
        const row = { event_id: id, actor, action, resource_type: resourceType };
        rows.set(id, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("SELECT * FROM jarvis_audit_events")) return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [], rowCount: rows.has(values[0]) ? 1 : 0 };
      throw new Error("Unexpected SQL");
    },
    async end() {}
  };
  const store = createDbStore({ pool });
  const first = await store.appendAuditEvent({ eventId: "00000000-0000-4000-8000-000000000001", actor: "system", action: "job.created", resourceType: "job" });
  const duplicate = await store.appendAuditEvent({ eventId: "00000000-0000-4000-8000-000000000001", actor: "system", action: "job.created", resourceType: "job" });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
});

test("pool is not constructed when Neon URL is absent", () => {
  assert.throws(() => createDbStore({}), /NEON_DATABASE_URL/);
});
