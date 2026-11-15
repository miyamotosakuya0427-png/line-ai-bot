"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createApprovalRequest,listApprovals,decideApproval,validateRequest}=require("./content-approvals");

function fakeStore(){
 const jobs=[];
 return {
  jobs,
  async create(value){
   const existing=value.idempotencyKey?jobs.find(job=>job.idempotencyKey===value.idempotencyKey):null;
   if(existing)return {created:false,job:existing};
   const job={id:String(jobs.length+1).padStart(8,"0")+"-1111-4111-8111-111111111111",...value,status:"queued",createdAt:new Date().toISOString()};
   jobs.push(job);return {created:true,job};
  },
  async get(id){return jobs.find(job=>job.id===id)||null;},
  async list(){return jobs.slice();}
 };
}

test("approval requests validate scope and bind approval to an immutable target hash",async()=>{
 const store=fakeStore();
 const result=await createApprovalRequest(store,{actionType:"publish",description:"動画V01を公開",target:"youtube://channel/video/V01",idempotencyKey:"req-v01"});
 assert.equal(result.created,true);
 assert.equal(result.job.type,"content.approval_request");
 assert.equal(result.job.payload.state,"pending");
 assert.equal(result.job.payload.sideEffectsEnabled,false);
 assert.match(result.job.payload.targetSha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>validateRequest({actionType:"publish",description:"x",target:""}),/target/);
 assert.throws(()=>validateRequest({actionType:"unknown",description:"x",target:"y"}),/Unsupported/);
});

test("approval decisions are durable, bound to the requested target and never execute side effects",async()=>{
 const store=fakeStore();
 const request=await createApprovalRequest(store,{actionType:"paid_generation",description:"Hinata narration generation",target:"asset:V01:voice-v1"});
 const decision=await decideApproval(store,request.job.id,{approved:true,reason:"内容を確認"});
 assert.equal(decision.created,true);
 assert.equal(decision.job.type,"content.approval_decision");
 assert.equal(decision.job.payload.approved,true);
 assert.equal(decision.job.payload.targetSha256,request.job.payload.targetSha256);
 assert.equal(decision.job.payload.sideEffectsEnabled,false);
 assert.equal((await listApprovals(store))[0].status,"decided");
 await assert.rejects(()=>decideApproval(store,request.job.id,{approved:false}),/already been decided/);
});

test("approval list shows pending requests and decisions cannot target unrelated jobs",async()=>{
 const store=fakeStore();
 const request=await createApprovalRequest(store,{actionType:"external_upload",description:"Upload draft",target:"youtube:unlisted"});
 assert.equal((await listApprovals(store))[0].status,"pending");
 await assert.rejects(()=>decideApproval(store,"99999999-1111-4111-8111-111111111111",{approved:true}),/not found/);
 await assert.rejects(()=>decideApproval(store,request.job.id,{approved:"yes"}),/approved=true/);
});
