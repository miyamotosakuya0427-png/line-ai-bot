"use strict";

const crypto=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const {createPaperTradingEngine}=require("./paper-trading");

const MAX_EVENTS=500000;
const MAX_JOURNAL_BYTES=256*1024*1024;
function clone(v){return JSON.parse(JSON.stringify(v));}
function createPaperTradingStore({filePath,policy={},clock=()=>new Date().toISOString()}={}){
 if(typeof filePath!=="string"||!path.isAbsolute(filePath))throw new Error("Paper trading store requires an absolute persistent file path");
 let events=[];let engine=createPaperTradingEngine({policy,clock});let initialized=false;let queue=Promise.resolve();
 async function serialize(fn){const p=queue.then(fn);queue=p.catch(()=>{});return p;}
 function replay(list){
  const next=createPaperTradingEngine({policy,clock});
  for(const [i,e] of list.entries()){
   if(!e||typeof e!=="object"||!["snapshot","open","close","lesson"].includes(e.type)||!e.data||typeof e.data!=="object")throw new Error("Paper trading journal has invalid event at line "+(i+1));
   try{
    if(e.type==="snapshot")next.recordSnapshot(e.data);
    else if(e.type==="open")next.openPaperTrade(e.data);
    else if(e.type==="close")next.closePaperTrade(e.data);
    else next.recordLesson(e.data);
   }catch(err){throw new Error("Paper trading journal replay failed at line "+(i+1)+": "+err.message);}
  }
  return next;
 }
 async function init(){
  return serialize(async()=>{
   if(initialized)return {ok:true,eventCount:events.length};
   await fs.mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
   let raw="";try{raw=await fs.readFile(filePath,"utf8");}catch(e){if(e.code!=="ENOENT")throw e;}
   if(Buffer.byteLength(raw)>MAX_JOURNAL_BYTES)throw new Error("Paper trading journal exceeds size limit");
   const recovered=[];
   for(const [i,line] of raw.split("\n").entries()){
    if(!line)continue;let e;try{e=JSON.parse(line);}catch{throw new Error("Paper trading journal is corrupt at line "+(i+1));}
    recovered.push(e);if(recovered.length>MAX_EVENTS)throw new Error("Paper trading journal exceeds event limit");
   }
   engine=replay(recovered);events=recovered;initialized=true;
   return {ok:true,eventCount:events.length};
  });
 }
 async function ready(){if(!initialized)await init();}
 async function commit(type,data){
  await ready();
  return serialize(async()=>{
   if(events.length>=MAX_EVENTS)throw new Error("Paper trading journal event limit reached");
   const event={type,data:clone(data),recordedAt:clock()};
   const nextEvents=[...events,event];
   const nextEngine=replay(nextEvents);
   const line=JSON.stringify(event)+"\n";
   const handle=await fs.open(filePath,"a",0o600);
   try{await handle.writeFile(line,"utf8");await handle.sync();}finally{await handle.close();}
   await fs.chmod(filePath,0o600);
   events=nextEvents;engine=nextEngine;
   return {eventCount:events.length};
  });
 }
 return {
  init,
  async recordSnapshot(data){await commit("snapshot",data);const x=await this.listSnapshots({limit:1});return x[0];},
  async openPaperTrade(data){const normalized={...data,id:data?.id||crypto.randomUUID(),openedAt:data?.openedAt||clock()};await commit("open",normalized);const x=await this.listTrades({status:"open",limit:1000});return x.find(t=>t.id===normalized.id);},
  async closePaperTrade(data){await commit("close",{...data,closedAt:data?.closedAt||clock()});return this.analyze();},
  async recordLesson(data){await commit("lesson",{...data,id:data?.id||crypto.randomUUID(),createdAt:data?.createdAt||clock()});const a=await this.analyze();return a.lessons[a.lessons.length-1];},
  async analyze(){await ready();return serialize(async()=>clone(engine.analyze()));},
  async riskState(){await ready();return serialize(async()=>clone(engine.riskState()));},
  async listTrades(options){await ready();return serialize(async()=>clone(engine.listTrades(options)));},
  async listSnapshots(options){await ready();return serialize(async()=>clone(engine.listSnapshots(options)));},
  async exportJournal(){await ready();return serialize(async()=>({version:1,events:clone(events),analysis:clone(engine.analyze())}));}
 };
}
module.exports={createPaperTradingStore};
