"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {barsAvailableAtDecision,assertNoFutureBars}=require("./backtest-data-gate");
test("excludes bars that had not closed at decision time",()=>{const bars=[{closeTimeUtc:"2026-11-21T00:00:59.999Z"},{closeTimeUtc:"2026-11-21T00:01:59.999Z"}];assert.equal(barsAvailableAtDecision(bars,"2026-11-21T00:01:00Z").length,1);assert.throws(()=>assertNoFutureBars(bars,"2026-11-21T00:01:00Z"),/Future/);});