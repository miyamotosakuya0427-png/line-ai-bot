"use strict";

// Adapter boundary for PR #79. This module never performs HTTP requests;
// it transforms an already-fetched public snapshot into Stage 5 bars.
const crypto = require("node:crypto");
const { normalizeBar, INTERVAL_MS, stable } = require("./market-data-normalizer");
const { auditBars, qualityGate } = require("./market-data-quality");

const ALLOWED_SYMBOLS = new Set(["BTCJPY", "ETHJPY", "SOLJPY"]);
const ALLOWED_INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
const PUBLIC_VENUE = "BINANCE_PUBLIC";
const PUBLIC_PROVIDER = "Binance public market-data API";

function requireSourceConfig(config) {
  if (!config || config.enabled !== true) throw new Error("Market data source is not enabled");
  if (!config.id || !config.sourceKey || config.provider !== PUBLIC_PROVIDER) throw new Error("Provider configuration is not allowlisted");
  if (!config.licenseId || !config.licenseEvidenceRef || config.licenseApproved !== true) throw new Error("License approval and evidence are not registered");
  if (!Array.isArray(config.venues) || !config.venues.includes(PUBLIC_VENUE)) throw new Error("Public venue is not allowlisted");
  if (!Array.isArray(config.currencies) || !config.currencies.includes("JPY")) throw new Error("JPY currency is not allowlisted");
  return config;
}

function mapSnapshotToBars(snapshot, { source, now = () => Date.now(), receivedAt } = {}) {
  const config = requireSourceConfig(source);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Public market snapshot is required");
  if (snapshot.sourceHost !== "data-api.binance.vision" || snapshot.source !== PUBLIC_PROVIDER) throw new Error("Unexpected public data provider");
  if (snapshot.venueCompatibility !== "UNVERIFIED_BINANCE_JAPAN_ACCOUNT") throw new Error("Unexpected venue compatibility marker");
  if (!ALLOWED_SYMBOLS.has(snapshot.symbol)) throw new Error("Symbol is not allowlisted");
  if (!ALLOWED_INTERVALS.has(snapshot.interval)) throw new Error("Interval is not allowlisted");
  if (snapshot.quoteAsset !== "JPY") throw new Error("Quote currency is not allowlisted");
  if (!Array.isArray(snapshot.klines)) throw new Error("Snapshot klines are missing");
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs)) throw new Error("Invalid adapter clock");
  const received = receivedAt || new Date(nowMs).toISOString();
  const bars = [];
  const excluded = [];
  for (const candle of snapshot.klines) {
    if (!candle || !Number.isFinite(candle.openTime) || !Number.isFinite(candle.closeTime)) {
      throw new Error("Malformed public kline");
    }
    const expectedMs = INTERVAL_MS[snapshot.interval];
    if (!expectedMs || candle.closeTime < candle.openTime || candle.closeTime >= candle.openTime + expectedMs) {
      throw new Error("Kline time boundaries do not match interval");
    }
    // A candle is final only after the provider's inclusive closeTime has elapsed.
    if (candle.closeTime >= nowMs) {
      excluded.push({ openTime: new Date(candle.openTime).toISOString(), reason: "UNCONFIRMED_CANDLE" });
      continue;
    }
    const normalized = normalizeBar({
      venue: PUBLIC_VENUE,
      symbol: snapshot.symbol,
      currency: "JPY",
      interval: snapshot.interval,
      openTime: new Date(candle.openTime).toISOString(),
      open: String(candle.open),
      high: String(candle.high),
      low: String(candle.low),
      close: String(candle.close),
      volume: String(candle.volume),
      adjustmentState: "raw"
    }, {
      source: {
        id: config.id,
        provider: config.provider,
        licenseId: config.licenseId,
        venues: config.venues,
        currencies: config.currencies
      },
      receivedAt: received
    });
    const sourcePayloadHash = crypto.createHash("sha256").update(stable(candle)).digest("hex");
    bars.push(Object.freeze({ ...normalized, sourceTimestampRaw: String(candle.openTime), sourceTimezone: "UTC_UNIX_MILLISECONDS", rawPayloadHash: sourcePayloadHash, currency: "JPY", licenseEvidenceRef: config.licenseEvidenceRef }));
  }
  const findings = auditBars(bars);
  const gate = qualityGate(findings);
  return Object.freeze({
    provider: PUBLIC_PROVIDER,
    venue: PUBLIC_VENUE,
    currency: "JPY",
    symbol: snapshot.symbol,
    interval: snapshot.interval,
    bars: Object.freeze(bars),
    excluded: Object.freeze(excluded),
    findings: Object.freeze(findings),
    quality: Object.freeze(gate),
    sourceIdentity: Object.freeze({ id: config.id, sourceKey: config.sourceKey, provider: config.provider, licenseId: config.licenseId, licenseEvidenceRef: config.licenseEvidenceRef }),
    venueCompatibility: "UNVERIFIED_BINANCE_JAPAN_ACCOUNT"
  });
}

module.exports = { ALLOWED_SYMBOLS, ALLOWED_INTERVALS, PUBLIC_VENUE, PUBLIC_PROVIDER, requireSourceConfig, mapSnapshotToBars };
