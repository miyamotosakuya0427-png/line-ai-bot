"use strict";
const test=require("node:test"); const assert=require("node:assert/strict");
const {normalizeFilters,validateOrder,TradingRuleError}=require("../core/binance-japan-trading-rules");
const info={symbol:"BTCJPY",status:"TRADING",isSpotTradingAllowed:true,filters:[
{filterType:"PRICE_FILTER",minPrice:"0.01",maxPrice:"100000000",tickSize:"0.01"},
{filterType:"LOT_SIZE",minQty:"0.00001",maxQty:"100",stepSize:"0.00001"},
{filterType:"MARKET_LOT_SIZE",minQty:"0.00001",maxQty:"100",stepSize:"0.00001"},
{filterType:"MIN_NOTIONAL",minNotional:"1000",applyToMarket:true}
]};
const verified={venue:"BINANCE_JAPAN",accountContextVerified:true,sourceHostVerified:true,sourceHost:"verified-account-endpoint"};
test("normalizes PRICE_FILTER, LOT_SIZE, MARKET_LOT_SIZE and MIN_NOTIONAL",()=>{const r=normalizeFilters(info,verified);assert.equal(r.verification,"VERIFIED");assert.equal(r.price.tickSize,0.01);assert.equal(r.lot.stepSize,0.00001);assert.equal(r.marketLot.min,0.00001);assert.equal(r.notional.min,1000);});
test("fails closed for global public market data provenance",()=>{const r=normalizeFilters(info,{venue:"GLOBAL_PUBLIC",sourceHost:"data-api.binance.vision"});assert.throws(()=>validateOrder({side:"BUY",type:"LIMIT",price:"100000",quantity:"0.01"},r),e=>e.code==="UNVERIFIED_JAPAN_RULES");});
test("rejects minimum quantity, quantity step and maximum quantity",()=>{const r=normalizeFilters(info,verified);assert.throws(()=>validateOrder({side:"BUY",type:"MARKET",quantity:"0.000001"},r),e=>e.code==="LOT_SIZE_VIOLATION");assert.throws(()=>validateOrder({side:"BUY",type:"MARKET",quantity:"0.000011"},r),e=>e.code==="LOT_SIZE_VIOLATION");assert.throws(()=>validateOrder({side:"BUY",type:"MARKET",quantity:"101"},r),e=>e.code==="LOT_SIZE_VIOLATION");});
test("rejects notional and price tick violations",()=>{const r=normalizeFilters(info,verified);assert.throws(()=>validateOrder({side:"BUY",type:"LIMIT",price:"10000.001",quantity:"0.01"},r),e=>e.code==="PRICE_FILTER_VIOLATION");assert.throws(()=>validateOrder({side:"BUY",type:"LIMIT",price:"100000",quantity:"0.00001"},r),e=>e.code==="NOTIONAL_VIOLATION");});
test("uses MARKET_LOT_SIZE for market orders",()=>{const r=normalizeFilters(info,verified);assert.equal(validateOrder({side:"BUY",type:"MARKET",quantity:"0.01"},r).valid,true);});
test("rejects halted and unsupported order intents",()=>{const r=normalizeFilters({...info,status:"HALT"},verified);assert.throws(()=>validateOrder({side:"BUY",type:"MARKET",quantity:"0.01"},r),e=>e.code==="PAIR_NOT_TRADABLE");const active=normalizeFilters(info,verified);assert.throws(()=>validateOrder({side:"STOP_LOSS",type:"LIMIT",price:"100000",quantity:"0.01"},active),e=>e.code==="UNSUPPORTED_ORDER");});
test("rejects missing exchange filters",()=>{assert.throws(()=>normalizeFilters({symbol:"BTCJPY",filters:[]},verified),e=>e.code==="UNVERIFIED_FILTERS");});

test("requires reference price when market notional filter applies",()=>{const r=normalizeFilters(info,verified);assert.throws(()=>validateOrder({side:"BUY",type:"MARKET",quantity:"0.01"},r),e=>e.code==="UNVERIFIED_REFERENCE_PRICE");assert.equal(validateOrder({side:"BUY",type:"MARKET",quantity:"0.01",referencePrice:"100000"},r).valid,true);});
test("treats zero max bounds as unbounded exchange filters",()=>{const raw=JSON.parse(JSON.stringify(info));raw.filters[0].maxPrice="0";raw.filters[1].maxQty="0";raw.filters[2].maxQty="0";const r=normalizeFilters(raw,verified);assert.equal(r.price.max,Infinity);assert.equal(r.lot.max,Infinity);});
