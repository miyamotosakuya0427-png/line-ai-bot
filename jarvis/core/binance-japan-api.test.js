"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {handleBinanceApi}=require("./binance-japan-api");

function makeResponse(){return {headers:{},writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=JSON.parse(body);}};}
function helpers(){return {json:(res,status,payload,headers={})=>{res.writeHead(status,headers);res.end(JSON.stringify(payload));return true;},readJson:async req=>req.body||{},isAuthorized:(req,token)=>req.headers.authorization==="Bearer "+token};}

test("serves public market data only behind JARVIS authentication",async()=>{
 let called=0;const res=makeResponse(),h=helpers();
 await handleBinanceApi({req:{method:"GET",headers:{authorization:"Bearer token"}},res,url:new URL("https://jarvis.test/v1/binance/market/ticker?symbol=BTCJPY"),client:{tickerPrice:async symbol=>{called++;return{symbol,price:"100"};}},token:"token",...h});
 assert.equal(res.status,200);assert.equal(called,1);assert.equal(res.body.ticker.symbol,"BTCJPY");
 const denied=makeResponse();
 await handleBinanceApi({req:{method:"GET",headers:{}},res:denied,url:new URL("https://jarvis.test/v1/binance/status"),client:{},token:"token",...h});
 assert.equal(denied.status,401);
});

test("creates an expiring immutable approval request, never places an order",async()=>{
 const res=makeResponse(),h=helpers();let created;
 const client={configured:true,exchangeInfo:async()=>({symbols:[{symbol:"BTCJPY",status:"TRADING",filters:[
  {filterType:"PRICE_FILTER",minPrice:"1",maxPrice:"99999999",tickSize:"1"},
  {filterType:"LOT_SIZE",minQty:"0.00001",maxQty:"100",stepSize:"0.00001"},
  {filterType:"MIN_NOTIONAL",minNotional:"100"}
 ]}]})};
 const approvalStore={create:async value=>{created=value;return{created:true,approval:{id:"11111111-1111-4111-8111-111111111111",...value}};}};
 await handleBinanceApi({req:{method:"POST",headers:{authorization:"Bearer token","content-type":"application/json"},body:{symbol:"BTCJPY",side:"BUY",price:"10000000",quantity:"0.0001",idempotencyKey:"buy-btcjpy-001"}},res,url:new URL("https://jarvis.test/v1/binance/orders/prepare"),client,approvalStore,token:"token",maxNotionalYen:5000,now:()=>new Date("2026-11-18T00:00:00Z"),...h});
 assert.equal(res.status,201);assert.equal(created.resourceId,"binance-japan-spot");assert.equal(created.operationPayload.type,"LIMIT");assert.equal(created.operationPayload.timeInForce,"GTC");assert.equal(created.expiresAt,"2026-11-18T00:15:00.000Z");assert.equal(res.body.executionEnabled,false);
});

test("requires owner authentication for execute and reconcile endpoints",async()=>{
 const res=makeResponse(),h=helpers();
 await handleBinanceApi({req:{method:"POST",headers:{authorization:"Bearer token"}},res,url:new URL("https://jarvis.test/v1/binance/orders/11111111-1111-4111-8111-111111111111/execute"),client:{},executor:{execute:async()=>({ok:true})},token:"token",ownerToken:"owner",...h});
 assert.equal(res.status,401);
});

test("account data accepts the owner token without requiring the general API token",async()=>{
 const res=makeResponse(),h=helpers();
 await handleBinanceApi({req:{method:"GET",headers:{authorization:"Bearer owner"}},res,url:new URL("https://jarvis.test/v1/binance/account"),client:{configured:true,account:async()=>({accountType:"SPOT",canTrade:true,balances:[{asset:"JPY",free:"1000",locked:"0"}]})},token:"api-token",ownerToken:"owner",...h});
 assert.equal(res.status,200);assert.equal(res.body.account.balances[0].asset,"JPY");
});
