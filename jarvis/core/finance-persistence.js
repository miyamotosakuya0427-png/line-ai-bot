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
function validatePortfolioState(state) {
  const caps = { BTC: 17500, ETH: 10500, SOL: 7000 };
  const stages = [10000, 15000, 10000];
  if (!state || state.initialCapitalJpy !== 50000 || state.investmentCapJpy !== 35000 ||
      state.reserveJpy !== 15000 || !Number.isSafeInteger(state.investedJpy) ||
      state.investedJpy < 0 || state.investedJpy > 35000 ||
      !Number.isSafeInteger(state.feesJpy || 0) || (state.feesJpy || 0) < 0) {
    throw new PersistenceError("Portfolio exceeds the 50,000 JPY policy or violates reserve protection", "PORTFOLIO_LIMIT");
  }
  const allocations = state.assetAllocations || {};
  const stagesSpent = state.stageSpent || [];
  const allocationTotal = ["BTC", "ETH", "SOL"].reduce((sum, key) => {
    const value = allocations[key] || 0;
    if (!Number.isSafeInteger(value) || value < 0 || value > caps[key]) throw new PersistenceError("Asset allocation cap exceeded", "ASSET_ALLOCATION_CAP");
    return sum + value;
  }, 0);
  const stageTotal = stages.reduce((sum, cap, index) => {
    const value = stagesSpent[index] || 0;
    if (!Number.isSafeInteger(value) || value < 0 || value > cap) throw new PersistenceError("Stage purchase cap exceeded", "STAGE_LIMIT");
    return sum + value;
  }, 0);
  if (allocationTotal !== state.investedJpy || stageTotal !== state.investedJpy || allocationTotal > 35000 || stageTotal > 35000) {
    throw new PersistenceError("Portfolio allocation totals are inconsistent", "PORTFOLIO_LIMIT");
  }
  const netPnl = (state.realizedPnlJpy || 0) + (state.unrealizedPnlJpy || 0) - (state.feesJpy || 0);
  return { halted: state.halted === true || netPnl <= -2500, netPnlJpy: netPnl };
}
async function savePortfolioState(pool, state) {
  if (!state || !state.portfolioKey) throw new PersistenceError("Portfolio key is required", "PORTFOLIO_NOT_FOUND");
  const risk = validatePortfolioState(state);
  return inTransaction(pool, async client => {
    const result = await client.query(
      "INSERT INTO jarvis_finance.portfolios(portfolio_key,initial_capital_jpy,investment_cap_jpy,reserve_jpy,invested_jpy,realized_pnl_jpy,unrealized_pnl_jpy,fees_jpy,halted,asset_allocations,stage_spent) VALUES($1,50000,35000,15000,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) ON CONFLICT(portfolio_key) DO UPDATE SET invested_jpy=EXCLUDED.invested_jpy,realized_pnl_jpy=EXCLUDED.realized_pnl_jpy,unrealized_pnl_jpy=EXCLUDED.unrealized_pnl_jpy,fees_jpy=EXCLUDED.fees_jpy,halted=jarvis_finance.portfolios.halted OR EXCLUDED.halted,asset_allocations=EXCLUDED.asset_allocations,stage_spent=EXCLUDED.stage_spent,updated_at=now() RETURNING portfolio_key,halted",
      [state.portfolioKey, state.investedJpy, state.realizedPnlJpy || 0, state.unrealizedPnlJpy || 0, state.feesJpy || 0, risk.halted, JSON.stringify(state.assetAllocations || {}), JSON.stringify(state.stageSpent || [])]
    );
    return { portfolioKey: result.rows[0].portfolio_key, halted: result.rows[0].halted, netPnlJpy: risk.netPnlJpy, reserveJpy: 15000 };
  });
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
  if (!proposal.portfolioKey) throw new PersistenceError("A portfolio key is required", "PORTFOLIO_NOT_FOUND");
  const payload = { portfolioKey: proposal.portfolioKey, symbol: proposal.symbol, side: proposal.side, amountJpy: proposal.amountJpy, stageIndex: proposal.stageIndex ?? null, rationale: proposal.rationale || {} };
  const hash = stableHash(payload);
  return inTransaction(pool, async client => {
    const existing = await client.query("SELECT id, request_hash FROM jarvis_finance.trade_proposals WHERE idempotency_key=$1", [idempotencyKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash) throw new PersistenceError("Idempotency key reused with different proposal payload", "IDEMPOTENCY_CONFLICT");
      return { id: existing.rows[0].id, duplicate: true };
    }
    const portfolio = await client.query("SELECT invested_jpy,investment_cap_jpy,reserve_jpy,halted,asset_allocations,stage_spent FROM jarvis_finance.portfolios WHERE portfolio_key=$1 FOR UPDATE", [proposal.portfolioKey]);
    if (!portfolio.rows[0]) throw new PersistenceError("Portfolio does not exist", "PORTFOLIO_NOT_FOUND");
    const current = portfolio.rows[0];
    if (Number(current.investment_cap_jpy) !== 35000 || Number(current.reserve_jpy) !== 15000) {
      throw new PersistenceError("Stored portfolio policy does not match the approved 50,000 JPY limits", "PORTFOLIO_POLICY_MISMATCH");
    }
    if (current.halted) throw new PersistenceError("Portfolio is halted", "LOSS_LIMIT_REACHED");
    if (proposal.side === "BUY") {
      if (Number(current.invested_jpy) + proposal.amountJpy > 35000 || 50000 - (Number(current.invested_jpy) + proposal.amountJpy) < 15000) {
        throw new PersistenceError("Investment cap or JPY 15,000 reserve would be breached", "INVESTMENT_CAP");
      }
      const asset = proposal.symbol.slice(0,3);
      const caps = { BTC:17500, ETH:10500, SOL:7000 };
      const allocations = current.asset_allocations || {};
      if ((Number(allocations[asset]) || 0) + proposal.amountJpy > caps[asset]) throw new PersistenceError("Per-asset cap would be breached", "ASSET_ALLOCATION_CAP");
      const stageCaps = [10000,15000,10000];
      const stageIndex = proposal.stageIndex;
      if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 2) throw new PersistenceError("A valid purchase stage is required", "STAGE_LIMIT");
      const stageSpent = current.stage_spent || [];
      if ((Number(stageSpent[stageIndex]) || 0) + proposal.amountJpy > stageCaps[stageIndex]) throw new PersistenceError("Purchase stage cap would be breached", "STAGE_LIMIT");
    }
    const inserted = await client.query(
      "INSERT INTO jarvis_finance.trade_proposals(id, idempotency_key, request_hash, portfolio_key, job_id, approval_id, symbol, side, amount_jpy, stage_index, status, rationale) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PAPER_ONLY',$11::jsonb) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id",
      [randomUUID(), idempotencyKey, hash, proposal.portfolioKey, proposal.jobId || null, proposal.approvalId || null, proposal.symbol, proposal.side, proposal.amountJpy, proposal.stageIndex ?? null, JSON.stringify(payload.rationale)]
    );
    if (inserted.rows[0]) {
      if (proposal.side === "BUY") {
        const asset = proposal.symbol.slice(0,3);
        await client.query(
          "UPDATE jarvis_finance.portfolios SET invested_jpy=invested_jpy+$2, asset_allocations=jsonb_set(asset_allocations, ARRAY[$3::text], to_jsonb(COALESCE((asset_allocations->>$3)::bigint,0)+$2), true), stage_spent=jsonb_set(stage_spent, ARRAY[$4::text], to_jsonb(COALESCE((stage_spent->>$4)::bigint,0)+$2), true), updated_at=now() WHERE portfolio_key=$1",
          [proposal.portfolioKey, proposal.amountJpy, asset, String(proposal.stageIndex)]
        );
      }
      await client.query(
        "INSERT INTO public.jarvis_audit_events(event_id, actor, action, resource_type, resource_id, metadata) VALUES($1,$2,'PAPER_PROPOSAL_SAVED','finance_trade_proposal',$3,$4::jsonb) ON CONFLICT(event_id) DO NOTHING",
        [randomUUID(), proposal.actor || "one-jarvis-finance", inserted.rows[0].id, JSON.stringify({ idempotencyKey, symbol: proposal.symbol, side: proposal.side, amountJpy: proposal.amountJpy, status: "PAPER_ONLY" })]
      );
      return { id: inserted.rows[0].id, duplicate: false };
    }
    const conflict = await client.query("SELECT id, request_hash FROM jarvis_finance.trade_proposals WHERE idempotency_key=$1", [idempotencyKey]);
    if (!conflict.rows[0] || conflict.rows[0].request_hash !== hash) throw new PersistenceError("Idempotency key conflict", "IDEMPOTENCY_CONFLICT");
    return { id: conflict.rows[0].id, duplicate: true };
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
module.exports = { PersistenceError, validatePortfolioState, savePortfolioState, saveSnapshotBundle, savePaperProposal, recordRiskEvent };
