"use strict";
const { Pool } = require("pg");
const { createServer } = require("../server");
const { createTaskEventOutbox } = require("../core/task-event-outbox");

const DURATION_MS = 60 * 60 * 1000;
const RECONNECT_MS = 5 * 60 * 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const apiToken = "stage12-isolated-api-token-".padEnd(40, "x");
const registryTokens = [1,2,3].map(n => ("stage12-agent-token-" + n + "-").padEnd(40, String(n)));
const scopes = [1,2,3].map(n => ({ agentId:"stage12-agent-"+n, projectId:"stage12-project-"+n, conversationId:"stage12-conversation-"+n, taskId:"stage12-soak-task-"+n }));
const revoked = new Set();
let suppressWakeups = false;
const metrics = {
  startedAt: new Date().toISOString(), durationTargetSeconds: 3600,
  eventsReceived: [0,0,0], duplicates: [0,0,0], cursorGaps: [0,0,0],
  reconnects: [0,0,0], authorizationChecks: [0,0,0], revocationClosed: false,
  listenerTerminationInjected: false, notifyWakeupSuppressionInjected: false,
  latencyMs: [], poolErrors: 0, httpErrors: 0
};
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, application_name: "stage12-sse-soak" });
pool.on("error", () => { metrics.poolErrors++; });
const baseOutbox = createTaskEventOutbox({ pool, maxBatch: 500 });
const outbox = {
  replay: args => baseOutbox.replay(args),
  listen: onWake => baseOutbox.listen(cursor => { if (!suppressWakeups) onWake(cursor); })
};
const principalByToken = new Map(registryTokens.map((token,i) => [token, scopes[i]]));
const server = createServer({
  token: apiToken,
  taskRegistry: {},
  authorizeTaskRegistry: async req => {
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const principal = principalByToken.get(token);
    if (!principal) return null;
    const index = scopes.indexOf(principal);
    metrics.authorizationChecks[index]++;
    if (revoked.has(principal.agentId)) return null;
    return { agentId: principal.agentId, conversationId: principal.conversationId, projectIds: [principal.projectId], scopes: ["tasks:read"] };
  },
  taskRegistryRateLimiter: { async consume() { return { allowed: true, retryAfter: 0 }; } },
  taskEventOutbox: outbox,
  taskRegistryRevocationStore: { async isRevoked() { return false; } }
});
const activeControllers = new Set();
const latency = metrics.latencyMs;
let finished = false;
let startedAtMs = Date.now();
let versions = [0,0,0];

async function insertEvent(index) {
  const s = scopes[index];
  versions[index]++;
  await pool.query(
    "INSERT INTO jarvis.events (aggregate_type,aggregate_id,aggregate_version,event_type,payload,idempotency_key) VALUES ('task',$1,$2,'progress',$3::jsonb,$4)",
    [s.taskId, versions[index], JSON.stringify({
      taskId:s.taskId, projectId:s.projectId, ownerConversation:s.conversationId,
      ownerAgent:s.agentId, departmentId:"stage12", status:"running", marker:"synthetic"
    }), "stage12-"+index+"-"+versions[index]]
  );
}

function parseFrames(buffer, onEvent) {
  let boundary;
  while ((boundary = buffer.indexOf("\n\n")) >= 0) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    let id = null, data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (id !== null && data) {
      try { onEvent(id, JSON.parse(data)); } catch { /* malformed frame counted by absent progress */ }
    }
  }
  return buffer;
}

