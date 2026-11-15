"use strict";

const crypto=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const {createPaperTradingEngine}=require("./paper-trading");

const MAX_EVENTS=500000;
const MAX_JOURNAL_BYTES=256*1024*1024;
function clone(v){return JSON.parse(JSON.stringify(v));}
function createPaperTradingStore({filePath,policy={},clock=()=>new Date().toISOString(),maxJournalBytes=MAX_JOURNAL_BYTES,maxEvents=MAX_EVENTS}={}){
 if(typeof filePath!=="string"||!path.isAbsolute(filePath))throw new Error("Paper trading store requires an absolute persistent file path");
 if(!Number.isInteger(maxJournalBytes)||maxJournalBytes<1024||maxJournalBytes>MAX_JOURNAL_BYTES||!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>MAX_EVENTS)throw new Error("Invalid paper trading journal limits");
 let events=[];let engine=createPaperTradingEngine({policy,clock});let initialized=false;let poisoned=false;let queue=Promise.resolve();
 async function serialize(fn){const p=queue.then(fn);queue=p.catch(()=>{});return p;}
 async function ready(){if(poisoned)throw new Error("Paper trading journal write failed; restart and recover from durable journal before continuing");if(!initialized)await store.init();}
 async function init(){
  return serialize(async()=>{
   if(initialized)return {ok:true,eventCount:events.length};
   await fs.mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
   let raw="";try{raw=await fs.readFile(filePath,"utf8");}catch(e){if(e.code!=="ENOENT")throw e;}
   if(Buffer.byteLength(raw)>maxJournalBytes)throw new Error("Paper trading journal exceeds size limit");
   const recovered=[];
   for(const [i,line] of raw.split("\n").entries()){
    if(!line)continue;let e;try{e=JSON.parse(line);}catch{throw new Error("Paper trading journal is corrupt at line "+(i+1));}
    if(!e||typeof e!=="object"||!["snapshot","open","close","lesson"].includes(e.type)||!e.data||typeof e.data!=="object")throw new Error("Paper trading journal has invalid event at line "+(i+1));
    recovered.push(e);if(recovered.length>maxEvents)throw new Error("Paper trading journal exceeds event limit");
   }
   const next=createPaperTradingEngine({policy,clock});
   for(const [i,e] of recovered.entries()){
    try{
     if(e.type==="snapshot")next.recordSnapshot(e.data);
     else if(e.type==="open")next.openPaperTrade(e.data);
     else if(e.type==="close")next.closePaperTrade(e.data);
     else next.recordLesson(e.data);
    }catch(err){throw new Error("Paper trading journal replay failed at line "+(i+1)+": "+err.message);}
   }
   engine=next;events=recovered;initialized=true;
   return {ok:true,eventCount:events.length};
  });
 }
 async function commit(type,data,apply){
  await ready();
  return serialize(async()=>{
   if(poisoned)throw new Error("Paper trading journal requires restart");
   if(events.length>=maxEvents)throw new Error("Paper trading journal event limit reached");
   const event={type,data:clone(data),recordedAt:clock()};
   const line=JSON.stringify(event)+"\n";
   let currentBytes=0;try{currentBytes=(await fs.stat(filePath)).size;}catch(error){if(error.code!=="ENOENT")throw error;}
   if(currentBytes+Buffer.byteLength(line)>maxJournalBytes)throw new Error("Paper trading journal size limit reached");
   const result=apply(engine,event.data);
   try{
    const handle=await fs.open(filePath,"a",0o600);
    try{await handle.writeFile(line,"utf8");await handle.sync();}finally{await handle.close();}
    await fs.chmod(filePath,0o600);
   }catch(error){poisoned=true;throw new Error("Paper trading journal write failed; restart required: "+error.message);}
   events.push(event);
   return clone(result);
  });
 }
 const store={
  init,
  async recordSnapshot(data){return commit("snapshot",data,(e,d)=>e.recordSnapshot(d));},
  async openPaperTrade(data){const normalized={...data,id:data?.id||crypto.randomUUID(),openedAt:data?.openedAt||clock()};return commit("open",normalized,(e,d)=>e.openPaperTrade(d));},
  async closePaperTrade(data){const normalized={...data,closedAt:data?.closedAt||clock()};return commit("close",normalized,(e,d)=>e.closePaperTrade(d));},
  async recordLesson(data){const normalized={...data,id:data?.id||crypto.randomUUID(),createdAt:data?.createdAt||clock()};return commit("lesson",normalized,(e,d)=>e.recordLesson(d));},
  async analyze(){await ready();return serialize(async()=>clone(engine.analyze()));},
  async riskState(){await ready();return serialize(async()=>clone(engine.riskState()));},
  async listTrades(options){await ready();return serialize(async()=>clone(engine.listTrades(options)));},
  async listSnapshots(options){await ready();return serialize(async()=>clone(engine.listSnapshots(options)));},
  async exportJournal(){await ready();return serialize(async()=>({version:1,events:clone(events),analysis:clone(engine.analyze())}));}
 };
 return store;
}
module.exports={createPaperTradingStore};
