"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPair, assertFresh, MarketDataError } = require("../core/binance-readonly-gateway");
const { sma, ema, rsi, macd, atr, orderBookRatio, analyze } = require("../core/market-indicators");

test("allows only the three JPY pairs", () => { assert.equal(assertPair("BTCJPY"), "BTCJPY"); assert.throws(() => assertPair("BTCUSDT"), MarketDataError); });
test("rejects stale and future timestamps", () => { assert.throws(() => assertFresh(Date.now()-300000, 1000), /stale/); assert.throws(() => assertFresh(Date.now()+60000), /stale/); });
test("calculates SMA and EMA", () => { assert.equal(sma([1,2,3,4], 2), 3.5); assert.ok(ema([1,2,3,4], 2) > 3); });
test("calculates RSI and MACD", () => { assert.equal(rsi(Array.from({length:20},(_,i)=>i+1)), 100); assert.ok(macd(Array.from({length:60},(_,i)=>i+1))); });
test("calculates ATR and order book ratio", () => { const candles=Array.from({length:20},(_,i)=>({high:i+3,low:i+1,close:i+2})); assert.ok(atr(candles,14)>0); assert.equal(orderBookRatio({bids:[[100,2]],asks:[[101,1]]}),20000/30100); });
test("analysis rejects stale snapshots", () => { assert.throws(() => analyze({stale:true,observedAt:Date.now(),klines:[],orderBook:{bids:[],asks:[]}}), /Stale/); });
