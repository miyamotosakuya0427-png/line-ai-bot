"use strict";

function values(input, key = "close") {
  if (!Array.isArray(input)) throw new TypeError("Expected array");
  const result = input.map(x => Number(typeof x === "object" ? x[key] : x));
  if (result.some(x => !Number.isFinite(x))) throw new TypeError("Non-finite indicator input");
  return result;
}
function sma(input, period) {
  const a = values(input); if (!Number.isInteger(period) || period < 1 || a.length < period) return null;
  return a.slice(-period).reduce((s, n) => s + n, 0) / period;
}
function ema(input, period) {
  const a = values(input); if (!Number.isInteger(period) || period < 1 || a.length < period) return null;
  const k = 2 / (period + 1);
  let result = a.slice(0, period).reduce((s, n) => s + n, 0) / period;
  for (const n of a.slice(period)) result = n * k + result * (1 - k);
  return result;
}
function rsi(input, period = 14) {
  const a = values(input); if (a.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = a[i] - a[i - 1]; if (d > 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1]; avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function macd(input, fast = 12, slow = 26, signal = 9) {
  const a = values(input); if (a.length < slow + signal) return null;
  const line = [];
  for (let i = slow - 1; i < a.length; i++) line.push(ema(a.slice(0, i + 1), fast) - ema(a.slice(0, i + 1), slow));
  const signalLine = ema(line, signal);
  const current = line[line.length - 1];
  return { macd: current, signal: signalLine, histogram: current - signalLine };
}
function atr(input, period = 14) {
  if (!Array.isArray(input) || input.length <= period) return null;
  const trs = [];
  for (let i = 1; i < input.length; i++) {
    const h = Number(input[i].high), l = Number(input[i].low), prev = Number(input[i - 1].close);
    if (![h, l, prev].every(Number.isFinite)) throw new TypeError("Invalid OHLC input");
    trs.push(Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev)));
  }
  return trs.slice(-period).reduce((s, n) => s + n, 0) / period;
}
function volumeAverage(input, period = 20) { return sma(input, period) ; }
function volatility(input, period = 20) {
  const a = values(input); if (a.length <= period) return null;
  const returns = [];
  for (let i = a.length - period; i < a.length; i++) returns.push(Math.log(a[i] / a[i - 1]));
  const mean = returns.reduce((s, n) => s + n, 0) / returns.length;
  return Math.sqrt(returns.reduce((s, n) => s + (n - mean) ** 2, 0) / returns.length);
}
function orderBookRatio(book) {
  const bid = book.bids.reduce((s, x) => s + Number(x[0]) * Number(x[1]), 0);
  const ask = book.asks.reduce((s, x) => s + Number(x[0]) * Number(x[1]), 0);
  if (![bid, ask].every(Number.isFinite) || bid + ask <= 0) return null;
  return bid / (bid + ask);
}
function analyze(snapshot) {
  if (!snapshot || snapshot.stale || Date.now() - snapshot.observedAt > 120_000) throw new Error("Stale market snapshot");
  const c = snapshot.klines.map(x => x.close), v = snapshot.klines.map(x => x.volume);
  return { symbol: snapshot.symbol, observedAt: snapshot.observedAt, sma20: sma(c, 20), sma50: sma(c, 50),
    ema20: ema(c, 20), rsi14: rsi(c, 14), macd: macd(c), atr14: atr(snapshot.klines, 14),
    volumeAverage20: volumeAverage(v, 20), volatility20: volatility(c, 20), orderBookBidRatio: orderBookRatio(snapshot.orderBook) };
}
module.exports = { sma, ema, rsi, macd, atr, volumeAverage, volatility, orderBookRatio, analyze };
