"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {createApprovalStore}=require("./approval-store");

async function tempStore(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"one-approval-"));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return path.join(dir,"approvals.jsonl");
}

test("approval journal persists decisions and recovers them after restart",async t=>{
 const filePath=await tempStore(t),clock=()=> "2026-11-16T00:00:00.000Z";
 const first=createApprovalStore({filePath,clock});
 const created=await first.create({departmentId:"content",actionClass:"publish",summary:"江戸大名動画の公開",details:"公開前の最終確認",idempotencyKey:"publish-001"});
 assert.equal(created.created,true);assert.equal(created.approval.status,"pending");assert.equal(created.approval.executionStatus,"not_started");
 const decided=await first.decide(created.approval.id,"approved",{reason:"内容を確認"});
 assert.equal(decided.status,"approved");assert.equal(decided.executionStatus,"not_started");
 const second=createApprovalStore({filePath,clock});
 const recovered=await second.get(created.approval.id);
 assert.equal(recovered.status,"approved");assert.equal(recovered.decisionReason,"内容を確認");
});

test("approval requests are idempotent and only pending requests can be decided",async t=>{
 const filePath=await tempStore(t),store=createApprovalStore({filePath});
 const input={departmentId:"office",actionClass:"external_submit",summary:"補助金申請の提出",idempotencyKey:"grant-001"};
 const a=await store.create(input),b=await store.create(input);
 assert.equal(a.created,true);assert.equal(b.created,false);assert.equal(a.approval.id,b.approval.id);
 await assert.rejects(store.create({...input,summary:"別の操作"}),/idempotency key conflict/);
 await store.decide(a.approval.id,"rejected");
 await assert.rejects(()=>store.decide(a.approval.id,"approved"),/already been decided/);
 assert.equal((await store.list({status:"rejected"})).length,1);
});

test("approval store rejects malformed requests and journal corruption",async t=>{
 const filePath=await tempStore(t),store=createApprovalStore({filePath});
 await assert.rejects(()=>store.create({departmentId:"../admin",actionClass:"publish",summary:"x"}),/Invalid department/);
 await assert.rejects(()=>store.create({departmentId:"content",actionClass:"unknown-action",summary:"x"}),/Invalid approval action/);
 await assert.rejects(()=>store.create({departmentId:"content",actionClass:"publish",summary:" "}),/Invalid approval request/);
 await fs.writeFile(filePath,"not-json\n");
 const broken=createApprovalStore({filePath});
 await assert.rejects(()=>broken.init(),/corrupt/);
});

test("approval execution is bound to resource, exact payload, expiry, and one authorized claim",async t=>{
 const filePath=await tempStore(t),clock=()=> "2026-11-17T00:00:00.000Z";
 const store=createApprovalStore({filePath,clock,authorizeActor:async actor=>actor==="owner-api"});
 const payload={videoId:"V104",destination:"youtube",operation:"publish"};
 const created=await store.create({departmentId:"content",actionClass:"publish",summary:"Publish V104",resourceId:"V104",operationPayload:payload,expiresAt:"2026-11-17T01:00:00.000Z"});
 const approved=await store.decide(created.approval.id,"approved",{reason:"reviewed",actor:"owner-api"});
 assert.equal(approved.decidedBy,"owner-api");
 await assert.rejects(store.verifyExecutionRequest(approved.id,{resourceId:"V105",operationPayload:payload}),/integrity/);
 await assert.rejects(store.verifyExecutionRequest(approved.id,{resourceId:"V104",operationPayload:{...payload,destination:"other"}}),/integrity/);
 assert.equal((await store.verifyExecutionRequest(approved.id,{resourceId:"V104",operationPayload:payload})).ok,true);
 await assert.rejects(store.claimExecution(approved.id,{resourceId:"V104",operationPayload:payload,actor:"untrusted"}),/not authorized/);
 const claimed=await store.claimExecution(approved.id,{resourceId:"V104",operationPayload:payload,actor:"owner-api"});
 assert.equal(claimed.executionStatus,"claimed");
 assert.equal((await store.validateExecutionClaim(approved.id,{claimId:claimed.executionClaim.id,resourceId:"V104",operationPayload:payload,actor:"owner-api"})).ok,true);
 await assert.rejects(store.validateExecutionClaim(approved.id,{claimId:claimed.executionClaim.id,resourceId:"V105",operationPayload:payload,actor:"owner-api"}),/integrity/);
 await assert.rejects(store.claimExecution(approved.id,{resourceId:"V104",operationPayload:payload,actor:"owner-api"}),/already been claimed/);
});

test("expired approvals cannot be decided or claimed",async t=>{
 const filePath=await tempStore(t);let now="2026-11-17T00:00:00.000Z";
 const store=createApprovalStore({filePath,clock:()=>now,authorizeActor:async()=>true});
 const created=await store.create({departmentId:"content",actionClass:"publish",summary:"Expired",resourceId:"V1",operationPayload:{id:"V1"},expiresAt:"2026-11-17T00:00:01.000Z"});
 now="2026-11-17T00:00:02.000Z";
 await assert.rejects(store.decide(created.approval.id,"approved"),/expired/);
});

test("approval execution outcomes are finalized once and expiry is recorded",async t=>{
 const filePath=await tempStore(t);let now="2026-11-17T00:00:00.000Z";
 const store=createApprovalStore({filePath,clock:()=>now,authorizeActor:async actor=>actor==="owner-api"});
 const payload={resourceId:"R-1",operation:"internal-test"};
 const created=await store.create({departmentId:"content",actionClass:"publish",summary:"Test execution",resourceId:"R-1",operationPayload:payload,expiresAt:"2026-11-17T01:00:00.000Z"});
 await store.decide(created.approval.id,"approved",{actor:"owner-api"});
 const claim=await store.claimExecution(created.approval.id,{resourceId:"R-1",operationPayload:payload,actor:"owner-api"});
 const finished=await store.finishExecution(created.approval.id,{claimId:claim.executionClaim.id,actor:"owner-api",outcome:"failed",reason:"Simulated failure"});
 assert.equal(finished.executionStatus,"failed");
 await assert.rejects(store.finishExecution(created.approval.id,{claimId:claim.executionClaim.id,actor:"owner-api",outcome:"succeeded"}),/not active/);
 const exp=await store.create({departmentId:"content",actionClass:"publish",summary:"Will expire",resourceId:"R-2",operationPayload:{id:"R-2"},expiresAt:"2026-11-17T00:00:01.000Z"});
 await store.decide(exp.approval.id,"approved",{actor:"owner-api"});
 now="2026-11-17T00:00:02.000Z";
 assert.equal((await store.expireExecution(exp.approval.id)).executionStatus,"expired");
});
