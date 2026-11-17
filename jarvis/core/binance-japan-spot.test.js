"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {createBinanceJapanSpotClient,validateLimitOrder}=require("./binance-japan-spot");
const {createBinanceJapanOrderExecutor,RESOURCE_ID,ACTOR}=require("./binance-japan-executor");

function response(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data};}
const exchangeInfo={symbols:[{symbol:"BTCJPY",status:"TRADING",isSpotTradingAllowed:true,filters:[
 {filterType:"PRICE_FILTER",minPrice:"1.00",maxPrice:"99999999.00",tickSize:"1.00"},
 {filterType:"LOT_SIZE",minQty:"0.00001",maxQty:"100.00000",stepSize:"0.00001"},
 {filterType:"MIN_NOTIONAL",minNotional:"100"}
]}]};

test("uses signed Binance query with timestamp, receive window and HMAC; never sends secret",async()=>{
 let captured;
 const client=createBinanceJapanSpotClient({apiKey:"public-key",secret:"private-secret",clock:()=>123456789,fetchImpl:async(url,options)=>{captured={url,options};return response({balances:[]});}});
 await client.account();
 const u=new URL(captured.url),params=new URLSearchParams(u.search);
 const signature=params.get("signature");params.delete("signature");
 assert.equal(params.get("timestamp"),"123456789");
 assert.equal(params.get("recvWindow"),"5000");
 assert.equal(captured.options.headers["X-MBX-APIKEY"],"public-key");
 assert.equal(signature,crypto.createHmac("sha256","private-secret").update(params.toString()).digest("hex"));
 assert.equal(captured.url.includes("private-secret"),false);
});

test("public market endpoints work without account credentials",async()=>{
 const client=createBinanceJapanSpotClient({fetchImpl:async()=>response({symbol:"BTCJPY",price:"15000000"})});
 assert.equal((await client.tickerPrice("BTCJPY")).price,"15000000");
 await assert.rejects(client.account(),/credentials/);
});

test("rejects untrusted base URLs and invalid intervals",()=>{
 assert.throws(()=>createBinanceJapanSpotClient({baseUrl:"https://evil.example"}),/not allowlisted/);
 const client=createBinanceJapanSpotClient({fetchImpl:async()=>response([])});
 assert.rejects(client.klines({symbol:"BTCJPY",interval:"2m"}),/Invalid kline/);
});

test("validates JPY spot limit orders against Binance filters and hard notional cap",()=>{
 const valid=validateLimitOrder({symbol:"BTCJPY",side:"BUY",price:"10000000",quantity:"0.0001"},exchangeInfo,{maxNotional:"5000"});
 assert.deepEqual(valid,{symbol:"BTCJPY",side:"BUY",type:"LIMIT",timeInForce:"GTC",quantity:"0.0001",price:"10000000"});
 assert.throws(()=>validateLimitOrder({symbol:"BTCJPY",side:"BUY",price:"10000000.5",quantity:"0.0001"},exchangeInfo),/PRICE_FILTER/);
 assert.throws(()=>validateLimitOrder({symbol:"BTCJPY",side:"BUY",price:"10000000",quantity:"0.00001"},exchangeInfo),/minimum notional/);
 assert.throws(()=>validateLimitOrder({symbol:"BTCUSDT",side:"BUY",price:"100",quantity:"1"},exchangeInfo),/JPY spot/);
 assert.throws(()=>validateLimitOrder({symbol:"BTCJPY",side:"BUY",price:"10000000",quantity:"0.001"},exchangeInfo,{maxNotional:"5000"}),/notional limit/);
});

test("live execution stays disabled unless both feature flag and owner auth are ready",async()=>{
 const approvalStore={get:async()=>null,claimExecution:async()=>{throw new Error("must not run");},finishExecution:async()=>{}};
 const executor=createBinanceJapanOrderExecutor({client:{placeLimitOrder:async()=>({})},approvalStore,enabled:true,ownerAuthReady:false});
 assert.equal(executor.enabled,false);
 assert.deepEqual(await executor.execute("id"),{ok:false,status:"disabled",message:"Live Binance order execution is disabled"});
});

test("approved order claims once and sends a limit order; ambiguous dispatch is never retried",async()=>{
 let claimed=0,placed=0,finished=0;
 const payload={symbol:"BTCJPY",side:"BUY",type:"LIMIT",timeInForce:"GTC",quantity:"0.0001",price:"10000000",clientOrderId:"OJ1234567890abcdef1234567890"};
 const approval={id:"a",status:"approved",actionClass:"financial",resourceId:RESOURCE_ID,operationPayload:payload,executionStatus:"not_started"};
 const claim={...approval,executionClaim:{id:"claim",actor:ACTOR}};
 const store={get:async()=>approval,claimExecution:async()=>{claimed++;return claim;},finishExecution:async()=>{finished++;}};
 const executor=createBinanceJapanOrderExecutor({client:{placeLimitOrder:async()=>{placed++;throw new Error("socket timeout");}},approvalStore:store,enabled:true,ownerAuthReady:true,maxNotionalYen:5000,authorizeRisk:async()=>({allowed:true})});
 const result=await executor.execute("a");
 assert.equal(result.status,"outcome_unknown");assert.equal(claimed,1);assert.equal(placed,1);assert.equal(finished,0);
});

test("definitive exchange rejection finalizes approval as failed",async()=>{
 let outcome;
 const payload={symbol:"BTCJPY",side:"BUY",type:"LIMIT",timeInForce:"GTC",quantity:"0.0001",price:"10000000",clientOrderId:"OJ1234567890abcdef1234567890"};
 const approval={id:"a",status:"approved",actionClass:"financial",resourceId:RESOURCE_ID,operationPayload:payload,executionStatus:"not_started"};
 const claim={...approval,executionClaim:{id:"claim",actor:ACTOR}};
 const store={get:async()=>approval,claimExecution:async()=>claim,finishExecution:async(_id,value)=>{outcome=value.outcome;}};
 const error=Object.assign(new Error("rejected"),{definitive:true,code:-1013});
 const executor=createBinanceJapanOrderExecutor({client:{placeLimitOrder:async()=>{throw error;}},approvalStore:store,enabled:true,ownerAuthReady:true,authorizeRisk:async()=>({allowed:true})});
 assert.equal((await executor.execute("a")).status,"rejected");assert.equal(outcome,"failed");
});
