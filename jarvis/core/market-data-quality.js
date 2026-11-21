"use strict";
const { INTERVAL_MS } = require("./market-data-normalizer");

function auditBars(bars, { gapCheck = true, priceJumpPct = 25, volumeSpikeMultiple = 20 } = {}) {
  if (!Array.isArray(bars)) throw new Error("bars must be an array");
  const findings = [];
  const seen = new Map();
  const sorted = [...bars].sort((a,b)=>Date.parse(a.openTimeUtc)-Date.parse(b.openTimeUtc));
  for (const bar of sorted) {
    const key = [bar.sourceId,bar.venue,bar.symbol,bar.interval,bar.openTimeUtc,bar.adjustmentState].join("|");
    if (seen.has(key)) findings.push({code:"DUPLICATE_BAR",severity:"high",barTime:bar.openTimeUtc,details:{firstHash:seen.get(key),duplicateHash:bar.normalizedHash}});
    else seen.set(key,bar.normalizedHash);
    if (!INTERVAL_MS[bar.interval]) findings.push({code:"UNSUPPORTED_INTERVAL",severity:"critical",barTime:bar.openTimeUtc});
  }
  if (gapCheck) {
    for (let i=1;i<sorted.length;i++) {
      const a=sorted[i-1],b=sorted[i];
      if (a.sourceId!==b.sourceId||a.symbol!==b.symbol||a.venue!==b.venue||a.interval!==b.interval||a.adjustmentState!==b.adjustmentState) continue;
      const step=INTERVAL_MS[a.interval],delta=Date.parse(b.openTimeUtc)-Date.parse(a.openTimeUtc);
      if (step&&delta>step) findings.push({code:"MISSING_BARS",severity:"high",barTime:a.openTimeUtc,details:{expectedNext:new Date(Date.parse(a.openTimeUtc)+step).toISOString(),actualNext:b.openTimeUtc,missingIntervals:Math.max(0,Math.floor(delta/step)-1)}});
    }
  }
  for (let i=1;i<sorted.length;i++) {
    const a=sorted[i-1],b=sorted[i];
    if (a.sourceId!==b.sourceId||a.symbol!==b.symbol||a.venue!==b.venue||a.interval!==b.interval||a.adjustmentState!==b.adjustmentState) continue;
    const previous=Number(a.close),next=Number(b.open);
    if (previous>0&&Math.abs(next-previous)/previous*100>priceJumpPct) findings.push({code:"PRICE_JUMP",severity:"high",barTime:b.openTimeUtc,details:{changePct:(next-previous)/previous*100,thresholdPct:priceJumpPct}});
    if (Number(a.volume)>0&&Number(b.volume)/Number(a.volume)>volumeSpikeMultiple) findings.push({code:"VOLUME_SPIKE",severity:"high",barTime:b.openTimeUtc,details:{multiple:Number(b.volume)/Number(a.volume),threshold:volumeSpikeMultiple}});
  }
  return findings;
}

function qualityGate(findings) {
  if (!Array.isArray(findings)) throw new Error("Quality findings must be an array");
  const blockers=findings.filter(f=>!f||["critical","high"].includes(f.severity));
  return {accepted:blockers.length===0,blockerCount:blockers.length,findings};
}
module.exports={auditBars,qualityGate};
