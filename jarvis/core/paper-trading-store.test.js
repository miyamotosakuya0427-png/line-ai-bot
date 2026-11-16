"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {createPaperTradingStore}=require("./paper-trading-store");

async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"one-paper-"));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const filePath=path.join(dir,"paper.jsonl");
 let now="2026-11-16T10:00:00+09:00";
 const clock=()=>now;
 return {filePath,clock,setNow:v=>{now=v;}};
}
test("paper journal survives restart with identical trades, costs, lessons, and analysis",async t=>{
 const f=await fixture(t);
 const a=createPaperTradingStore({filePath:f.filePath,clock:f.clock});
 await a.init();
 await a.recordSnapshot({source:"market.example",symbol:"7203",capturedAt:f.clock(),price:1000});
 const trade=await a.openPaperTrade({symbol:"7203",side:"long",quantity:100,entryPrice:1000,stopPrice:995,strategyId:"breakout-v1"});
 assert.ok(trade.id);
 f.setNow("2026-11-16T11:00:00+09:00");
 await a.closePaperTrade({id:trade.id,exitPrice:990,feesYen:10,slippageYen:5});
 await a.recordLesson({tradeId:trade.id,category:"discipline",rootCause:"Entered before confirmation and ignored the setup rule",preventiveRule:"Wait for the closing candle before entry"});
 const before=await a.analyze();
 const b=createPaperTradingStore({filePath:f.filePath,clock:f.clock});
 await b.init();
 const after=await b.analyze();
 assert.deepEqual(after,before);
 assert.equal((await b.listTrades({status:"closed"}))[0].id,trade.id);
 assert.equal((await b.listSnapshots({limit:1}))[0].verified,false);
});
test("concurrent paper journal operations are serialized and persisted",async t=>{
 const f=await fixture(t);
 const store=createPaperTradingStore({filePath:f.filePath,clock:f.clock});
 await store.init();
 await Promise.all(Array.from({length:12},(_,i)=>store.recordSnapshot({source:"market.example",symbol:"7203",capturedAt:f.clock(),price:1000+i})));
 const restarted=createPaperTradingStore({filePath:f.filePath,clock:f.clock});
 const state=await restarted.init();
 assert.equal(state.eventCount,12);
 assert.equal((await restarted.listSnapshots({limit:20})).length,12);
});
test("corrupt journal fails closed instead of silently resetting history",async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.filePath,'{"type":"snapshot"}\nnot-json\n');
 const store=createPaperTradingStore({filePath:f.filePath,clock:f.clock});
 await assert.rejects(store.init(),/invalid event at line 1/);
});
test("journal requires an absolute path",()=>{
 assert.throws(()=>createPaperTradingStore({filePath:"relative.jsonl"}),/absolute/);
});

test("paper journal enforces its byte cap before every append",async t=>{
 const f=await fixture(t);
 const store=createPaperTradingStore({filePath:f.filePath,clock:f.clock,maxJournalBytes:1024});
 await store.init();
 let blocked=false;
 for(let i=0;i<20;i++){
  try{await store.recordSnapshot({source:"market.example",symbol:"7203",capturedAt:f.clock(),price:1000+i});}
  catch(error){assert.match(error.message,/size limit reached/);blocked=true;break;}
 }
 assert.equal(blocked,true);
 const rows=await store.listSnapshots({limit:100});
 assert.ok(rows.length>0&&rows.length<20);
});
