"use strict";

function parseTime(value, label) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error("Invalid " + label + " timestamp");
  return timestamp;
}

function barsAvailableAtDecision(bars, decisionTime) {
  const cutoff = parseTime(decisionTime, "decision");
  if (!Array.isArray(bars)) throw new Error("bars must be an array");
  return bars.filter(bar => parseTime(bar.closeTimeUtc, "bar close") <= cutoff);
}

function assertNoFutureBars(bars, decisionTime) {
  const allowed = barsAvailableAtDecision(bars, decisionTime);
  if (allowed.length !== bars.length) throw new Error("Future or not-yet-closed market data detected");
  return true;
}

function assertBacktestTimeline({ bars, signalTime, orderAvailableTime, fillTime }) {
  const signal = parseTime(signalTime, "signal");
  const order = parseTime(orderAvailableTime, "order availability");
  const fill = parseTime(fillTime, "fill");
  assertNoFutureBars(bars, signalTime);
  if (order < signal) throw new Error("Order availability precedes signal generation");
  if (fill < order) throw new Error("Fill time precedes order availability");
  return Object.freeze({ valid: true, signalTime: new Date(signal).toISOString(), orderAvailableTime: new Date(order).toISOString(), fillTime: new Date(fill).toISOString(), barCount: bars.length });
}

module.exports = { barsAvailableAtDecision, assertNoFutureBars, assertBacktestTimeline };
