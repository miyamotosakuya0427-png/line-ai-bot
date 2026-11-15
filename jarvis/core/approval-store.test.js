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
