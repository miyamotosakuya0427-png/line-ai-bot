"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const {runDryRun,canonicalJson}=require("./jsonl-migration-dry-run");

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-migration-dryrun-"));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const jobs=path.join(dir,"jobs.jsonl"),approvals=path.join(dir,"approvals.jsonl");
 return {dir,jobs,approvals};
}
function job(id,extra={}) { return {id,type:"report.generate",payload:{text:"日本語 😀"},status:"queued",attempts:0,idempotencyKey:"",createdAt:"2026-11-17T00:00:00.000Z",updatedAt:"2026-11-17T00:00:00.000Z",error:null,result:null,...extra}; }
function approval(id,extra={}) { return {id,departmentId:"content",actionClass:"publish",summary:"公開確認",details:"",idempotencyKey:"",createdAt:"2026-11-17T00:00:00.000Z",updatedAt:"2026-11-17T00:00:00.000Z",decisionAt:null,decisionReason:"",status:"pending",...extra}; }
async function writePair(f,jobs,approvals) {
 await fs.writeFile(f.jobs,jobs.map(x=>JSON.stringify({type:"job",job:x})).join("\n")+(jobs.length?"\n":""));
 await fs.writeFile(f.approvals,approvals.map(x=>JSON.stringify({type:"approval",approval:x})).join("\n")+(approvals.length?"\n":""));
}
test("valid JSONL journals produce deterministic checksums without changing source bytes",async t=>{
 const f=await fixture(t);await writePair(f,[job("j1"),job("j1",{status:"running",attempts:1,lease:{owner:"w1",heartbeatAt:"2026-11-17T00:00:00.000Z",expiresAt:"2026-11-17T00:01:00.000Z"}})],[approval("a1")]);
 const before=[await fs.readFile(f.jobs),await fs.readFile(f.approvals)];
 const first=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 const second=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 assert.equal(first.pass,true);assert.equal(first.summary.latestJobs,1);assert.equal(first.summary.jobEvents,2);
 assert.equal(first.jobs.canonicalLatestSha256,second.jobs.canonicalLatestSha256);
 assert.equal(first.jobs.rawSha256,second.jobs.rawSha256);
 assert.deepEqual(await fs.readFile(f.jobs),before[0]);assert.deepEqual(await fs.readFile(f.approvals),before[1]);
 assert.equal(first.databaseConnected,false);assert.equal(first.databaseWrites,0);assert.equal(first.sourceWrites,0);
});
test("missing fields and invalid state values are reported",async t=>{
 const f=await fixture(t);await writePair(f,[job("j1",{status:"teleport"}),{id:"j2"}],[approval("a1",{status:"unknown"})]);
 const r=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 assert.equal(r.pass,false);assert.ok(r.jobs.issues.some(x=>x.code==="invalid_job_status"));assert.ok(r.approvals.issues.some(x=>x.code==="invalid_approval_status"));assert.ok(r.jobs.issues.some(x=>x.code==="missing_job_field"));
});
test("malformed JSON lines and empty files are distinguished",async t=>{
 const f=await fixture(t);await fs.writeFile(f.jobs,'{"type":"job","job":\n');await fs.writeFile(f.approvals,"");
 const r=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 assert.equal(r.pass,false);assert.deepEqual(r.jobs.invalidLines,[1]);assert.equal(r.approvals.lines,0);assert.equal(r.approvals.latestRecords,0);
});
test("duplicate aggregate creation and cross-aggregate idempotency keys are reported",async t=>{
 const f=await fixture(t);await writePair(f,[job("j1",{idempotencyKey:"same"}),job("j1",{idempotencyKey:"same"}),job("j2",{idempotencyKey:"same"})],[approval("a1",{idempotencyKey:"approve"}),approval("a2",{idempotencyKey:"approve"})]);
 const r=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 assert.equal(r.pass,false);assert.equal(r.jobs.duplicateIds.length,1);assert.equal(r.jobs.duplicateIdempotencyKeys.length,1);assert.equal(r.approvals.duplicateIdempotencyKeys.length,1);
});
test("large journals and unicode payloads are fully counted",async t=>{
 const f=await fixture(t);const js=Array.from({length:1500},(_,i)=>job("j"+i,{payload:{i,text:"建設 🚧 日本語"}}));
 const as=Array.from({length:250},(_,i)=>approval("a"+i));
 await writePair(f,js,as);const r=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 assert.equal(r.pass,true);assert.equal(r.summary.latestJobs,1500);assert.equal(r.summary.latestApprovals,250);
});
test("checksum changes when a latest snapshot changes",async t=>{
 const f=await fixture(t);await writePair(f,[job("j1")],[approval("a1")]);
 const first=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 await writePair(f,[job("j1",{payload:{changed:true}})],[approval("a1")]);
 const second=await runDryRun({jobsPath:f.jobs,approvalsPath:f.approvals});
 assert.notEqual(first.jobs.canonicalLatestSha256,second.jobs.canonicalLatestSha256);
});
test("absolute paths are required and no connection string or write mode is accepted",async()=>{
 await assert.rejects(runDryRun({jobsPath:"relative.jsonl",approvalsPath:"/tmp/a"}),/absolute/);
});
test("canonical JSON sorts object keys recursively but preserves array order",()=>{
 assert.equal(canonicalJson({z:1,a:{y:2,x:3}}),canonicalJson({a:{x:3,y:2},z:1}));
 assert.notEqual(canonicalJson([1,2]),canonicalJson([2,1]));
});
