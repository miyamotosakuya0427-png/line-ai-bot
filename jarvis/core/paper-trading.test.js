"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPaperTradingEngine,DEFAULT_POLICY,TARGETS_ARE_HYPOTHESES,normalizeSnapshot,validTimestamp}=require("./paper-trading");
const {estimateExecutionCost}=require("./execution-cost-model");

function setup(){
 let now="2026-11-16T09:00:00+09:00";
 const engine=createPaperTradingEngine({clock:()=>now});
 return {engine,setTime:v=>{now=v;}};
}
function open(engine,overrides={}) {
 return engine.openPaperTrade({id:"trade-1",symbol:"7203",side:"long",quantity:100,entryPrice:1000,stopPrice:995,strategyId:"breakout-v1",...overrides});
}

test("defaults are conservative paper-only risk controls and targets are research hypotheses",()=>{
 const {engine}=setup();const p=engine.policy();
 assert.equal(p.startingCapitalYen,1000000);assert.equal(p.maxRiskPerTradePct,0.5);
 assert.equal(p.maxDailyLossPct,2);assert.equal(p.maxPeakDrawdownPct,8);
 assert.deepEqual(p.targetsForResearchOnly,TARGETS_ARE_HYPOTHESES);
});
test("records market data with explicit unverified provenance and rejects invalid data",()=>{
 const {engine}=setup();
 const s=engine.recordSnapshot({source:"example.exchange",symbol:"7203",capturedAt:"2026-11-16T09:00:00+09:00",price:1000});
 assert.equal(s.verified,false);assert.match(s.verificationNote,/not independently verified/);
 assert.throws(()=>normalizeSnapshot({source:"bad host!",symbol:"7203",capturedAt:"not a date",price:-1}));
});
test("opens and closes paper positions with fees and slippage included",()=>{
 const {engine}=setup();open(engine);
 const result=engine.closePaperTrade({id:"trade-1",exitPrice:1010,feesYen:20,slippageYen:10});
 assert.equal(result.trade.grossPnlYen,1000);assert.equal(result.trade.netPnlYen,970);
 assert.equal(result.equityYen,1000970);assert.equal(engine.analyze().sampleSize,1);
});
test("rejects duplicate trades, missing stops, invalid direction, and excess risk",()=>{
 const {engine}=setup();open(engine);
 assert.throws(()=>open(engine),/duplicate/);
 assert.throws(()=>engine.openPaperTrade({symbol:"7203",side:"long",quantity:100,entryPrice:1000,strategyId:"s"}),/stop price/);
 assert.throws(()=>engine.openPaperTrade({symbol:"7203",side:"long",quantity:1000,entryPrice:1000,stopPrice:900,strategyId:"s"}),/risk/);
});
test("open-position cap is enforced before accepting another paper trade",()=>{
 const engine=createPaperTradingEngine({policy:{maxOpenPositions:1}});
 open(engine);
 assert.throws(()=>open(engine,{id:"trade-2"}),/Open-position limit/);
});
test("a daily loss threshold halts further paper trades",()=>{
 const {engine}=setup();open(engine);
 engine.closePaperTrade({id:"trade-1",exitPrice:790,feesYen:0,slippageYen:0});
 assert.equal(engine.riskState().halted,true);
 assert.equal(engine.riskState().haltReason,"DAILY_LOSS_LIMIT");
 assert.throws(()=>open(engine,{id:"trade-2"}),/halted/);
});
test("lessons link to closed trades and repeated preventive rules are flagged",()=>{
 const {engine}=setup();open(engine);
 engine.closePaperTrade({id:"trade-1",exitPrice:990});
 const first=engine.recordLesson({tradeId:"trade-1",category:"discipline",rootCause:"Entry was made before signal confirmation",preventiveRule:"Wait for candle close before entry"});
 assert.equal(first.repeatCount,0);
 const second=engine.recordLesson({tradeId:"trade-1",category:"discipline",rootCause:"The same early entry happened again",preventiveRule:"Wait for candle close before entry"});
 assert.equal(second.repeatCount,1);
 assert.equal(engine.analyze().repeatedLessonCount,1);
});
test("analysis reports strategy-level performance without claiming predictive returns",()=>{
 const {engine}=setup();open(engine);
 engine.closePaperTrade({id:"trade-1",exitPrice:1010,feesYen:0,slippageYen:0});
 const a=engine.analyze();
 assert.equal(a.byStrategy["breakout-v1"].trades,1);
 assert.equal(a.targetAssessment.status,"RESEARCH_ONLY_NOT_A_PROMISE");
 assert.ok(a.limitations.length>=4);
});
test("position cap blocks new entries without permanently halting the paper engine",()=>{
 const capped=createPaperTradingEngine({policy:{maxOpenPositions:1}});
 open(capped);
 assert.equal(capped.riskState().halted,false);
 assert.equal(capped.riskState().openPositionLimitReached,true);
 capped.closePaperTrade({id:"trade-1",exitPrice:1000,feesYen:0,slippageYen:0});
 assert.equal(capped.riskState().halted,false);
 assert.equal(capped.riskState().openPositionLimitReached,false);
 open(capped,{id:"trade-2"});
 assert.equal(capped.listTrades({status:"open"}).length,1);
});
test("daily loss halt expires on the next market day while drawdown remains below its hard limit",()=>{
 const {engine,setTime}=setup();
 open(engine);
 engine.closePaperTrade({id:"trade-1",exitPrice:790,feesYen:0,slippageYen:0});
 assert.equal(engine.riskState().halted,true);
 assert.equal(engine.riskState().haltReason,"DAILY_LOSS_LIMIT");
 setTime("2026-11-17T09:00:00+09:00");
 assert.equal(engine.riskState().halted,false);
 open(engine,{id:"trade-2"});
 assert.equal(engine.listTrades({status:"open"}).length,1);
});
test("all trading timestamps must be timezone-qualified and calendar-valid",()=>{
 assert.equal(validTimestamp("2026-02-30T09:00:00Z"),false);
 assert.equal(validTimestamp("2026-11-16T09:00:00"),false);
 assert.equal(validTimestamp("2026-11-16T09:00:00+09:00"),true);
 const {engine}=setup();
 assert.throws(()=>engine.recordSnapshot({source:"example.exchange",symbol:"7203",capturedAt:"2026-02-30T09:00:00Z",price:1000}),/capture timestamp/);
 assert.throws(()=>open(engine,{openedAt:"2026-11-16T09:00:00"}),/open timestamp/);
});

