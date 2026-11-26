"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  barsAvailableAtDecision,
  assertNoFutureBars,
  assertNoDuplicateOrMissingBars,
  assertBacktestTimeline
} = require("./backtest-data-gate");

const decision = "2026-11-21T00:02:00.000Z";
function bar(overrides = {}) {
  return {
    sourceId: "source-1",
    venue: "TEST",
    symbol: "BTCJPY",
    interval: "1m",
    adjustmentState: "raw",
    openTimeUtc: "2026-11-21T00:00:00.000Z",
    closeTimeUtc: "2026-11-21T00:00:59.999Z",
    receivedAtUtc: "2026-11-21T00:01:00.000Z",
    verificationStatus: "passed",
    revisionNo: 0,
    selectedRevisionNo: 0,
    ...overrides
  };
}
function timeline(bars, overrides = {}) {
  return assertBacktestTimeline({
    bars,
    signalTime: decision,
    orderAvailableTime: decision,
    fillTime: decision,
    ...overrides
  });
}

test("accepts close and receive timestamps exactly at the decision boundary", () => {
  const bars = [bar({
    closeTimeUtc: decision,
    receivedAtUtc: decision
  })];
  assert.equal(assertNoFutureBars(bars, decision), true);
  assert.equal(timeline(bars).valid, true);
});

test("rejects a candle that closes after the signal time", () => {
  assert.throws(() => assertNoFutureBars([bar({ closeTimeUtc: "2026-11-21T00:02:00.001Z" })], decision), /Future/);
});

test("rejects delayed-arrival data even when the candle closed before the signal", () => {
  assert.throws(() => assertNoFutureBars([bar({ receivedAtUtc: "2026-11-21T00:02:00.001Z" })], decision), /arrived after/);
});

test("rejects unverified, missing-status and quarantined bars", () => {
  for (const status of ["unverified", "quarantined", undefined, "pending"]) {
    assert.throws(() => assertNoFutureBars([bar({ verificationStatus: status })], decision), /Unverified or quarantined/);
  }
});

test("barsAvailableAtDecision excludes unavailable and unverified bars", () => {
  const bars = [
    bar(),
    bar({ openTimeUtc: "2026-11-21T00:01:00.000Z", closeTimeUtc: "2026-11-21T00:01:59.999Z", receivedAtUtc: "2026-11-21T00:02:01.000Z" }),
    bar({ openTimeUtc: "2026-11-21T00:02:00.000Z", closeTimeUtc: "2026-11-21T00:02:59.999Z" }),
    bar({ verificationStatus: "quarantined" })
  ];
  assert.equal(barsAvailableAtDecision(bars, decision).length, 1);
  assert.throws(() => timeline(bars), /arrived after|Future|Unverified/);
});

test("rejects duplicate candles for the same market series and open time", () => {
  assert.throws(() => assertNoDuplicateOrMissingBars([bar(), bar()]), /Duplicate candle/);
});

test("rejects missing candle intervals", () => {
  const first = bar();
  const third = bar({
    openTimeUtc: "2026-11-21T00:02:00.000Z",
    closeTimeUtc: "2026-11-21T00:02:59.999Z",
    receivedAtUtc: "2026-11-21T00:03:00.000Z"
  });
  assert.throws(() => assertNoDuplicateOrMissingBars([first, third]), /Missing candle/);
});

test("rejects overlapping intervals", () => {
  const first = bar();
  const overlapping = bar({
    openTimeUtc: "2026-11-21T00:00:30.000Z",
    closeTimeUtc: "2026-11-21T00:01:29.999Z"
  });
  assert.throws(() => assertNoDuplicateOrMissingBars([first, overlapping]), /Overlapping/);
});

test("requires corrected candle history and the explicitly selected revision", () => {
  const corrected = bar({
    revisionNo: 2,
    selectedRevisionNo: 2,
    revisionHistory: [{ revisionNo: 1 }, { revisionNo: 2 }]
  });
  assert.equal(assertNoFutureBars([corrected], decision), true);
  assert.throws(() => assertNoFutureBars([bar({ revisionNo: 2, selectedRevisionNo: 2 })], decision), /history is incomplete/);
  assert.throws(() => assertNoFutureBars([bar({
    revisionNo: 2,
    selectedRevisionNo: 1,
    revisionHistory: [{ revisionNo: 1 }, { revisionNo: 2 }]
  })], decision), /revision is missing or inconsistent/);
});

test("enforces signal, order availability and fill chronology with inclusive equality", () => {
  assert.equal(timeline([bar()]).valid, true);
  assert.throws(() => timeline([bar()], { orderAvailableTime: "2026-11-21T00:01:59.999Z" }), /precedes signal/);
  assert.throws(() => timeline([bar()], {
    orderAvailableTime: "2026-11-21T00:02:00.001Z",
    fillTime: "2026-11-21T00:02:00.000Z"
  }), /precedes order/);
});

test("stops the entire backtest when any one bar is unsafe", () => {
  const safe = bar();
  const unsafe = bar({
    openTimeUtc: "2026-11-21T00:01:00.000Z",
    closeTimeUtc: "2026-11-21T00:01:59.999Z",
    receivedAtUtc: "2026-11-21T00:01:30.000Z",
    verificationStatus: "quarantined"
  });
  assert.throws(() => timeline([safe, unsafe]), /Unverified or quarantined/);
});

test("checks gaps independently for each market series", () => {
  const btc = bar();
  const eth = bar({ symbol: "ETHJPY", openTimeUtc: "2026-11-21T00:02:00.000Z" });
  assert.equal(assertNoDuplicateOrMissingBars([btc, eth]), true);
});
