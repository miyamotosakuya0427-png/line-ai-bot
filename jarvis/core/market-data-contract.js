"use strict";

const crypto=require("node:crypto");

const INTERVALS=new Set(["1m","5m","15m","30m","1h","4h","1d","1w"]);
const ADJUSTMENTS=new Set(["raw","split_adjusted","total_return_adjusted"]);

function validTimestamp(value){
  if(typeof value!=="string")return false;
  const m=/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if(!m)return false;
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]),date=new Date(Date.UTC(y,mo-1,d));
  if(y<1||date.getUTCFullYear()!==y||date.getUTCMonth()!==mo-1||date.getUTCDate()!==d)return false;
  if(m[8]){const h=Number(m[9]),min=Number(m[10]);if(h>14||min>59||(h===14&&min!==0))return false;}
  return Number.isFinite(Date.parse(value));
}
function normalizeMarketBar(input,{sources={},now=()=>new Date(),maxReceivedAgeMs=15*60*1000}={}){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid market bar");
  if(!Number.isInteger(maxReceivedAgeMs)||maxReceivedAgeMs<1000||maxReceivedAgeMs>7*24*60*60*1000)throw new Error("Invalid market data freshness limit");
  const source=String(input.source||"");
  const config=sources[source];
  if(!config||typeof config!=="object"||typeof config.provider!=="string"||!config.provider.trim()||typeof config.licenseId!=="string"||!config.licenseId.trim())throw new Error("Market data source is not allowlisted with a configured license");
  const symbol=String(input.symbol||"").trim(),venue=String(input.venue||"").trim().toUpperCase();
  const currency=String(input.currency||"").toUpperCase(),interval=String(input.interval||"");
  if(!/^[A-Z0-9._:-]{1,32}$/.test(symbol))throw new Error("Invalid instrument symbol");
  if(!/^[A-Z0-9._-]{2,20}$/.test(venue))throw new Error("Invalid trading venue");
  if(!/^[A-Z]{3}$/.test(currency))throw new Error("Invalid currency");
  if(!INTERVALS.has(interval))throw new Error("Unsupported bar interval");
  if(Array.isArray(config.venues)&&!config.venues.includes(venue))throw new Error("Venue is not authorized for this market data source");
  if(Array.isArray(config.currencies)&&!config.currencies.includes(currency))throw new Error("Currency is not authorized for this market data source");
  const {open,high,low,close,volume}=input;
  for(const [key,value] of Object.entries({open,high,low,close}))if(!Number.isFinite(value)||value<=0)throw new Error("Invalid "+key+" price");
  if(!Number.isFinite(volume)||volume<0)throw new Error("Invalid market volume");
  if(high<Math.max(open,close,low)||low>Math.min(open,close,high))throw new Error("Inconsistent OHLC range");
  const eventTime=String(input.eventTime||""),receivedAt=String(input.receivedAt||"");
  if(!validTimestamp(eventTime)||!validTimestamp(receivedAt))throw new Error("Market timestamps must be valid timezone-qualified ISO values");
  const nowValue=now(),nowMs=nowValue instanceof Date?nowValue.getTime():Date.parse(nowValue);
  const receivedMs=Date.parse(receivedAt),eventMs=Date.parse(eventTime);
  if(!Number.isFinite(nowMs))throw new Error("Invalid market data clock");
  if(receivedMs>nowMs+60_000)throw new Error("Market data received timestamp is in the future");
  if(nowMs-receivedMs>maxReceivedAgeMs)throw new Error("Market data is stale");
  if(eventMs>nowMs+5*60_000)throw new Error("Market event timestamp is in the future");
  const adjustment=String(input.adjustment||"");
  if(!ADJUSTMENTS.has(adjustment))throw new Error("Invalid corporate-action adjustment state");
  const sourceRecordId=String(input.sourceRecordId||"");
  if(sourceRecordId.length>200)throw new Error("Source record ID is too long");
  const id=crypto.createHash("sha256").update([source,symbol,venue,interval,eventTime,sourceRecordId||[open,high,low,close,volume].join(",")].join("\n")).digest("hex");
  return {
    id,provider:config.provider,source,licenseId:config.licenseId,symbol,venue,currency,interval,
    eventTime,receivedAt,open,high,low,close,volume,adjustment,sourceRecordId,
    verification:"unverified",verified:false,
    limitations:["Allowlisted source configuration does not independently prove data accuracy","Corporate-action revisions and delisted-instrument coverage require separate reconciliation"]
  };
}
module.exports={INTERVALS,ADJUSTMENTS,validTimestamp,normalizeMarketBar};
