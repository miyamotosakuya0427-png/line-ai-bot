"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {barsAvailableAtDecision,assertNoFutureBars,assertBacktestTimeline}=require("./backtest-data-gate");

test("excludes bars that had not closed at decision time",()=>{
 const bars=[{closeTimeUtc:"2026-11-21T00:00:59.999Z"},{closeTimeUtc:"2026-11-21T00:01:59.999Z"}];
 assert.equal(barsAvailableAtDecision(bars,"2026-11-21T00:01:00Z").length,1);
 assert.throws(()=>assertNoFutureBars(bars,"2026-11-21T00:01:00Z"),/Future/);
});
test("enforces candle close, signal, order availability and fill chronology",()=>{
 const bars=[{closeTimeUtc:"2026-11-21T00:00:59.999Z"}];
 const timeline=assertBacktestTimeline({bars,signalTime:"2026-11-21T00:01:00Z",orderAvailableTime:"2026-11-21T00:01:00.001Z",fillTime:"2026-11-21T00:01:00.010Z"});
 assert.equal(timeline.valid,true);
 assert.throws(()=>assertBacktestTimeline({bars:[...bars,{closeTimeUtc:"2026-11-21T00:02:00Z"}],signalTime:"2026-11-21T00:01:00Z",orderAvailableTime:"2026-11-21T00:01:01Z",fillTime:"2026-11-21T00:01:02Z"}),/Future/);
 assert.throws(()=>assertBacktestTimeline({bars,signalTime:"2026-11-21T00:01:00Z",orderAvailableTime:"2026-11-21T00:00:59Z",fillTime:"2026-11-21T00:01:01Z"}),/precedes signal/);
 assert.throws(()=>assertBacktestTimeline({bars,signalTime:"2026-11-21T00:01:00Z",orderAvailableTime:"2026-11-21T00:01:01Z",fillTime:"2026-11-21T00:01:00Z"}),/precedes order/);
});
