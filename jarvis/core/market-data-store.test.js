"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MarketDataStore } = require("./market-data-store");
const { stable } = require("./market-data-normalizer");

const source = {
  id: "source-uuid", source_key: "binance-public-jpy", provider: "Binance public market-data API",
  license_id: "license-v1", license_approved: true, license_evidence_ref: "evidence:approved",
  license_reviewed_at: "2026-11-21T00:00:00.000Z",
  venue_allowlist: ["BINANCE_PUBLIC"], currency_allowlist: ["JPY"], enabled: true
};
const bar = {
  sourceId: source.id, provider: source.provider, licenseId: source.license_id,
  venue: "BINANCE_PUBLIC", symbol: "BTCJPY", currency: "JPY", interval: "1m",
  openTimeUtc: "2026-11-22T11:58:00.000Z", closeTimeUtc: "2026-11-22T11:58:59.999Z",
  sourceTimestampRaw: "2026-11-22T11:58:00Z", sourceTimezone: "UTC",
  receivedAtUtc: "2026-11-22T11:59:00.000Z", open: "100", high: "102", low: "99",
  close: "101", volume: "10", quoteVolume: null, adjustmentState: "raw",
  normalizedHash: "a".repeat(64), rawPayloadHash: "b".repeat(64)
};
function payloadHash(bars=[bar], findings=[]) {
  return crypto.createHash("sha256").update(stable({
    sourceId: source.id,
    bars: bars.map(b => ({ normalizedHash:b.normalizedHash, rawPayloadHash:b.rawPayloadHash||null })),
    findings,
    findingCorrections: []
  })).digest("hex");
}
function fakePool({ sourceRow=source, prior=null, conflictBar=false, existingBar=null, revisionNo=1 }={}) {
  const calls=[];
  const client={
    async query(sql,params=[]) {
      calls.push({sql,params});
      if (sql.includes("SELECT id, source_key")) return {rowCount:sourceRow?1:0,rows:sourceRow?[sourceRow]:[]};
      if (sql.includes("SELECT id, source_id, status, raw_payload_hash")) return {rowCount:prior?1:0,rows:prior?[prior]:[]};
      if (sql.includes("INSERT INTO market_bars")) return {rowCount:conflictBar?0:1,rows:conflictBar?[]:[{id:"bar-1"}]};
      if (sql.includes("SELECT id, normalized_hash, to_jsonb")) return {rowCount:existingBar?1:0,rows:existingBar?[existingBar]:[]};
      if (sql.includes("SELECT COALESCE(MAX(revision_no)")) return {rowCount:1,rows:[{next_revision:revisionNo}]};
      if (sql.includes("SELECT event_hash")) return {rowCount:0,rows:[]};
      return {rowCount:1,rows:[]};
    },
    release(){calls.push({sql:"RELEASE",params:[]});}
  };
  return {pool:{connect:async()=>client},calls};
}
function input(overrides={}) {
  return {sourceId:source.id,batchId:"batch-1",idempotencyKey:"key-1",bars:[bar],findings:[],...overrides};
}

test("store refuses disabled or unapproved sources before writing", async()=>{
  for (const row of [{...source,enabled:false},{...source,license_approved:false}]) {
    const f=fakePool({sourceRow:row});
    await assert.rejects(()=>new MarketDataStore({pool:f.pool}).ingest(input()),/disabled|Approved provider/);
    assert.equal(f.calls.some(c=>c.sql.includes("INSERT INTO market_bars")),false);
  }
});

test("store checks venue and quote currency allowlists", async()=>{
  const f=fakePool({sourceRow:{...source,currency_allowlist:["USD"]}});
  await assert.rejects(()=>new MarketDataStore({pool:f.pool}).ingest(input()),/currency is not allowlisted/);
  assert.equal(f.calls.some(c=>c.sql.includes("INSERT INTO market_bars")),false);
});

test("quality gate marks only accepted bars passed and commits audit", async()=>{
  const f=fakePool();
  const result=await new MarketDataStore({pool:f.pool}).ingest(input());
  assert.equal(result.quality,"completed");
  assert.equal(result.inserted,1);
  assert.ok(f.calls.some(c=>c.sql.includes("UPDATE market_bars SET verification_status=$2")&&c.params[1]==="passed"));
  assert.ok(f.calls.some(c=>c.sql.includes("INSERT INTO market_data_audit_events")));
  assert.ok(f.calls.some(c=>c.sql.includes("COMMIT")));
});

test("high-severity findings quarantine bars and batch", async()=>{
  const f=fakePool();
  const result=await new MarketDataStore({pool:f.pool}).ingest(input({findings:[{code:"TEST_BLOCKER",severity:"high",details:{fixture:true}}]}));
  assert.equal(result.quality,"quarantined");
  assert.ok(f.calls.some(c=>c.sql.includes("UPDATE market_bars SET verification_status=$2")&&c.params[1]==="quarantined"));
  assert.ok(f.calls.some(c=>c.sql.includes("UPDATE market_ingest_batches SET status=$2")&&c.params[1]==="quarantined"));
});

test("same idempotency key with same payload returns replay without writes", async()=>{
  const hash=payloadHash();
  const f=fakePool({prior:{id:"batch-prior",source_id:source.id,status:"completed",raw_payload_hash:hash}});
  const result=await new MarketDataStore({pool:f.pool}).ingest(input());
  assert.equal(result.idempotentReplay,true);
  assert.equal(result.batchId,"batch-prior");
  assert.equal(f.calls.some(c=>c.sql.includes("INSERT INTO market_bars")),false);
});

test("same idempotency key with different payload fails closed", async()=>{
  const f=fakePool({prior:{id:"batch-prior",source_id:source.id,status:"completed",raw_payload_hash:"0".repeat(64)}});
  await assert.rejects(()=>new MarketDataStore({pool:f.pool}).ingest(input()),/different source or payload/);
});

test("provider candle revisions become high-severity quarantine findings", async()=>{
  const f=fakePool({conflictBar:true,existingBar:{id:"bar-old",normalized_hash:"c".repeat(64),prior_payload:{close:"100"}},revisionNo:2});
  const result=await new MarketDataStore({pool:f.pool}).ingest(input());
  assert.equal(result.revised,1);
  assert.equal(result.quality,"quarantined");
  assert.ok(f.calls.some(c=>c.sql.includes("INSERT INTO market_bar_revisions")));
  assert.ok(f.calls.some(c=>c.params.includes("CANDLE_REVISION")));
});
