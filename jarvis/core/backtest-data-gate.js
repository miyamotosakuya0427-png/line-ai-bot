"use strict";

const { INTERVAL_MS } = require("./market-data-normalizer");

function parseTime(value, label) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error("Invalid " + label + " timestamp");
  return timestamp;
}

function seriesKey(bar) {
  return [
    bar.sourceId || "",
    bar.venue || "",
    bar.symbol || "",
    bar.interval || "",
    bar.adjustmentState || "raw"
  ].join("|");
}

function validateBarAvailability(bar, decisionMs) {
  if (!bar || typeof bar !== "object") throw new Error("Invalid market bar");
  const closeMs = parseTime(bar.closeTimeUtc, "bar close");
  const receivedMs = parseTime(bar.receivedAtUtc, "bar received");
  if (closeMs > decisionMs) throw new Error("Future or not-yet-closed market data detected");
  if (receivedMs > decisionMs) throw new Error("Market data arrived after the decision time");
  if (bar.verificationStatus !== "passed") {
    throw new Error("Unverified or quarantined market data cannot enter a backtest");
  }
  if (!INTERVAL_MS[bar.interval]) throw new Error("Unsupported market interval");
  const revisionNo = bar.revisionNo == null ? 0 : bar.revisionNo;
  const selectedRevisionNo = bar.selectedRevisionNo == null ? revisionNo : bar.selectedRevisionNo;
  if (!Number.isSafeInteger(revisionNo) || revisionNo < 0 ||
      !Number.isSafeInteger(selectedRevisionNo) || selectedRevisionNo !== revisionNo) {
    throw new Error("Selected candle revision is missing or inconsistent");
  }
  if (revisionNo > 0) {
    if (!Array.isArray(bar.revisionHistory) ||
        !bar.revisionHistory.some(item => item && item.revisionNo === revisionNo)) {
      throw new Error("Corrected candle revision history is incomplete");
    }
  }
  return { closeMs, receivedMs, revisionNo };
}

function barsAvailableAtDecision(bars, decisionTime) {
  const cutoff = parseTime(decisionTime, "decision");
  if (!Array.isArray(bars)) throw new Error("bars must be an array");
  return bars.filter(bar => {
    const closeMs = parseTime(bar.closeTimeUtc, "bar close");
    const receivedMs = parseTime(bar.receivedAtUtc, "bar received");
    return closeMs <= cutoff && receivedMs <= cutoff && bar.verificationStatus === "passed";
  });
}

function assertNoFutureBars(bars, decisionTime) {
  const cutoff = parseTime(decisionTime, "decision");
  if (!Array.isArray(bars)) throw new Error("bars must be an array");
  for (const bar of bars) validateBarAvailability(bar, cutoff);
  return true;
}

function assertNoDuplicateOrMissingBars(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const key = seriesKey(bar);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }

  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => parseTime(a.openTimeUtc, "bar open") - parseTime(b.openTimeUtc, "bar open"));
    for (let i = 0; i < sorted.length; i++) {
      const openMs = parseTime(sorted[i].openTimeUtc, "bar open");
      if (i > 0) {
        const previousMs = parseTime(sorted[i - 1].openTimeUtc, "bar open");
        const delta = openMs - previousMs;
        if (delta === 0) throw new Error("Duplicate candle detected for the same market series and open time");
        const step = INTERVAL_MS[sorted[i].interval];
        if (delta > step) throw new Error("Missing candle interval detected in backtest data");
        if (delta < step) throw new Error("Overlapping or out-of-order candle interval detected");
      }
    }
  }
  return true;
}

function assertBacktestTimeline({ bars, signalTime, orderAvailableTime, fillTime }) {
  const signal = parseTime(signalTime, "signal");
  const order = parseTime(orderAvailableTime, "order availability");
  const fill = parseTime(fillTime, "fill");
  assertNoFutureBars(bars, signalTime);
  assertNoDuplicateOrMissingBars(bars);
  if (order < signal) throw new Error("Order availability precedes signal generation");
  if (fill < order) throw new Error("Fill time precedes order availability");
  return Object.freeze({
    valid: true,
    signalTime: new Date(signal).toISOString(),
    orderAvailableTime: new Date(order).toISOString(),
    fillTime: new Date(fill).toISOString(),
    barCount: bars.length
  });
}

module.exports = {
  barsAvailableAtDecision,
  assertNoFutureBars,
  assertNoDuplicateOrMissingBars,
  assertBacktestTimeline
};
