"use strict";
const test=require("node:test"); const assert=require("node:assert/strict");
const {savePaperProposal,saveSnapshotBundle,recordRiskEvent,PersistenceError}=require("../core/finance-persistence");
function mockPool({failAt=null,duplicate=false,existingHash=null}={}){
 let calls=[];let counter=0;
 return {calls,async connect(){return {async query(sql,params){calls.push({sql,params});counter++;if(failAt===counter)throw new Error("db offline");
 if(sql.includes("INSERT INTO jarvis_finance.trade_proposals")&&!duplicate)return {rows:[{id:"proposal-1"}]};
 if(sql.includes("INSERT INTO jarvis_finance.trade_proposals")&&duplicate)return {rows:[]};
 if(sql.includes("SELECT id, request_hash"))return {rows:existingHash?[{id:"proposal-old",request_hash:existingHash}]:[{id:"proposal-old",request_hash:"different"}]};
 if(sql.includes("INSERT INTO jarvis_finance.market_snapshots"))return {rows:[{id:7}]};
 if(sql.includes("INSERT INTO jarvis_finance.risk_events"))return {rows:[{id:9}]};
 return {rows:[]};},release(){calls.push({release:true});}};}};
}
const proposal={idempotencyKey:"p-1",symbol:"BTCJPY",side:"BUY",amountJpy:10000,status:"PAPER_ONLY",liveExecution:false,rationale:{why:"test"}};
test("persists paper proposal and shared audit event in one transaction",async()=>{const pool=mockPool();const r=await savePaperProposal(pool,proposal);assert.deepEqual(r,{id:"proposal-1",duplicate:false});assert.ok(pool.calls.some(x=>x.sql.includes("public.jarvis_audit_events")));assert.ok(pool.calls.some(x=>x.sql==="COMMIT"));});
test("duplicate idempotency key returns existing proposal without duplicate audit",async()=>{const pool=mockPool({duplicate:true,existingHash:require("node:crypto").createHash("sha256").update(JSON.stringify({symbol:"BTCJPY",side:"BUY",amountJpy:10000,rationale:{why:"test"}})).digest("hex")});const r=await savePaperProposal(pool,proposal);assert.equal(r.duplicate,true);assert.equal(pool.calls.filter(x=>x.sql.includes("public.jarvis_audit_events")).length,0);});
test("same idempotency key with different content is rejected",async()=>{const pool=mockPool({duplicate:true});await assert.rejects(()=>savePaperProposal(pool,proposal),e=>e.code==="IDEMPOTENCY_CONFLICT");assert.ok(pool.calls.some(x=>x.sql==="ROLLBACK"));});
test("database failure rolls back and fails closed",async()=>{const pool=mockPool({failAt:2});await assert.rejects(()=>savePaperProposal(pool,proposal),e=>e.code==="PERSISTENCE_UNAVAILABLE");assert.ok(pool.calls.some(x=>x.sql==="ROLLBACK"));});
test("does not persist live or non-paper proposals",async()=>{await assert.rejects(()=>savePaperProposal(mockPool(),{...proposal,status:"PENDING_REVIEW"}),e=>e.code==="UNSAFE_PROPOSAL");});
test("stores snapshot and indicators transactionally",async()=>{const pool=mockPool();const r=await saveSnapshotBundle(pool,{symbol:"BTCJPY",source:"public",sourceHost:"data-api.binance.vision",venueCompatibility:"UNVERIFIED_BINANCE_JAPAN_ACCOUNT",observedAt:Date.now()},{rsi14:50});assert.equal(r.snapshotId,7);assert.ok(pool.calls.some(x=>x.sql.includes("technical_indicators")));});
test("records risk event and shared audit entry",async()=>{const pool=mockPool();const id=await recordRiskEvent(pool,{code:"LOSS_LIMIT",severity:"CRITICAL"});assert.equal(id,9);assert.ok(pool.calls.some(x=>x.sql.includes("public.jarvis_audit_events")));});
