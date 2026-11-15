"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPaperTradingEngine,DEFAULT_POLICY,TARGETS_ARE_HYPOTHESES,normalizeSnapshot}=require("./paper-trading");

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
 engine.closePaperTrade({id:"trade-1",exitPrice:1010});
 const a=engine.analyze();
 assert.equal(a.byStrategy["breakout-v1"].trades,1);
 assert.equal(a.targetAssessment.status,"RESEARCH_ONLY_NOT_A_PROMISE");
 assert.ok(a.limitations.length>=4);
});
