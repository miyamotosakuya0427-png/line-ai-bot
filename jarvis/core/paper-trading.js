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
function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if (year<1||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day) return false;
  if (match[8]) {
    const hours=Number(match[9]),minutes=Number(match[10]);
    if (hours>14||minutes>59||(hours===14&&minutes!==0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}
function validDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z")); }
function roundYen(value) { return Math.round(value); }
function pct(value, base) { return base > 0 ? value / base * 100 : 0; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid market snapshot");
  const {source, symbol, capturedAt, price, currency="JPY"} = input;
  if (typeof source !== "string" || !/^[a-z0-9.-]{2,80}$/i.test(source)) throw new Error("Invalid market data source");
  if (typeof symbol !== "string" || !/^[A-Z0-9._:-]{1,32}$/.test(symbol)) throw new Error("Invalid symbol");
  if (!validTimestamp(capturedAt)) throw new Error("Invalid capture timestamp");
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
  let drawdownHalted=false;
  let dailyHaltedDay=null;

  function currentDay() { return clock().slice(0,10); }
  function dayTrades(day=currentDay()) { return trades.filter(t=>t.status==="closed"&&typeof t.closedAt==="string"&&t.closedAt.slice(0,10)===day); }
  function dailyPnl(day=currentDay()) { return dayTrades(day).filter(t=>Number.isFinite(t.netPnlYen)).reduce((sum,t)=>sum+t.netPnlYen,0); }
  function openTrades() { return trades.filter(t=>t.status==="open"); }
  function riskState() {
    const day=currentDay();
    const dailyLossPct=Math.max(0,pct(-Math.min(0,dailyPnl(day)),limits.startingCapitalYen));
    const drawdownPct=Math.max(0,pct(peakEquity-equity,peakEquity));
    if (dailyLossPct>=limits.maxDailyLossPct) dailyHaltedDay=day;
    if (drawdownPct>=limits.maxPeakDrawdownPct) drawdownHalted=true;
    const dailyHalted=dailyHaltedDay===day;
    const openPositions=openTrades().length;
    const unknownDailyCosts=dayTrades(day).some(t=>t.netPnlYen===null);
    const halted=drawdownHalted||dailyHalted||unknownDailyCosts;
    const haltReason=drawdownHalted?"PEAK_DRAWDOWN_LIMIT":dailyHalted?"DAILY_LOSS_LIMIT":unknownDailyCosts?"EXECUTION_COST_UNKNOWN":null;
    return {halted,haltReason,dailyHalted,drawdownHalted,unknownDailyCosts,dailyLossPct,drawdownPct,openPositions,openPositionLimitReached:openPositions>=limits.maxOpenPositions,limits:clone(limits)};
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
      const state=riskState();
      if (state.halted) throw new Error("Paper trading halted: "+state.haltReason);
      if (state.openPositions>=limits.maxOpenPositions) throw new Error("Open-position limit reached");
      if (trades.length>=MAX_TRADES) throw new Error("Trade capacity reached");
      const {id=crypto.randomUUID(),symbol,side,quantity,entryPrice,stopPrice,openedAt=clock(),strategyId,signalId="",sourceSnapshotId="",reason=""}=input||{};
      if (typeof id!=="string"||id.length<1||id.length>100||seenIds.has(id)) throw new Error("Invalid or duplicate trade id");
      if (typeof symbol!=="string"||!/^[A-Z0-9._:-]{1,32}$/.test(symbol)) throw new Error("Invalid symbol");
      if (!["long","short"].includes(side)) throw new Error("Invalid side");
      if (!finitePositive(quantity)||!finitePositive(entryPrice)) throw new Error("Quantity and entry price must be positive");
      if (limits.requireStopPrice && !finitePositive(stopPrice)) throw new Error("A stop price is required");
      if (stopPrice && ((side==="long"&&stopPrice>=entryPrice)||(side==="short"&&stopPrice<=entryPrice))) throw new Error("Stop price is on the wrong side of entry");
      if (typeof strategyId!=="string"||strategyId.length<1||strategyId.length>80) throw new Error("A strategy id is required");
      if (!validTimestamp(openedAt)) throw new Error("Invalid open timestamp");
      const notional=quantity*entryPrice;
      if (!Number.isFinite(notional)||notional>equity*100) throw new Error("Position notional exceeds simulation safety bound");
      const stopRisk=stopPrice?Math.abs(entryPrice-stopPrice)*quantity:0;
      if (pct(stopRisk,equity)>limits.maxRiskPerTradePct) throw new Error("Trade risk exceeds maxRiskPerTradePct");
      const trade={id,symbol,side,quantity,entryPrice,stopPrice:stopPrice||null,openedAt,strategyId,signalId,sourceSnapshotId,reason:String(reason).slice(0,500),status:"open",closedAt:null,exitPrice:null,feesYen:null,slippageYen:null,grossPnlYen:null,netPnlYen:null,costStatus:"unknown",costBreakdown:null,lessonIds:[]};
      trades.push(trade);seenIds.add(id);
      return clone(trade);
    },
    closePaperTrade({id,exitPrice,closedAt=clock(),feesYen,slippageYen,executionCosts,exitReason=""}={}) {
      const trade=trades.find(t=>t.id===id);
      if (!trade||trade.status!=="open") throw new Error("Open paper trade not found");
      if (!finitePositive(exitPrice)) throw new Error("Invalid exit price");
      if (!validTimestamp(closedAt)) throw new Error("Invalid close timestamp");
      const explicitCosts=Number.isFinite(feesYen)&&feesYen>=0&&Number.isFinite(slippageYen)&&slippageYen>=0;
      const modelCosts=executionCosts&&typeof executionCosts==="object"&&executionCosts.costs&&typeof executionCosts.costs==="object"?executionCosts:null;
      const modelComplete=Boolean(modelCosts&&modelCosts.complete===true&&["feeYen","spreadYen","slippageYen","impactYen"].every(k=>Number.isFinite(modelCosts.costs[k])&&modelCosts.costs[k]>=0));
      if (executionCosts!=null&&!modelCosts) throw new Error("Invalid execution cost model result");
      const feeValue=explicitCosts?feesYen:(modelComplete?modelCosts.costs.feeYen:null);
      const slippageValue=explicitCosts?slippageYen:(modelComplete?modelCosts.costs.spreadYen+modelCosts.costs.slippageYen+modelCosts.costs.impactYen:null);
      const costStatus=explicitCosts||modelComplete?"complete":modelCosts?"partial":"unknown";
      const direction=trade.side==="long"?1:-1;
      const gross=roundYen((exitPrice-trade.entryPrice)*trade.quantity*direction);
      const net=costStatus==="complete"?gross-roundYen(feeValue)-roundYen(slippageValue):null;
      const costBreakdown=explicitCosts?{source:"explicit-total-round-trip-costs",feesYen:feeValue,slippageYen:slippageValue}:modelCosts?clone(modelCosts):null;
      Object.assign(trade,{status:"closed",closedAt,exitPrice,feesYen:feeValue===null?null:roundYen(feeValue),slippageYen:slippageValue===null?null:roundYen(slippageValue),grossPnlYen:gross,netPnlYen:net,costStatus,costBreakdown,exitReason:String(exitReason).slice(0,300)});
      if(net!==null){equity+=net;peakEquity=Math.max(peakEquity,equity);}
      const state=riskState();
      return {trade:clone(trade),equityYen:equity,peakEquityYen:peakEquity,risk:state};
    },
    recordLesson({id=crypto.randomUUID(),tradeId,category,rootCause,preventiveRule,evidence="",createdAt=clock()}={}) {
      if (typeof id!=="string"||id.length>100||mistakes.some(m=>m.id===id)) throw new Error("Invalid or duplicate lesson id");
      const trade=trades.find(t=>t.id===tradeId&&t.status==="closed");
      if (!trade) throw new Error("Lesson must reference a closed paper trade");
      if (!["process","data","risk","execution","strategy","discipline"].includes(category)) throw new Error("Invalid lesson category");
      for (const [key,value] of Object.entries({rootCause,preventiveRule})) if (typeof value!=="string"||value.trim().length<8||value.length>1000) throw new Error("Lesson "+key+" must be 8-1000 characters");
      if(!validTimestamp(createdAt))throw new Error("Invalid lesson timestamp");
      const lesson={id,tradeId,category,rootCause:rootCause.trim(),preventiveRule:preventiveRule.trim(),evidence:String(evidence).slice(0,1000),createdAt,repeatCount:0};
      const signature=lesson.category+"|"+lesson.preventiveRule.toLowerCase();
      for (const prior of mistakes) if ((prior.category+"|"+prior.preventiveRule.toLowerCase())===signature) lesson.repeatCount++;
      mistakes.push(lesson);trade.lessonIds.push(id);
      return clone(lesson);
    },
    analyze() {
      const closed=trades.filter(t=>t.status==="closed");
      const pricedClosed=closed.filter(t=>Number.isFinite(t.netPnlYen));
      const wins=pricedClosed.filter(t=>t.netPnlYen>0),losses=pricedClosed.filter(t=>t.netPnlYen<0);
      const grossProfit=wins.reduce((s,t)=>s+t.netPnlYen,0);
      const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netPnlYen,0));
      const byStrategy={};
      for (const t of pricedClosed) {
        const x=byStrategy[t.strategyId]||(byStrategy[t.strategyId]={trades:0,wins:0,netPnlYen:0});
        x.trades++;if(t.netPnlYen>0)x.wins++;x.netPnlYen+=t.netPnlYen;
      }
      const repeated=mistakes.filter(m=>m.repeatCount>0);
      return {
        sampleSize:pricedClosed.length,closedTradeCount:closed.length,unpricedTradeCount:closed.length-pricedClosed.length,openCount:openTrades().length,startingCapitalYen:limits.startingCapitalYen,equityYen:equity,netPnlYen:equity-limits.startingCapitalYen,returnPct:pct(equity-limits.startingCapitalYen,limits.startingCapitalYen),
        winRatePct:closed.length?pct(wins.length,closed.length):0,profitFactor:grossLoss?grossProfit/grossLoss:null,averageWinYen:wins.length?grossProfit/wins.length:0,averageLossYen:losses.length?grossLoss/losses.length:0,
        byStrategy,lessons:clone(mistakes),repeatedLessonCount:repeated.length,risk:this.riskState(),
        targetAssessment:{monthlyProfitTargetPct:TARGETS_ARE_HYPOTHESES.monthlyProfitTargetPct,dailyReturnTargetPct:TARGETS_ARE_HYPOTHESES.dailyReturnTargetPct,proposedStopLossPct:TARGETS_ARE_HYPOTHESES.proposedStopLossPct,achievedReturnPct:pct(equity-limits.startingCapitalYen,limits.startingCapitalYen),status:"RESEARCH_ONLY_NOT_A_PROMISE"},
        limitations:["Paper fills are simulated and may not match executable market prices","No broker, exchange, live order, leverage, or real-money integration exists","Historical and simulated performance do not establish future returns","A repeated lesson is flagged for review; the engine does not autonomously rewrite strategy rules"]
      };
    },
    riskState,
    listTrades({status,limit=100}={}) {
      if (status&& !["open","closed"].includes(status)) throw new Error("Invalid trade status");
      if (!Number.isInteger(limit)||limit<1||limit>1000) throw new Error("Invalid trade limit");
      return clone(trades.filter(t=>!status||t.status===status).slice(-limit));
    },
    exportJournal() { return {version:1,policy:clone(limits),snapshots:clone(snapshots),trades:clone(trades),lessons:clone(mistakes),exportedAt:clock()}; }
  };
}

module.exports={DEFAULT_POLICY,TARGETS_ARE_HYPOTHESES,validTimestamp,createPaperTradingEngine,normalizeSnapshot};