async function consumeAgent(index, deadline) {
  let cursor = 0;
  const s = scopes[index];
  while (!finished && Date.now() < deadline && !revoked.has(s.agentId)) {
    const controller = new AbortController();
    activeControllers.add(controller);
    const headers = {
      Authorization: "Bearer " + apiToken,
      "X-Task-Registry-Authorization": "Bearer " + registryTokens[index],
      "Last-Event-ID": String(cursor)
    };
    let response;
    try {
      response = await fetch("http://127.0.0.1:" + server.address().port +
        "/v1/command-center/events?projectId=" + s.projectId + "&conversationId=" + s.conversationId,
        { headers, signal: controller.signal });
      if (response.status !== 200) {
        metrics.httpErrors++;
        throw new Error("SSE HTTP status " + response.status);
      }
      const reader = response.body.getReader();
      const reconnectTimer = setTimeout(() => controller.abort(), RECONNECT_MS);
      let buffer = "";
      try {
        while (!finished && Date.now() < deadline) {
          const part = await reader.read();
          if (part.done) break;
          buffer += new TextDecoder().decode(part.value);
          buffer = parseFrames(buffer, (eventCursor, event) => {
            if (eventCursor <= cursor) { metrics.duplicates[index]++; return; }
            if (eventCursor !== cursor + 1) metrics.cursorGaps[index]++;
            cursor = eventCursor;
            metrics.eventsReceived[index]++;
            const created = Date.parse(event.createdAt);
            if (Number.isFinite(created)) latency.push(Math.max(0, Date.now() - created));
          });
          if (index === 2) await delay(50);
        }
      } finally {
        clearTimeout(reconnectTimer);
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (!controller.signal.aborted && !finished && !revoked.has(s.agentId)) metrics.httpErrors++;
    } finally {
      controller.abort();
      activeControllers.delete(controller);
    }
    if (!finished && Date.now() < deadline && !revoked.has(s.agentId)) {
      metrics.reconnects[index]++;
      await delay(250);
    }
  }
  if (revoked.has(s.agentId)) metrics.revocationClosed = true;
  return cursor;
}

async function main() {
  await new Promise((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
  const deadline = Date.now() + DURATION_MS;
  const consumers = scopes.map((_,i) => consumeAgent(i, deadline));
  let tick = 0;
  while (Date.now() < deadline) {
    await Promise.all(scopes.map((_,i) => insertEvent(i)));
    tick++;
    const elapsed = Date.now() - startedAtMs;
    if (elapsed >= 10*60*1000 && elapsed < 15*60*1000) {
      suppressWakeups = true;
      metrics.notifyWakeupSuppressionInjected = true;
    } else suppressWakeups = false;
    if (elapsed >= 20*60*1000 && !metrics.listenerTerminationInjected) {
      const listeners = await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name='stage12-sse-soak' AND query ILIKE 'LISTEN jarvis_task_events%' AND pid<>pg_backend_pid()"
      );
      for (const row of listeners.rows) await pool.query("SELECT pg_terminate_backend($1)", [row.pid]);
      metrics.listenerTerminationInjected = listeners.rows.length > 0;
    }
    if (elapsed >= 30*60*1000 && !revoked.has(scopes[1].agentId)) revoked.add(scopes[1].agentId);
    await delay(Math.max(0, 1000 - (Date.now() - (startedAtMs + tick*1000))));
  }
  finished = true;
  for (const controller of activeControllers) controller.abort();
  await Promise.all(consumers);
  const counts = await pool.query(
    "SELECT project_id,conversation_id,count(*)::int AS outbox_rows,max(scope_cursor)::bigint AS max_cursor FROM jarvis.task_event_outbox WHERE project_id LIKE 'stage12-project-%' GROUP BY project_id,conversation_id ORDER BY project_id"
  );
  const dbListeners = await pool.query(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='stage12-sse-soak' AND query ILIKE 'LISTEN jarvis_task_events%'"
  );
  const cpu = process.cpuUsage();
  const rss = process.memoryUsage().rss;
  const sorted = [...latency].sort((a,b)=>a-b);
  const percentile = p => sorted.length ? sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)] : null;
  const final = {
    ...metrics,
    latencyMs: undefined,
    latency: { samples: sorted.length, p50: percentile(.50), p95: percentile(.95), p99: percentile(.99) },
    elapsedSeconds: Math.round((Date.now()-startedAtMs)/1000),
    eventsWrittenPerScope: versions,
    outbox: counts.rows,
    remainingListenerConnections: dbListeners.rows[0]?.count ?? null,
    processRssBytes: rss,
    processCpuUserMicros: cpu.user,
    processCpuSystemMicros: cpu.system,
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    finishedAt: new Date().toISOString()
  };
  console.log(JSON.stringify(final));
  await new Promise(resolve => server.close(resolve));
  await pool.end();
  if (final.elapsedSeconds < 3600 || final.eventsReceived.some((n,i)=>i===1 ? n<1 : n<versions[i]-5) ||
      final.duplicates.some(n=>n!==0) || final.cursorGaps.some(n=>n!==0) ||
      !final.notifyWakeupSuppressionInjected || !final.listenerTerminationInjected ||
      !final.revocationClosed || final.remainingListenerConnections !== 0) {
    throw new Error("Stage 12 SSE soak acceptance criteria failed; inspect the redacted metrics artifact.");
  }
}
main().catch(async error => {
  console.error("Stage 12 isolated SSE soak failed: " + (error.message || "unknown failure"));
  for (const controller of activeControllers) controller.abort();
  try { server.close(); } catch {}
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
