"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createCommandCenter}=require("./command-center");
const {createJobStore}=require("./job-store");
const {createApprovalStore}=require("./approval-store");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");

test("command center fans safe work out to selected departments idempotently",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-cc-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
 const cc=createCommandCenter({jobStore,worker:{},clock:()=>"2026-11-16T03:00:00Z"});
 const first=await cc.dispatch({request:"今月の売上と経費を確認",departmentIds:["management","tax"],actionClass:"analyze",idempotencyKey:"month-close-01"});
 assert.equal(first.results.length,2);assert.equal(first.results[0].status,"queued");assert.equal(first.results[1].status,"queued");
 const duplicate=await cc.dispatch({request:"今月の売上と経費を確認",departmentIds:["management","tax"],actionClass:"analyze",idempotencyKey:"month-close-01"});
 assert.equal(duplicate.results.every(x=>x.created===false),true);
 const view=await cc.snapshot();assert.equal(view.jobSample.counts.queued,2);assert.equal(view.departments.find(x=>x.id==="tax").recentJobs,1);
});
test("command center routes sensitive actions to approval and never queues them",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-cc-approval-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
 const approvalStore=createApprovalStore({filePath:path.join(dir,"approvals.jsonl")});
 const cc=createCommandCenter({jobStore,approvalStore});
 const result=await cc.dispatch({request:"補助金の申請を提出",departmentIds:["office"],actionClass:"external_submit",idempotencyKey:"subsidy-apply-01"});
 assert.equal(result.results[0].status,"awaiting_owner_approval");
 assert.equal((await jobStore.list({limit:20})).length,0);
 assert.equal((await approvalStore.list({status:"pending"})).length,1);
 assert.equal(result.externalActionsEnabled,false);
});
test("command center rejects unknown departments, duplicate IDs, and malformed requests",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-cc-invalid-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
 const cc=createCommandCenter({jobStore});
 const unknown=await cc.dispatch({request:"test",departmentIds:["unknown"]});assert.equal(unknown.results[0].status,"blocked");assert.equal(unknown.results[0].reason,"UNKNOWN_DEPARTMENT");
 await assert.rejects(cc.dispatch({request:"test",departmentIds:["tax","tax"]}),/Duplicate/);
 await assert.rejects(cc.dispatch({request:"",departmentIds:["tax"]}),/Task request/);
});

test("approval-only dispatch works without a job queue",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-cc-approval-only-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const approvalStore=createApprovalStore({filePath:path.join(dir,"approvals.jsonl")});
 const cc=createCommandCenter({approvalStore});
 const result=await cc.dispatch({request:"行政申請の提出",departmentIds:["office"],actionClass:"external_submit"});
 assert.equal(result.results[0].status,"awaiting_owner_approval");
 assert.equal((await approvalStore.list({status:"pending"})).length,1);
 await assert.rejects(cc.dispatch({request:"社内分析",departmentIds:["management"],actionClass:"analyze"}),error=>error.statusCode===503);
});
\n
test("department readiness reflects actual registered handlers",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-cc-readiness-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
 const cc=createCommandCenter({jobStore,worker:{},departmentHandlers:{"department.tax":async()=>({ok:true})}});
 const view=await cc.snapshot();
 assert.equal(view.departments.find(x=>x.id==="tax").runtimeConfigured,true);
 assert.equal(view.departments.find(x=>x.id==="management").runtimeConfigured,false);
});
\ntest("command center reports disabled dependencies honestly",async()=>{
 const cc=createCommandCenter();
 const view=await cc.snapshot();
 assert.equal(view.execution.queueConfigured,false);assert.equal(view.execution.workerConfigured,false);
 assert.equal(view.execution.externalActionsEnabled,false);assert.equal(view.jobSample.mayBePartial,false);
});
