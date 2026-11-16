"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {normalizeMarketBar}=require("./market-data-contract");

const sources={"jquants-daily":{provider:"JPX J-Quants",licenseId:"owner-configured-jquants-plan",venues:["TSE"],currencies:["JPY"]}};
const bar={source:"jquants-daily",symbol:"7203",venue:"TSE",currency:"JPY",interval:"1d",eventTime:"2026-11-16T06:00:00Z",receivedAt:"2026-11-16T06:05:00Z",open:1000,high:1020,low:990,close:1010,volume:10000,adjustment:"split_adjusted",sourceRecordId:"record-7203-20261116"};
const now=()=>new Date("2026-11-16T06:10:00Z");

test("normalizes an allowlisted market bar without claiming independent verification",()=>{
 const result=normalizeMarketBar(bar,{sources,now});
 assert.equal(result.provider,"JPX J-Quants");
 assert.equal(result.licenseId,"owner-configured-jquants-plan");
 assert.equal(result.verified,false);
 assert.equal(result.verification,"unverified");
 assert.equal(result.symbol,"7203");
});
test("rejects unconfigured sources and unauthorized venue or currency",()=>{
 assert.throws(()=>normalizeMarketBar(bar,{now}),/not allowlisted/);
 assert.throws(()=>normalizeMarketBar({...bar,venue:"NYSE"},{sources,now}),/Venue is not authorized/);
 assert.throws(()=>normalizeMarketBar({...bar,currency:"USD"},{sources,now}),/Currency is not authorized/);
});
test("rejects invalid OHLCV and adjustment state",()=>{
 assert.throws(()=>normalizeMarketBar({...bar,high:900},{sources,now}),/Inconsistent OHLC/);
 assert.throws(()=>normalizeMarketBar({...bar,volume:-1},{sources,now}),/volume/);
 assert.throws(()=>normalizeMarketBar({...bar,adjustment:"unknown"},{sources,now}),/adjustment/);
});
test("rejects invalid, stale, and future timestamps",()=>{
 assert.throws(()=>normalizeMarketBar({...bar,eventTime:"2026-02-30T06:00:00Z"},{sources,now}),/timestamps/);
 assert.throws(()=>normalizeMarketBar({...bar,receivedAt:"2026-11-16T05:00:00Z"},{sources,now}),/stale/);
 assert.throws(()=>normalizeMarketBar({...bar,receivedAt:"2026-11-16T06:20:00Z"},{sources,now}),/future/);
});
test("rejects invalid policy and bounds source record identifiers",()=>{
 assert.throws(()=>normalizeMarketBar(bar,{sources,now,maxReceivedAgeMs:10}),/freshness limit/);
 assert.throws(()=>normalizeMarketBar({...bar,sourceRecordId:"x".repeat(201)},{sources,now}),/too long/);
});
