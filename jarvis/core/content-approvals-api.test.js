"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("./server");
const token="a".repeat(64);

function store(){
 const jobs=[];
 return {
  async create(value){
   const prior=value.idempotencyKey?jobs.find(x=>x.idempotencyKey===value.idempotencyKey):null;
   if(prior)return {created:false,job:prior};
   const job={id:"00000000-0000-4000-8000-"+String(jobs.length+1).padStart(12,"0"),...value,status:"queued",createdAt:new Date().toISOString()};
   jobs.push(job);return {created:true,job};
  },
  async get(id){return jobs.find(x=>x.id===id)||null;},
  async list(){return jobs.slice();}
 };
}

test("content approvals API authenticates requests and persists an exact-target decision without side effects",async()=>{
 const jobStore=store();
 const app=createServer({token,jobStore});
 await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+app.address().port;
 const auth={Authorization:"Bearer "+token,"Content-Type":"application/json"};
 try{
  const denied=await fetch(base+"/v1/content/approvals");
  assert.equal(denied.status,401);
  const created=await fetch(base+"/v1/content/approvals",{method:"POST",headers:auth,body:JSON.stringify({actionType:"publish",description:"公開前の動画V01",target:"youtube://channel/video/V01",idempotencyKey:"video-v01-publish"})});
  assert.equal(created.status,201);
  const request=(await created.json()).approval;
  assert.equal(request.type,"content.approval_request");
  const pending=await fetch(base+"/v1/content/approvals",{headers:auth});
  assert.equal((await pending.json()).approvals[0].status,"pending");
  const decision=await fetch(base+"/v1/content/approvals/"+request.id+"/decision",{method:"POST",headers:auth,body:JSON.stringify({approved:true,reason:"内容確認済み"})});
  const decisionBody=await decision.json();
  assert.equal(decision.status,201);
  assert.equal(decisionBody.sideEffectsExecuted,false);
  const finalList=await fetch(base+"/v1/content/approvals",{headers:auth});
  const item=(await finalList.json()).approvals[0];
  assert.equal(item.status,"decided");
  assert.equal(item.decision.approved,true);
  const second=await fetch(base+"/v1/content/approvals/"+request.id+"/decision",{method:"POST",headers:auth,body:JSON.stringify({approved:false})});
  assert.equal(second.status,500);
 }finally{await new Promise(resolve=>app.close(resolve));}
});
