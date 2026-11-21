"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPair, assertFresh, getSnapshot, MarketDataError } = require("../core/binance-readonly-gateway");
const { sma, ema, rsi, macd, atr, orderBookRatio, analyze } = require("../core/market-indicators");

test("allows only the three JPY pairs", () => { assert.equal(assertPair("BTCJPY"), "BTCJPY"); assert.throws(() => assertPair("BTCUSDT"), MarketDataError); });
test("rejects stale and future timestamps", () => { assert.throws(() => assertFresh(Date.now()-300000, 1000), /stale/); assert.throws(() => assertFresh(Date.now()+60000), /stale/); });
test("calculates SMA and EMA", () => { assert.equal(sma([1,2,3,4], 2), 3.5); assert.ok(ema([1,2,3,4], 2) > 3); });
test("calculates RSI and MACD", () => { assert.equal(rsi(Array.from({length:20},(_,i)=>i+1)), 100); assert.ok(macd(Array.from({length:60},(_,i)=>i+1))); });
test("calculates ATR and order book ratio", () => { const candles=Array.from({length:20},(_,i)=>({high:i+3,low:i+1,close:i+2})); assert.ok(atr(candles,14)>0); assert.equal(orderBookRatio({bids:[[100,2]],asks:[[101,1]]}),20000/30100); });
test("analysis rejects stale snapshots", () => { assert.throws(() => analyze({stale:true,observedAt:Date.now(),klines:[],orderBook:{bids:[],asks:[]}}), /Stale/); });


function mockFetch(overrides = {}) {
  const now = Date.now();
  const rows = Array.from({length:60},(_,i)=>[now-60*60*1000*(60-i), String(100+i), String(105+i), String(95+i), String(100+i), "2", now-60*60*1000*(59-i)+3599999]);
  return async (url) => {
    const path = new URL(url).pathname;
    let data;
    if (path.endsWith("/exchangeInfo")) data = {symbols:[{symbol:"BTCJPY",status:"TRADING",isSpotTradingAllowed:true,filters:[]},{symbol:"ETHJPY",status:"TRADING",isSpotTradingAllowed:true,filters:[]},{symbol:"SOLJPY",status:"TRADING",isSpotTradingAllowed:true,filters:[]}]};
    else if (path.endsWith("/ticker/price")) data = {price:"100"};
    else if (path.endsWith("/ticker/24hr")) data = {priceChangePercent:"2.5",volume:"10",quoteVolume:"1000",closeTime:now};
    else if (path.endsWith("/depth")) data = {bids:[["99","2"]],asks:[["101","1"]]};
    else if (path.endsWith("/klines")) data = rows;
    if (overrides[path]) data = overrides[path];
    if (data instanceof Error) return new Response("upstream failure",{status:503});
    return new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}});
  };
}
test("requests all public market-data endpoints and builds a snapshot", async () => {
  const paths=[];
  const base=mockFetch();
  const fetchImpl=async (url,init)=>{paths.push(new URL(url).pathname);return base(url,init);};
  const snapshot=await getSnapshot("BTCJPY",{fetchImpl,interval:"1h"});
  assert.equal(snapshot.symbol,"BTCJPY");
  assert.equal(snapshot.quoteAsset,"JPY");
  assert.equal(snapshot.venueCompatibility,"UNVERIFIED_BINANCE_JAPAN_ACCOUNT");
  for (const path of ["/api/v3/exchangeInfo","/api/v3/ticker/price","/api/v3/ticker/24hr","/api/v3/depth","/api/v3/klines"]) assert.ok(paths.includes(path));
});
test("rejects a pair absent from exchangeInfo", async () => {
  const fetchImpl=mockFetch({"/api/v3/exchangeInfo":{symbols:[]}});
  await assert.rejects(()=>getSnapshot("BTCJPY",{fetchImpl}),e=>e.code==="PAIR_NOT_LISTED");
});
test("fails closed on malformed price and upstream errors", async () => {
  const badPrice=mockFetch({"/api/v3/ticker/price":{price:"-1"}});
  await assert.rejects(()=>getSnapshot("BTCJPY",{fetchImpl:badPrice}),e=>e.code==="INVALID_MARKET_VALUE");
  const failed=async()=>new Response("unavailable",{status:503});
  await assert.rejects(()=>getSnapshot("BTCJPY",{fetchImpl:failed}),e=>e.code==="UPSTREAM_HTTP_ERROR");
});

test("rejects a pair not in TRADING spot status", async () => {
  const halted={symbols:[{symbol:"BTCJPY",status:"HALT",isSpotTradingAllowed:true,filters:[]}]};
  await assert.rejects(()=>getSnapshot("BTCJPY",{fetchImpl:mockFetch({"/api/v3/exchangeInfo":halted})}),e=>e.code==="PAIR_NOT_TRADABLE");
});
