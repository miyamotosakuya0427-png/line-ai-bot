"use strict";

const crypto = require("node:crypto");

const MAX_TRADES = 100000;
const MAX_SNAPSHOTS = 250000;
const DEFAULT_POLICY = Object.freeze({
  startingCapitalYen: 1000000,
  maxRiskPerTradePct: 0.5,
  maxDailyLossPct: 2,
  maxPeakDrawdownPct: 8,
  maxOpenPositions: 5,
  requireStopPrice: true
});
const TARGETS_ARE_HYPOTHESES = Object.freeze({
  monthlyProfitTargetPct: 50,
  dailyReturnTargetPct: 20,
  proposedStopLossPct: 20
});

function finitePositive(value) { return Number.isFinite(value) && value > 0; }
function validDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z")); }
function roundYen(value) { return Math.round(value); }
function pct(value, base) { return base > 0 ? value / base * 100 : 0; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid market snapshot");
  const {source, symbol, capturedAt, price, currency="JPY"} = input;
  if (typeof source !== "string" || !/^[a-z0-9.-]{2,80}$/i.test(source)) throw new Error("Invalid market data source");
  if (typeof symbol !== "string" || !/^[A-Z0-9._:-]{1,32}$/.test(symbol)) throw new Error("Invalid symbol");
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) throw new Error("Invalid capture timestamp");
  if (!finitePositive(price)) throw new Error("Price must be positive");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency");
  return {id:crypto.randomUUID(),source,symbol,capturedAt,price,currency,verified:false,verificationNote:"Source not independently verified"};
}

