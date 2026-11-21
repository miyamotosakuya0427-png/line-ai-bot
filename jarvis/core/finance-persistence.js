"use strict";
const { createHash, randomUUID } = require("node:crypto");

class PersistenceError extends Error {
  constructor(message, code = "PERSISTENCE_UNAVAILABLE") { super(message); this.name = "PersistenceError"; this.code = code; }
}
function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function inTransaction(pool, work) {
  if (!pool || typeof pool.connect !== "function") throw new PersistenceError("A PostgreSQL pool with connect() is required", "DATABASE_NOT_CONFIGURED");
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("Financial persistence failed; operation was rolled back", "PERSISTENCE_UNAVAILABLE");
  } finally {
    if (client) client.release();
  }
}
function requireSafePaperProposal(p) {
  if (!p || !["BTCJPY", "ETHJPY", "SOLJPY"].includes(p.symbol) ||
      !["BUY", "SELL"].includes(p.side) || !Number.isSafeInteger(p.amountJpy) || p.amountJpy <= 0 ||
      p.status !== "PAPER_ONLY" || p.liveExecution !== false) {
    throw new PersistenceError("Only valid PAPER_ONLY proposals can be persisted", "UNSAFE_PROPOSAL");
  }
}
async function saveSnapshotBundle(pool, snapshot, indicators) {
  if (!snapshot || snapshot.venueCompatibility !== "UNVERIFIED_BINANCE_JAPAN_ACCOUNT" ||
      !["BTCJPY", "ETHJPY", "SOLJPY"].includes(snapshot.symbol) || !indicators) {
    throw new PersistenceError("Invalid or untrusted market snapshot", "INVALID_SNAPSHOT");
  }
  return inTransaction(pool, async client => {
    const snap = await client.query(
      "INSERT INTO jarvis_finance.market_snapshots(source, source_host, venue_compatibility, symbol, observed_at, payload) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),$6::jsonb) ON CONFLICT(symbol, observed_at) DO NOTHING RETURNING id",
      [snapshot.source, snapshot.sourceHost, snapshot.venueCompatibility, snapshot.symbol, snapshot.observedAt, JSON.stringify(snapshot)]
    );
    let snapshotId;
    if (snap.rows[0]) snapshotId = snap.rows[0].id;
    else {
      const existing = await client.query("SELECT id FROM jarvis_finance.market_snapshots WHERE symbol=$1 AND observed_at=to_timestamp($2/1000.0)", [snapshot.symbol, snapshot.observedAt]);
      if (!existing.rows[0]) throw new PersistenceError("Snapshot conflict could not be resolved", "IDEMPOTENCY_CONFLICT");
      snapshotId = existing.rows[0].id;
    }
    await client.query(
      "INSERT INTO jarvis_finance.technical_indicators(snapshot_id, observed_at, indicators) VALUES($1,to_timestamp($2/1000.0),$3::jsonb) ON CONFLICT(snapshot_id) DO NOTHING",
      [snapshotId, snapshot.observedAt, JSON.stringify(indicators)]
    );
    return { snapshotId, duplicate: !snap.rows[0] };
  });
}
async function savePaperProposal(pool, proposal) {
  requireSafePaperProposal(proposal);
  const idempotencyKey = String(proposal.idempotencyKey || "");
  if (!idempotencyKey || idempotencyKey.length > 200) throw new PersistenceError("A bounded idempotency key is required", "INVALID_IDEMPOTENCY_KEY");
  const payload = { symbol: proposal.symbol, side: proposal.side, amountJpy: proposal.amountJpy, rationale: proposal.rationale || {} };
  const hash = stableHash(payload);
  return inTransaction(pool, async client => {
    const inserted = await client.query(
      "INSERT INTO jarvis_finance.trade_proposals(id, idempotency_key, job_id, approval_id, symbol, side, amount_jpy, status, request_hash, rationale) VALUES($1,$2,$3,$4,$5,$6,$7,'PAPER_ONLY',$8,$9::jsonb) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id",
      [randomUUID(), idempotencyKey, proposal.jobId || null, proposal.approvalId || null, proposal.symbol, proposal.side, proposal.amountJpy, hash, JSON.stringify(payload.rationale)]
    );
    if (inserted.rows[0]) {
      await client.query(
        "INSERT INTO public.jarvis_audit_events(event_id, actor, action, resource_type, resource_id, metadata) VALUES($1,$2,'PAPER_PROPOSAL_SAVED','finance_trade_proposal',$3,$4::jsonb) ON CONFLICT(event_id) DO NOTHING",
        [randomUUID(), proposal.actor || "one-jarvis-finance", inserted.rows[0].id, JSON.stringify({ idempotencyKey, symbol: proposal.symbol, side: proposal.side, amountJpy: proposal.amountJpy, status: "PAPER_ONLY" })]
      );
      return { id: inserted.rows[0].id, duplicate: false };
    }
    const existing = await client.query("SELECT id, request_hash FROM jarvis_finance.trade_proposals WHERE idempotency_key=$1", [idempotencyKey]);
    if (!existing.rows[0] || existing.rows[0].request_hash !== hash) throw new PersistenceError("Idempotency key reused with different proposal payload", "IDEMPOTENCY_CONFLICT");
    return { id: existing.rows[0].id, duplicate: true };
  });
}
async function recordRiskEvent(pool, event) {
  if (!event || typeof event.code !== "string" || !["INFO", "WARN", "CRITICAL"].includes(event.severity)) {
    throw new PersistenceError("Invalid risk event", "INVALID_RISK_EVENT");
  }
  return inTransaction(pool, async client => {
    const r = await client.query("INSERT INTO jarvis_finance.risk_events(event_code,severity,details) VALUES($1,$2,$3::jsonb) RETURNING id", [event.code, event.severity, JSON.stringify(event.details || {})]);
    await client.query("INSERT INTO public.jarvis_audit_events(event_id,actor,action,resource_type,resource_id,metadata) VALUES($1,$2,'RISK_EVENT_RECORDED','finance_risk_event',$3,$4::jsonb)", [randomUUID(), event.actor || "one-jarvis-finance", String(r.rows[0].id), JSON.stringify({ code: event.code, severity: event.severity })]);
    return r.rows[0].id;
  });
}
module.exports = { PersistenceError, saveSnapshotBundle, savePaperProposal, recordRiskEvent };
