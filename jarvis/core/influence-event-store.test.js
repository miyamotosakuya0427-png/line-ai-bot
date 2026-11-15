"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {createInfluenceEventStore,normalizeInfluenceEvent}=require("./influence-event-store");

const event={platform:"x",actor:"Elon Musk",handle:"@elonmusk",sourceId:"post-1",postedAt:"2026-11-16T00:00:00.000Z",sourceUrl:"https://x.com/elonmusk/status/1",verification:"official_api",text:"Market relevant announcement."};
test("normalizes provenance and stable id",()=>{const a=normalizeInfluenceEvent(event,"2026-11-16T00:01:00Z");const b=normalizeInfluenceEvent(event,"2026-11-16T00:02:00Z");assert.equal(a.id,b.id);assert.equal(a.verification,"official_api");assert.equal(a.observedAt,"2026-11-16T00:01:00Z");});
test("rejects unsafe or incomplete source records",()=>{assert.throws(()=>normalizeInfluenceEvent({...event,sourceUrl:"http://x.com/a"}),/HTTPS/);assert.throws(()=>normalizeInfluenceEvent({...event,verification:"trusted"}),/verification/);assert.throws(()=>normalizeInfluenceEvent({...event,text:""}),/text/);});
test("persists, deduplicates, filters and recovers",async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-influence-"));const file=path.join(dir,"events.jsonl");try{const first=createInfluenceEventStore({filePath:file,clock:()=> "2026-11-16T00:03:00Z"});await first.init();const a=await first.add(event);const duplicate=await first.add(event);assert.equal(a.created,true);assert.equal(duplicate.created,false);const recovered=createInfluenceEventStore({filePath:file});await recovered.init();const rows=await recovered.list({platform:"x",limit:10});assert.equal(rows.length,1);assert.equal(rows[0].id,a.event.id);assert.equal(await recovered.count(),1);}finally{await fs.rm(dir,{recursive:true,force:true});}});
test("rejects corrupted journal",async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-influence-bad-"));const file=path.join(dir,"events.jsonl");try{await fs.writeFile(file,"not-json\n");const store=createInfluenceEventStore({filePath:file});await assert.rejects(store.init(),/corrupt at line 1/);}finally{await fs.rm(dir,{recursive:true,force:true});}});

test("requires timezone-qualified ISO timestamps and safe source URLs",()=>{
 assert.throws(()=>normalizeInfluenceEvent({...event,postedAt:"2026-11-16"}),/post timestamp/);
 assert.throws(()=>normalizeInfluenceEvent(event,"not-a-time"),/observation timestamp/);
 assert.throws(()=>normalizeInfluenceEvent({...event,sourceUrl:"https://user:pass@x.com/post"}),/credential-free HTTPS/);
 assert.throws(()=>normalizeInfluenceEvent({...event,sourceId:"x".repeat(201)}),/Source ID is too long/);
});
test("does not exceed the configured journal byte limit",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-influence-limit-"));const file=path.join(dir,"events.jsonl");
 try{const store=createInfluenceEventStore({filePath:file,maxJournalBytes:1024});await store.init();await assert.rejects(store.add({...event,text:"x".repeat(1100)}),/size limit reached/);assert.equal(await store.count(),0);}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
