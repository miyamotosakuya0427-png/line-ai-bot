"use strict";

// Public market-data adapter only. This does not authenticate to a Binance Japan
// account and does not expose account, order, withdrawal, futures or margin APIs.
const BASE_URL = "https://data-api.binance.vision";
const ALLOWED_PAIRS = new Set(["BTCJPY", "ETHJPY", "SOLJPY"]);
const INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
const MAX_RESPONSE_BYTES = 2_000_000;

class MarketDataError extends Error {
  constructor(message, code = "MARKET_DATA_ERROR") { super(message); this.name = "MarketDataError"; this.code = code; }
}

function assertPair(symbol) {
  if (!ALLOWED_PAIRS.has(symbol)) throw new MarketDataError("Unsupported symbol", "UNSUPPORTED_SYMBOL");
  return symbol;
}

function assertFresh(timestamp, maxAgeMs = 120_000, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp > maxAgeMs || timestamp > now + 30_000) {
    throw new MarketDataError("Market data is stale or has an invalid timestamp", "STALE_DATA");
  }
}

function validateBaseUrl() {
  const parsed = new URL(BASE_URL);
  if (parsed.protocol !== "https:" || parsed.hostname !== "data-api.binance.vision" || parsed.pathname !== "/") {
    throw new MarketDataError("Market-data host is not allowlisted", "HOST_NOT_ALLOWED");
  }
  return parsed;
}

async function request(path, params = {}, fetchImpl = fetch) {
  if (!["/api/v3/exchangeInfo", "/api/v3/ticker/price", "/api/v3/ticker/24hr", "/api/v3/depth", "/api/v3/klines"].includes(path)) {
    throw new MarketDataError("Endpoint is not allowlisted", "ENDPOINT_NOT_ALLOWED");
  }
  const url = validateBaseUrl();
  url.pathname = path;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new MarketDataError("Market-data request failed or timed out", "UPSTREAM_UNAVAILABLE");
  }
  if (!response.ok) throw new MarketDataError("Market-data provider returned HTTP " + response.status, "UPSTREAM_HTTP_ERROR");
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new MarketDataError("Market-data response too large", "RESPONSE_TOO_LARGE");
  try { return JSON.parse(raw); } catch { throw new MarketDataError("Invalid JSON from market-data provider", "INVALID_RESPONSE"); }
}

function number(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new MarketDataError("Invalid numeric field: " + field, "INVALID_MARKET_VALUE");
  return n;
}

async function getExchangeInfo(fetchImpl = fetch) {
  const info = await request("/api/v3/exchangeInfo", {}, fetchImpl);
  if (!info || !Array.isArray(info.symbols)) throw new MarketDataError("Invalid exchangeInfo schema", "INVALID_RESPONSE");
  return Object.fromEntries([...ALLOWED_PAIRS].map(symbol => {
    const item = info.symbols.find(x => x.symbol === symbol);
    return [symbol, item ? {
      listed: true,
      status: item.status || item.symbolStatus || "UNKNOWN",
      spotAllowed: item.isSpotTradingAllowed === true || (Array.isArray(item.permissions) && item.permissions.includes("SPOT")),
      filters: Array.isArray(item.filters) ? item.filters : []
    } : { listed: false, status: "NOT_FOUND", spotAllowed: false, filters: [] }];
  }));
}

async function getSnapshot(symbol, options = {}) {
  assertPair(symbol);
  const fetchImpl = options.fetchImpl || fetch;
  const interval = options.interval || "1h";
  if (!INTERVALS.has(interval)) throw new MarketDataError("Unsupported kline interval", "UNSUPPORTED_INTERVAL");
  const [exchange, price, ticker, depth, klines] = await Promise.all([
    getExchangeInfo(fetchImpl),
    request("/api/v3/ticker/price", { symbol }, fetchImpl),
    request("/api/v3/ticker/24hr", { symbol }, fetchImpl),
    request("/api/v3/depth", { symbol, limit: 100 }, fetchImpl),
    request("/api/v3/klines", { symbol, interval, limit: 200 }, fetchImpl)
  ]);
  if (!exchange[symbol].listed) throw new MarketDataError(symbol + " is not listed by the configured public market-data endpoint", "PAIR_NOT_LISTED");
  if (!Array.isArray(depth.bids) || !Array.isArray(depth.asks) || !Array.isArray(klines) || klines.length < 60) {
    throw new MarketDataError("Incomplete order book or kline data", "INCOMPLETE_DATA");
  }
  const timestamp = Date.now();
  const close = number(price.price, "price");
  const lastKline = klines[klines.length - 1];
  const klineOpenTime = Number(lastKline[0]);
  const intervalMs = ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 })[interval];
  if (!Number.isFinite(klineOpenTime) || klineOpenTime > timestamp + 30_000 || timestamp - klineOpenTime > intervalMs * 3) {
    throw new MarketDataError("Latest kline is stale or has an invalid timestamp", "STALE_DATA");
  }
  if (!Number.isFinite(Number(ticker.closeTime))) throw new MarketDataError("Invalid ticker timestamp", "INVALID_RESPONSE");
  assertFresh(Number(ticker.closeTime), 120_000, timestamp);
  return {
    source: "Binance public market-data API",
    sourceHost: "data-api.binance.vision",
    venueCompatibility: "UNVERIFIED_BINANCE_JAPAN_ACCOUNT",
    symbol, quoteAsset: "JPY", interval, observedAt: timestamp,
    price: close,
    changePercent24h: Number(ticker.priceChangePercent),
    volume24h: number(ticker.volume, "volume"),
    quoteVolume24h: number(ticker.quoteVolume, "quoteVolume"),
    orderBook: {
      bids: depth.bids.map(x => [number(x[0], "bidPrice"), number(x[1], "bidQty")]),
      asks: depth.asks.map(x => [number(x[0], "askPrice"), number(x[1], "askQty")])
    },
    klines: klines.map(k => ({
      openTime: Number(k[0]), open: number(k[1], "open"), high: number(k[2], "high"),
      low: number(k[3], "low"), close: number(k[4], "close"), volume: number(k[5], "volume"),
      closeTime: Number(k[6])
    })),
    exchangeRules: exchange[symbol],
    stale: false
  };
}

module.exports = { ALLOWED_PAIRS, INTERVALS, MarketDataError, assertPair, assertFresh, getExchangeInfo, getSnapshot };