test("unknown execution costs remain null and block new paper entries",()=>{
 const {engine}=setup();open(engine);
 const result=engine.closePaperTrade({id:"trade-1",exitPrice:1010});
 assert.equal(result.trade.costStatus,"unknown");
 assert.equal(result.trade.feesYen,null);
 assert.equal(result.trade.slippageYen,null);
 assert.equal(result.trade.netPnlYen,null);
 assert.equal(result.risk.haltReason,"EXECUTION_COST_UNKNOWN");
 assert.equal(engine.analyze().unpricedTradeCount,1);
 assert.equal(engine.analyze().sampleSize,0);
 assert.throws(()=>open(engine,{id:"trade-2"}),/EXECUTION_COST_UNKNOWN/);
});
test("execution-cost model output is applied to paper PnL without double-counting fill-price difference",()=>{
 const {engine}=setup();open(engine);
 const costs=estimateExecutionCost({side:"sell",quantity:100,referencePrice:1000,executionPrice:1010,makerFeeRate:0.001,takerFeeRate:0.002,liquidityRole:"maker",spreadBps:2,slippageBps:3,impactBps:1});
 const result=engine.closePaperTrade({id:"trade-1",exitPrice:1010,executionCosts:costs});
 assert.equal(result.trade.costStatus,"complete");
 assert.equal(result.trade.feesYen,100);
 assert.equal(result.trade.slippageYen,50);
 assert.equal(result.trade.grossPnlYen,1000);
 assert.equal(result.trade.netPnlYen,850);
 assert.equal(result.trade.costBreakdown.costs.executionDifferenceYen,1000);
});
