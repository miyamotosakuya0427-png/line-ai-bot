"use strict";

const crypto=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");

const MAX_EVENTS=100000;
const MAX_JOURNAL_BYTES=64*1024*1024;
const PLATFORMS=new Set(["x","truth_social","official_web","sec","press_release","other"]);
const VERIFICATION=new Set(["official_api","official_web","licensed_feed","unverified"]);

function clone(value){return JSON.parse(JSON.stringify(value));}
function validTimestamp(value){
  if(typeof value!=="string")return false;
  const match=/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if(!match)return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if(year<1||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return false;
  if(match[9]){
    const hours=Number(match[10]),minutes=Number(match[11]);
    if(hours>14||minutes>59||(hours===14&&minutes!==0))return false;
  }
  return Number.isFinite(Date.parse(value));
}
function normalizeInfluenceEvent(input, observedAt=new Date().toISOString()){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid influence event");
  const platform=String(input.platform||"");
  if(!PLATFORMS.has(platform))throw new Error("Unsupported platform");
  const actor=String(input.actor||"").trim(),handle=String(input.handle||"").trim();
  const text=String(input.text||"");
  if(!actor||actor.length>120||!handle||handle.length>120)throw new Error("Actor and handle are required");
  if(!text.trim()||text.length>12000)throw new Error("Post text must be 1-12000 characters");
  const postedAt=String(input.postedAt||"");
  if(!validTimestamp(postedAt))throw new Error("Invalid post timestamp");
  if(!validTimestamp(observedAt))throw new Error("Invalid observation timestamp");
  const sourceUrl=String(input.sourceUrl||"");
  if(sourceUrl.length>2048)throw new Error("Source URL is too long");
  let url;try{url=new URL(sourceUrl);}catch{throw new Error("A source URL is required");}
  if(url.protocol!=="https:"||url.username||url.password||url.port)throw new Error("Source URL must be a credential-free HTTPS URL on the default port");
  const verification=String(input.verification||"unverified");
  if(!VERIFICATION.has(verification))throw new Error("Invalid source verification");
  const sourceId=String(input.sourceId||"");
  if(sourceId.length>200)throw new Error("Source ID is too long");
  const hash=crypto.createHash("sha256").update([platform,handle,sourceId||postedAt,text].join("\n")).digest("hex");
  return {id:hash,platform,actor,handle,sourceId,postedAt,observedAt,sourceUrl:url.toString(),verification,text,language:String(input.language||"und").slice(0,16)};
}

function createInfluenceEventStore({filePath,clock=()=>new Date().toISOString(),maxJournalBytes=MAX_JOURNAL_BYTES,maxEvents=MAX_EVENTS}={}){
  if(typeof filePath!=="string"||!path.isAbsolute(filePath))throw new Error("Influence event store requires an absolute persistent file path");
  if(!Number.isInteger(maxJournalBytes)||maxJournalBytes<1024||maxJournalBytes>MAX_JOURNAL_BYTES||!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>MAX_EVENTS)throw new Error("Invalid influence journal limits");
  let events=[],ids=new Set(),initialized=false,poisoned=false,queue=Promise.resolve();
  function serialize(fn){const p=queue.then(fn);queue=p.catch(()=>{});return p;}
  async function init(){return serialize(async()=>{
    if(initialized)return {ok:true,eventCount:events.length};
    await fs.mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
    let raw="";try{raw=await fs.readFile(filePath,"utf8");}catch(e){if(e.code!=="ENOENT")throw e;}
    if(Buffer.byteLength(raw)>maxJournalBytes)throw new Error("Influence journal exceeds size limit");
    const recovered=[],recoveredIds=new Set();
    for(const [i,line] of raw.split("\n").entries()){
      if(!line)continue;let event;try{event=JSON.parse(line);}catch{throw new Error("Influence journal is corrupt at line "+(i+1));}
      const normalized=normalizeInfluenceEvent(event,event.observedAt);
      if(normalized.id!==event.id||recoveredIds.has(event.id))throw new Error("Influence journal has invalid or duplicate event at line "+(i+1));
      recoveredIds.add(event.id);recovered.push(normalized);
      if(recovered.length>maxEvents)throw new Error("Influence journal exceeds event limit");
    }
    events=recovered;ids=recoveredIds;initialized=true;return {ok:true,eventCount:events.length};
  });}
  async function add(input){if(poisoned)throw new Error("Influence journal requires restart and recovery");if(!initialized)await init();return serialize(async()=>{
    if(poisoned)throw new Error("Influence journal requires restart and recovery");
    const event=normalizeInfluenceEvent(input,clock());
    if(ids.has(event.id))return {created:false,event:clone(events.find(x=>x.id===event.id))};
    if(events.length>=maxEvents)throw new Error("Influence event capacity reached");
    const line=JSON.stringify(event)+"\n";
    let currentBytes=0;try{currentBytes=(await fs.stat(filePath)).size;}catch(error){if(error.code!=="ENOENT")throw error;}
    if(currentBytes+Buffer.byteLength(line)>maxJournalBytes)throw new Error("Influence journal size limit reached");
    try{const handle=await fs.open(filePath,"a",0o600);try{await handle.writeFile(line,"utf8");await handle.sync();}finally{await handle.close();}await fs.chmod(filePath,0o600);}
    catch(error){poisoned=true;throw new Error("Influence journal write failed; restart required: "+error.message);}
    events.push(event);ids.add(event.id);return {created:true,event:clone(event)};
  });}
  async function list({limit=100,platform,actor,since}={}){if(!initialized)await init();return serialize(async()=>{
    if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error("Invalid event limit");
    const filtered=events.filter(e=>(!platform||e.platform===platform)&&(!actor||e.actor.toLowerCase().includes(String(actor).toLowerCase()))&&(!since||e.postedAt>=since));
    return clone(filtered.slice(-limit).reverse());
  });}
  return {init,add,list,async count(){if(!initialized)await init();return events.length;}};
}
module.exports={PLATFORMS,VERIFICATION,validTimestamp,normalizeInfluenceEvent,createInfluenceEventStore};
