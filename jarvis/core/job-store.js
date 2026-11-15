"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const STATES = new Set(["queued","running","succeeded","failed","cancelled"]);
const NEXT = {
  queued: new Set(["running","cancelled"]),
  running: new Set(["succeeded","failed","queued","cancelled"]),
  succeeded: new Set(),
  failed: new Set(["queued","cancelled"]),
  cancelled: new Set()
};
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_JOBS = 10000;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value),"utf8") <= MAX_PAYLOAD_BYTES; }
  catch { return false; }
}
function publicJob(job) { return clone(job); }

function createJobStore({ filePath, clock = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("JARVIS job store requires an absolute persistent file path");
  }
  let jobs = new Map();
  let initialized = false;
  let queue = Promise.resolve();

  async function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function append(event) {
    const handle = await fs.open(filePath, "a", 0o600);
    try {
      await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.chmod(filePath, 0o600);
  }
  async function init() {
    return serialize(async () => {
      if (initialized) return;
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      let raw = "";
      try { raw = await fs.readFile(filePath, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const recovered = new Map();
      for (const [index,line] of raw.split("\n").entries()) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); }
        catch { throw new Error("JARVIS job journal is corrupt at line " + (index + 1)); }
        if (!event || event.type !== "job" || !event.job || typeof event.job.id !== "string" || !STATES.has(event.job.status)) {
          throw new Error("JARVIS job journal contains an invalid event at line " + (index + 1));
        }
        recovered.set(event.job.id, event.job);
      }
      if (recovered.size > MAX_JOBS) throw new Error("JARVIS job journal exceeds the configured job limit");
      jobs = recovered;
      initialized = true;
    });
  }
  async function ready() {
    if (!initialized) await init();
  }
  return {
    async init() { await ready(); return { ok: true, count: jobs.size }; },
    async create({ type, payload, idempotencyKey = "" } = {}) {
      await ready();
      return serialize(async () => {
        if (typeof type !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(type)) throw new Error("Invalid job type");
        if (!validPayload(payload)) throw new Error("Job payload must be an object no larger than 16 KB");
        if (idempotencyKey && (typeof idempotencyKey !== "string" || idempotencyKey.length > 128)) throw new Error("Invalid idempotency key");
        if (idempotencyKey) {
          const existing = [...jobs.values()].find(job => job.idempotencyKey === idempotencyKey);
          if (existing) return { job: publicJob(existing), created: false };
        }
        if (jobs.size >= MAX_JOBS) throw new Error("Job store capacity reached");
        const now = clock();
        const job = { id: crypto.randomUUID(), type, payload: clone(payload), status: "queued", attempts: 0, idempotencyKey, createdAt: now, updatedAt: now, error: null, result: null };
        await append({ type: "job", job });
        jobs.set(job.id, job);
        return { job: publicJob(job), created: true };
      });
    },
    async get(id) {
      await ready();
      const job = jobs.get(id);
      return job ? publicJob(job) : null;
    },
    async list({ status, limit = 50 } = {}) {
      await ready();
      if (status && !STATES.has(status)) throw new Error("Invalid job status");
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid list limit");
      return [...jobs.values()].filter(job => !status || job.status === status)
        .sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,limit).map(publicJob);
    },
    async transition(id, nextStatus, { error = null, result = undefined } = {}) {
      await ready();
      return serialize(async () => {
        const current = jobs.get(id);
        if (!current) return null;
        if (!STATES.has(nextStatus) || !NEXT[current.status].has(nextStatus)) throw new Error("Invalid job state transition");
        if (error !== null && (typeof error !== "string" || error.length > 500)) throw new Error("Invalid job error");
        if (result !== undefined && !validPayload(result)) throw new Error("Invalid job result");
        const next = { ...current, status: nextStatus, updatedAt: clock(), error: nextStatus === "failed" ? (error || "Job failed") : null,
          result: nextStatus === "succeeded" ? (result === undefined ? current.result : clone(result)) : null };
        if (nextStatus === "running") next.attempts += 1;
        await append({ type: "job", job: next });
        jobs.set(id, next);
        return publicJob(next);
      });
    }
  };
}
module.exports = { createJobStore, STATES };
