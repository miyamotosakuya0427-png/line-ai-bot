"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mapSnapshotToBars, PUBLIC_PROVIDER, PUBLIC_VENUE } = require("../core/market-data-gateway-adapter");

const now = Date.parse("2026-11-22T12:00:00.000Z");
const source = {
  id: "source-1", sourceKey: "binance-public-jpy", provider: PUBLIC_PROVIDER,
  licenseId: "license-reviewed-v1", licenseEvidenceRef: "test-fixture:approved-license-evidence", licenseApproved: true,
  venues: [PUBLIC_VENUE], currencies: ["JPY"], enabled: true
};
function snapshot(klines = []) {
  return { source: PUBLIC_PROVIDER, sourceHost: "data-api.binance.vision",
    venueCompatibility: "UNVERIFIED_BINANCE_JAPAN_ACCOUNT", symbol: "BTCJPY",
    quoteAsset: "JPY", interval: "1m", klines };
}
function candle(openTime, closeTime, close = 101) {
  return { openTime, closeTime, open: 100, high: 102, low: 99, close, volume: 10 };
}

test("maps only closed public candles and preserves venue/account limitation", () => {
  const result = mapSnapshotToBars(snapshot([
    candle(now - 120000, now - 60001),
    candle(now - 60000, now - 1),
    candle(now, now + 59999)
  ]), { source, now: () => now });
  assert.equal(result.bars.length, 2);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.bars[0].venue, PUBLIC_VENUE);
  assert.equal(result.bars[0].currency, "JPY");
  assert.equal(result.bars[0].sourceTimezone, "UTC_UNIX_MILLISECONDS");
  assert.equal(result.venueCompatibility, "UNVERIFIED_BINANCE_JAPAN_ACCOUNT");
  assert.match(result.bars[0].normalizedHash, /^[a-f0-9]{64}$/);
  assert.match(result.bars[0].rawPayloadHash, /^[a-f0-9]{64}$/);
});

test("fails closed when provider/license/venue/currency is not explicitly configured", () => {
  assert.throws(() => mapSnapshotToBars(snapshot([]), { source: { ...source, enabled: false }, now: () => now }), /not enabled/);
  assert.throws(() => mapSnapshotToBars(snapshot([]), { source: { ...source, licenseEvidenceRef: "" }, now: () => now }), /License approval/);
  assert.throws(() => mapSnapshotToBars(snapshot([]), { source: { ...source, licenseApproved: false }, now: () => now }), /License approval/);
  assert.throws(() => mapSnapshotToBars(snapshot([]), { source: { ...source, venues: [] }, now: () => now }), /venue is not allowlisted/i);
  assert.throws(() => mapSnapshotToBars(snapshot([]), { source: { ...source, currencies: [] }, now: () => now }), /JPY currency/);
});

test("rejects symbols, intervals, provider hosts and venue claims outside contract", () => {
  assert.throws(() => mapSnapshotToBars({ ...snapshot([]), symbol: "BTCUSDT" }, { source, now: () => now }), /Symbol/);
  assert.throws(() => mapSnapshotToBars({ ...snapshot([]), interval: "30m" }, { source, now: () => now }), /Interval/);
  assert.throws(() => mapSnapshotToBars({ ...snapshot([]), sourceHost: "evil.example" }, { source, now: () => now }), /provider/);
  assert.throws(() => mapSnapshotToBars({ ...snapshot([]), venueCompatibility: "BINANCE_JAPAN_VERIFIED" }, { source, now: () => now }), /compatibility/);
});

test("rejects malformed kline boundaries", () => {
  assert.throws(() => mapSnapshotToBars(snapshot([candle(now - 120000, now - 1)]), { source, now: () => now }), /boundaries/);
});

test("does not infer a real license from a placeholder evidence reference", () => {
  const result = mapSnapshotToBars(snapshot([]), { source, now: () => now });
  assert.equal(result.sourceIdentity.licenseEvidenceRef, "test-fixture:approved-license-evidence");
  assert.equal(result.bars.length, 0);
});
