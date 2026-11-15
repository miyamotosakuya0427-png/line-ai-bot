"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const http=require("node:http");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {createServer}=require("./server");
const {createInfluenceEventStore}=require("./core/influence-event-store");

const token="test-token-".padEnd(40,"x");
const event={platform:"truth_social",actor:"Donald Trump",handle:"@realDonaldTrump",sourceId:"truth-123",postedAt:"2026-11-16T00:00:00.000Z",sourceUrl:"https://truthsocial.com/@realDonaldTrump/posts/123",verification:"unverified",text:"Policy announcement."};
async function withServer(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-influence-api-"));
 const store=createInfluenceEventStore({filePath:path.join(dir,"events.jsonl")});await store.init();
 const server=createServer({token,influenceEventStore:store});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{await fn("http://127.0.0.1:"+server.address().port);}finally{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
}
test("influence API requires bearer authorization",async()=>withServer(async base=>{
 const r=await fetch(base+"/v1/signals/influence/events");assert.equal(r.status,401);
}));
test("influence API stores and lists source-backed events without enabling trades",async()=>withServer(async base=>{
 const headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"};
 const post=await fetch(base+"/v1/signals/influence/events",{method:"POST",headers,body:JSON.stringify(event)});
 assert.equal(post.status,201);const created=await post.json();assert.equal(created.analysisQueued,false);assert.equal(created.realMoneyTradingEnabled,false);
 const duplicate=await fetch(base+"/v1/signals/influence/events",{method:"POST",headers,body:JSON.stringify(event)});assert.equal((await duplicate.json()).created,false);
 const get=await fetch(base+"/v1/signals/influence/events?platform=truth_social");const listed=await get.json();assert.equal(listed.events.length,1);assert.equal(listed.events[0].actor,"Donald Trump");
}));
