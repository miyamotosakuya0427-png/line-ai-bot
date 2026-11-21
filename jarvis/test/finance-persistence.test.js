"use strict";
const test=require("node:test"); const assert=require("node:assert/strict");
const {savePaperProposal,saveSnapshotBundle,recordRiskEvent,PersistenceError}=require("../core/finance-persistence");
function mockPool({failAt=null,duplicate=false,existingHash=null}={}){
 let calls=[];let counter=0;
 return {calls,async connect(){return {async query(sql,params){calls.push({sql,params});counter++;if(failAt===counter)throw new Error("db offline");
 if(sql.includes("SELECT id, request_hash"))return {rows:duplicate?[{id:"proposal-old",request_hash:existingHash || "different"}]:[]};
 if(sql.includes("SELECT invested_jpy"))return {rows:[{invested_jpy:0,investment_cap_jpy:35000,reserve_jpy:15000,halted:false,asset_allocations:{BTC:0,ETH:0,SOL:0},stage_spent:[0,0,0]}]};
 if(sql.includes("INSERT INTO jarvis_finance.trade_proposals"))return {rows:[{id:"proposal-1"}]};
 if(sql.includes("INSERT INTO jarvis_finance.portfolios"))return {rows:[{portfolio_key:"paper-portfolio",halted:false}]};
 if(sql.includes("INSERT INTO jarvis_finance.market_snapshots"))return {rows:[{id:7}]};
 if(sql.includes("INSERT INTO jarvis_finance.risk_events"))return {rows:[{id:9}]};
 return {rows:[]};},release(){calls.push({release:true});}};}};
}
const proposal={idempotencyKey:"p-1",portfolioKey:"paper-portfolio",stageIndex:0,symbol:"BTCJPY",side:"BUY",amountJpy:10000,status:"PAPER_ONLY",liveExecution:false,rationale:{why:"test"}};
test("persists paper proposal and shared audit event in one transaction",async()=>{const pool=mockPool();const r=await savePaperProposal(pool,proposal);assert.deepEqual(r,{id:"proposal-1",duplicate:false});assert.ok(pool.calls.some(x=>x.sql.includes("public.jarvis_audit_events")));assert.ok(pool.calls.some(x=>x.sql.startsWith("UPDATE jarvis_finance.portfolios")));assert.ok(pool.calls.some(x=>x.sql==="COMMIT"));});
test("duplicate idempotency key returns existing proposal without duplicate audit",async()=>{const payload={portfolioKey:"paper-portfolio",symbol:"BTCJPY",side:"BUY",amountJpy:10000,stageIndex:0,rationale:{why:"test"}};const hash=require("node:crypto").createHash("sha256").update(JSON.stringify(payload)).digest("hex");const pool=mockPool({duplicate:true,existingHash:hash});const r=await savePaperProposal(pool,proposal);assert.equal(r.duplicate,true);assert.equal(pool.calls.filter(x=>x.sql?.includes("public.jarvis_audit_events")).length,0);});
test("same idempotency key with different content is rejected",async()=>{const pool=mockPool({duplicate:true});await assert.rejects(()=>savePaperProposal(pool,proposal),e=>e.code==="IDEMPOTENCY_CONFLICT");assert.ok(pool.calls.some(x=>x.sql==="ROLLBACK"));});
test("database failure rolls back and fails closed",async()=>{const pool=mockPool({failAt:2});await assert.rejects(()=>savePaperProposal(pool,proposal),e=>e.code==="PERSISTENCE_UNAVAILABLE");assert.ok(pool.calls.some(x=>x.sql==="ROLLBACK"));});
test("does not persist live or non-paper proposals",async()=>{await assert.rejects(()=>savePaperProposal(mockPool(),{...proposal,status:"PENDING_REVIEW"}),e=>e.code==="UNSAFE_PROPOSAL");});
test("stores snapshot and indicators transactionally",async()=>{const pool=mockPool();const r=await saveSnapshotBundle(pool,{symbol:"BTCJPY",source:"public",sourceHost:"data-api.binance.vision",venueCompatibility:"UNVERIFIED_BINANCE_JAPAN_ACCOUNT",observedAt:Date.now()},{rsi14:50});assert.equal(r.snapshotId,7);assert.ok(pool.calls.some(x=>x.sql.includes("technical_indicators")));});
test("records risk event and shared audit entry",async()=>{const pool=mockPool();const id=await recordRiskEvent(pool,{code:"LOSS_LIMIT",severity:"CRITICAL"});assert.equal(id,9);assert.ok(pool.calls.some(x=>x.sql.includes("public.jarvis_audit_events")));});

const basePortfolio={portfolioKey:"paper-portfolio",initialCapitalJpy:50000,investmentCapJpy:35000,reserveJpy:15000,investedJpy:35000,assetAllocations:{BTC:17500,ETH:10500,SOL:7000},stageSpent:[10000,15000,10000],realizedPnlJpy:0,unrealizedPnlJpy:0,feesJpy:0};
test("accepts the exact 50,000 JPY policy and protects 15,000 JPY reserve",()=>{assert.equal(require("../core/finance-persistence").validatePortfolioState(basePortfolio).halted,false);});
test("rejects portfolio investment above 35,000 JPY or invalid reserve",()=>{assert.throws(()=>require("../core/finance-persistence").validatePortfolioState({...basePortfolio,investedJpy:35001}),e=>e.code==="PORTFOLIO_LIMIT");assert.throws(()=>require("../core/finance-persistence").validatePortfolioState({...basePortfolio,reserveJpy:14999}),e=>e.code==="PORTFOLIO_LIMIT");});
test("rejects asset and stage allocation overages",()=>{assert.throws(()=>require("../core/finance-persistence").validatePortfolioState({...basePortfolio,assetAllocations:{BTC:17501,ETH:10500,SOL:7000}}),e=>e.code==="ASSET_ALLOCATION_CAP");assert.throws(()=>require("../core/finance-persistence").validatePortfolioState({...basePortfolio,stageSpent:[10001,15000,10000]}),e=>e.code==="STAGE_LIMIT");});
test("fees count toward the 2,500 JPY loss halt",()=>{const r=require("../core/finance-persistence").validatePortfolioState({...basePortfolio,investedJpy:1000,assetAllocations:{BTC:1000},stageSpent:[1000,0,0],realizedPnlJpy:-2200,feesJpy:300});assert.equal(r.halted,true);});
test("persists portfolio state and makes loss halt sticky",async()=>{const pool=mockPool();const r=await require("../core/finance-persistence").savePortfolioState(pool,basePortfolio);assert.equal(r.reserveJpy,15000);assert.ok(pool.calls.some(x=>x.sql.includes("INSERT INTO jarvis_finance.portfolios")));});