function createPaperTradingEngine({policy={}, clock=()=>new Date().toISOString()}={}) {
  const limits={...DEFAULT_POLICY,...policy};
  if (!Number.isSafeInteger(limits.startingCapitalYen) || limits.startingCapitalYen<1) throw new Error("Invalid starting capital");
  for (const key of ["maxRiskPerTradePct","maxDailyLossPct","maxPeakDrawdownPct"]) {
    if (!finitePositive(limits[key]) || limits[key]>=100) throw new Error("Invalid risk limit: "+key);
  }
  if (!Number.isInteger(limits.maxOpenPositions) || limits.maxOpenPositions<1 || limits.maxOpenPositions>100) throw new Error("Invalid open-position limit");

  const snapshots=[];
  const trades=[];
  const mistakes=[];
  const seenIds=new Set();
  let equity=limits.startingCapitalYen;
  let peakEquity=equity;
  let halted=false;
  let haltReason=null;

  function currentDay() { return clock().slice(0,10); }
  function dayTrades(day=currentDay()) { return trades.filter(t=>t.closedAt.slice(0,10)===day); }
  function dailyPnl(day=currentDay()) { return dayTrades(day).reduce((sum,t)=>sum+t.netPnlYen,0); }
  function openTrades() { return trades.filter(t=>t.status==="open"); }
  function riskState() {
    const day=currentDay();
    const dailyLossPct=Math.max(0,pct(-Math.min(0,dailyPnl(day)),limits.startingCapitalYen));
    const drawdownPct=Math.max(0,pct(peakEquity-equity,peakEquity));
    const reasons=[];
    if (dailyLossPct>=limits.maxDailyLossPct) reasons.push("DAILY_LOSS_LIMIT");
    if (drawdownPct>=limits.maxPeakDrawdownPct) reasons.push("PEAK_DRAWDOWN_LIMIT");
    if (openTrades().length>=limits.maxOpenPositions) reasons.push("OPEN_POSITION_LIMIT");
    if (reasons.length && !halted) { halted=true; haltReason=reasons[0]; }
    return {halted,haltReason,dailyLossPct,drawdownPct,openPositions:openTrades().length,limits:clone(limits)};
  }

  return {
    policy() { return {...clone(limits),targetsForResearchOnly:clone(TARGETS_ARE_HYPOTHESES)}; },
    recordSnapshot(input) {
      if (snapshots.length>=MAX_SNAPSHOTS) throw new Error("Snapshot capacity reached");
      const item=normalizeSnapshot(input);
      snapshots.push(item);
      return clone(item);
    },
    listSnapshots({symbol,limit=100}={}) {
      if (!Number.isInteger(limit)||limit<1||limit>1000) throw new Error("Invalid snapshot limit");
      return clone(snapshots.filter(s=>!symbol||s.symbol===symbol).slice(-limit));
    },
    openPaperTrade(input) {
      if (halted) throw new Error("Paper trading halted: "+haltReason);
      if (openTrades().length>=limits.maxOpenPositions) throw new Error("Open-position limit reached");
      if (trades.length>=MAX_TRADES) throw new Error("Trade capacity reached");
      const {id=crypto.randomUUID(),symbol,side,quantity,entryPrice,stopPrice,openedAt=clock(),strategyId,signalId="",sourceSnapshotId="",reason=""}=input||{};
      if (typeof id!=="string"||id.length<1||id.length>100||seenIds.has(id)) throw new Error("Invalid or duplicate trade id");
      if (typeof symbol!=="string"||!/^[A-Z0-9._:-]{1,32}$/.test(symbol)) throw new Error("Invalid symbol");
      if (!["long","short"].includes(side)) throw new Error("Invalid side");
      if (!finitePositive(quantity)||!finitePositive(entryPrice)) throw new Error("Quantity and entry price must be positive");
      if (limits.requireStopPrice && !finitePositive(stopPrice)) throw new Error("A stop price is required");
      if (stopPrice && ((side==="long"&&stopPrice>=entryPrice)||(side==="short"&&stopPrice<=entryPrice))) throw new Error("Stop price is on the wrong side of entry");
      if (typeof strategyId!=="string"||strategyId.length<1||strategyId.length>80) throw new Error("A strategy id is required");
      if (typeof openedAt!=="string"||Number.isNaN(Date.parse(openedAt))) throw new Error("Invalid open timestamp");
      const notional=quantity*entryPrice;
      if (!Number.isFinite(notional)||notional>equity*100) throw new Error("Position notional exceeds simulation safety bound");
      const stopRisk=stopPrice?Math.abs(entryPrice-stopPrice)*quantity:0;
      if (pct(stopRisk,equity)>limits.maxRiskPerTradePct) throw new Error("Trade risk exceeds maxRiskPerTradePct");
      const trade={id,symbol,side,quantity,entryPrice,stopPrice:stopPrice||null,openedAt,strategyId,signalId,sourceSnapshotId,reason:String(reason).slice(0,500),status:"open",closedAt:null,exitPrice:null,feesYen:0,slippageYen:0,grossPnlYen:0,netPnlYen:0,lessonIds:[]};
      trades.push(trade);seenIds.add(id);
      return clone(trade);
    },
    closePaperTrade({id,exitPrice,closedAt=clock(),feesYen=0,slippageYen=0,exitReason=""}={}) {
      const trade=trades.find(t=>t.id===id);
      if (!trade||trade.status!=="open") throw new Error("Open paper trade not found");
      if (!finitePositive(exitPrice)||!Number.isFinite(feesYen)||feesYen<0||!Number.isFinite(slippageYen)||slippageYen<0) throw new Error("Invalid exit price or costs");
      if (typeof closedAt!=="string"||Number.isNaN(Date.parse(closedAt))) throw new Error("Invalid close timestamp");
      const direction=trade.side==="long"?1:-1;
      const gross=roundYen((exitPrice-trade.entryPrice)*trade.quantity*direction);
      const net=gross-roundYen(feesYen)-roundYen(slippageYen);
      Object.assign(trade,{status:"closed",closedAt,exitPrice,feesYen:roundYen(feesYen),slippageYen:roundYen(slippageYen),grossPnlYen:gross,netPnlYen:net,exitReason:String(exitReason).slice(0,300)});
      equity+=net;
      peakEquity=Math.max(peakEquity,equity);
      const state=riskState();
      return {trade:clone(trade),equityYen:equity,peakEquityYen:peakEquity,risk:state};
    },
    recordLesson({id=crypto.randomUUID(),tradeId,category,rootCause,preventiveRule,evidence=""}={}) {
      if (typeof id!=="string"||id.length>100||mistakes.some(m=>m.id===id)) throw new Error("Invalid or duplicate lesson id");
      const trade=trades.find(t=>t.id===tradeId&&t.status==="closed");
      if (!trade) throw new Error("Lesson must reference a closed paper trade");
      if (!["process","data","risk","execution","strategy","discipline"].includes(category)) throw new Error("Invalid lesson category");
      for (const [key,value] of Object.entries({rootCause,preventiveRule})) if (typeof value!=="string"||value.trim().length<8||value.length>1000) throw new Error("Lesson "+key+" must be 8-1000 characters");
      const lesson={id,tradeId,category,rootCause:rootCause.trim(),preventiveRule:preventiveRule.trim(),evidence:String(evidence).slice(0,1000),createdAt:clock(),repeatCount:0};
      const signature=lesson.category+"|"+lesson.preventiveRule.toLowerCase();
      for (const prior of mistakes) if ((prior.category+"|"+prior.preventiveRule.toLowerCase())===signature) lesson.repeatCount++;
      mistakes.push(lesson);trade.lessonIds.push(id);
      return clone(lesson);
    },
    analyze() {
      const closed=trades.filter(t=>t.status==="closed");
      const wins=closed.filter(t=>t.netPnlYen>0),losses=closed.filter(t=>t.netPnlYen<0);
      const grossProfit=wins.reduce((s,t)=>s+t.netPnlYen,0);
      const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netPnlYen,0));
      const byStrategy={};
      for (const t of closed) {
        const x=byStrategy[t.strategyId]||(byStrategy[t.strategyId]={trades:0,wins:0,netPnlYen:0});
        x.trades++;if(t.netPnlYen>0)x.wins++;x.netPnlYen+=t.netPnlYen;
      }
      const repeated=mistakes.filter(m=>m.repeatCount>0);
      return {
        sampleSize:closed.length,openCount:openTrades().length,startingCapitalYen:limits.startingCapitalYen,equityYen:equity,netPnlYen:equity-limits.startingCapitalYen,returnPct:pct(equity-limits.startingCapitalYen,limits.startingCapitalYen),
        winRatePct:closed.length?pct(wins.length,closed.length):0,profitFactor:grossLoss?grossProfit/grossLoss:null,averageWinYen:wins.length?grossProfit/wins.length:0,averageLossYen:losses.length?grossLoss/losses.length:0,
        byStrategy,lessons:clone(mistakes),repeatedLessonCount:repeated.length,risk:this.riskState(),
        targetAssessment:{monthlyProfitTargetPct:TARGETS_ARE_HYPOTHESES.monthlyProfitTargetPct,dailyReturnTargetPct:TARGETS_ARE_HYPOTHESES.dailyReturnTargetPct,proposedStopLossPct:TARGETS_ARE_HYPOTHESES.proposedStopLossPct,achievedReturnPct:pct(equity-limits.startingCapitalYen,limits.startingCapitalYen),status:"RESEARCH_ONLY_NOT_A_PROMISE"},
        limitations:["Paper fills are simulated and may not match executable market prices","No broker, exchange, live order, leverage, or real-money integration exists","Historical and simulated performance do not establish future returns","A repeated lesson is flagged for review; the engine does not autonomously rewrite strategy rules"]
      };
    },
    riskState,
    listTrades({status,limit=100}={}) {
      if (status&&!["open","closed"].includes(status)) throw new Error("Invalid trade status");
      if (!Number.isInteger(limit)||limit<1||limit>1000) throw new Error("Invalid trade limit");
      return clone(trades.filter(t=>!status||t.status===status).slice(-limit));
    },
    exportJournal() { return {version:1,policy:clone(limits),snapshots:clone(snapshots),trades:clone(trades),lessons:clone(mistakes),exportedAt:clock()}; }
  };
}

module.exports={DEFAULT_POLICY,TARGETS_ARE_HYPOTHESES,createPaperTradingEngine,normalizeSnapshot};
