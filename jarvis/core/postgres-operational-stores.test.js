"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPostgresOperationalStores}=require("./postgres-operational-stores");

function fakePool(){
 const state={events:[],released:0,rowLocks:new Set()};
 async function query(sql,p=[]){
  if(sql==="COMMIT"||sql==="ROLLBACK"){state.rowLocks.clear();return{rows:[]};}
  if(sql.includes("FOR UPDATE SKIP LOCKED")){const now=Date.parse(p[0]);const latest=new Map();for(const e of state.events.filter(x=>x.aggregate_type==="job")){const old=latest.get(e.aggregate_id);if(!old||old.aggregate_version<e.aggregate_version)latest.set(e.aggregate_id,e);}const candidate=[...latest.values()].filter(e=>(e.payload.status==="queued"||(e.payload.status==="running"&&Date.parse(e.payload.lease?.expiresAt||0)<=now))&&!state.rowLocks.has(e.aggregate_id)).sort((a,b)=>a.payload.createdAt.localeCompare(b.payload.createdAt))[0];if(!candidate)return{rows:[]};state.rowLocks.add(candidate.aggregate_id);return{rows:[{aggregate_id:candidate.aggregate_id,payload:candidate.payload}]};}
  if(sql.includes("COALESCE(MAX(aggregate_version)")){const a=state.events.filter(x=>x.aggregate_type===p[0]&&x.aggregate_id===p[1]);return{rows:[{v:a.reduce((n,x)=>Math.max(n,x.aggregate_version),0)}]};}
  if(sql.includes("count(DISTINCT aggregate_id)")){return{rows:[{n:new Set(state.events.filter(x=>x.aggregate_type===p[0]).map(x=>x.aggregate_id)).size}]};}
  if(sql.includes("aggregate_type='job' AND aggregate_id=(SELECT aggregate_id")){const first=state.events.find(x=>x.aggregate_type==="job"&&x.payload.idempotencyKey===p[0]);const x=first?state.events.filter(y=>y.aggregate_type==="job"&&y.aggregate_id===first.aggregate_id).at(-1):null;return{rows:x?[{payload:x.payload}]:[]};}
  if(sql.includes("aggregate_type='approval' AND aggregate_id=(SELECT aggregate_id")){const first=state.events.find(x=>x.aggregate_type==="approval"&&x.payload.idempotencyKey===p[0]);const x=first?state.events.filter(y=>y.aggregate_type==="approval"&&y.aggregate_id===first.aggregate_id).at(-1):null;return{rows:x?[{payload:x.payload}]:[]};}
  if(sql.includes("aggregate_type='job' AND aggregate_id=$1")){const x=state.events.filter(x=>x.aggregate_type==="job"&&x.aggregate_id===p[0]).at(-1);return{rows:x?[{payload:x.payload}]:[]};}
  if(sql.includes("aggregate_type='approval' AND aggregate_id=$1")){const x=state.events.filter(x=>x.aggregate_type==="approval"&&x.aggregate_id===p[0]).at(-1);return{rows:x?[{payload:x.payload}]:[]};}
  if(sql.includes("ORDER BY aggregate_version DESC LIMIT 1")){const x=state.events.filter(x=>x.aggregate_type===p[0]&&x.aggregate_id===p[1]).at(-1);return{rows:x?[{payload:x.payload}]:[]};}
  if(sql.includes("SELECT payload FROM (SELECT DISTINCT ON")){const latest=new Map();for(const e of state.events.filter(x=>x.aggregate_type===p[0]))latest.set(e.aggregate_id,e);return{rows:[...latest.values()].map(x=>x.payload).filter(x=>!p[1]||x.status===p[1]).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,p[2]).map(payload=>({payload}))};}
  if(sql.startsWith("INSERT INTO jarvis.events")){state.events.push({aggregate_type:p[0],aggregate_id:p[1],aggregate_version:p[2],event_type:p[3],payload:JSON.parse(p[4]),idempotency_key:p[5],created_at:p[6]});return{rows:[],rowCount:1};}
  return{rows:[{n:0}],rowCount:0};
 }
 return{state,async connect(){return{query,release(){state.released++;}}},query,async end(){}};
}

test("PostgreSQL job store preserves create/get/idempotency/list/transition contract",async()=>{
 const pool=fakePool(),{jobs}=createPostgresOperationalStores({pool,clock:()=>"2026-11-17T00:00:00.000Z"});
 await jobs.init();
 const a=await jobs.create({type:"report.generate",payload:{date:"2026-11-17"},idempotencyKey:"daily"});
 const b=await jobs.create({type:"report.generate",payload:{date:"2026-11-17"},idempotencyKey:"daily"});
 assert.equal(a.created,true);assert.equal(b.created,false);assert.equal(a.job.id,b.job.id);
 const running=await jobs.transition(a.job.id,"running");
 assert.equal(running.attempts,1);
 const done=await jobs.transition(a.job.id,"succeeded",{result:{ok:true}});
 assert.equal(done.status,"succeeded");
 assert.equal((await jobs.get(a.job.id)).result.ok,true);
 assert.equal((await jobs.getByIdempotencyKey("daily")).status,"succeeded");
 assert.equal((await jobs.create({type:"report.generate",payload:{date:"2026-11-17"},idempotencyKey:"daily"})).job.status,"succeeded");
 assert.equal((await jobs.list({status:"succeeded"})).length,1);
});

test("PostgreSQL job store rejects invalid transitions and payloads",async()=>{
 const {jobs}=createPostgresOperationalStores({pool:fakePool()});
 await assert.rejects(jobs.create({type:"bad type",payload:{}}),/Invalid job type/);
 await assert.rejects(jobs.create({type:"task.run",payload:[]}),/payload/);
 const job=(await jobs.create({type:"task.run",payload:{}})).job;
 await assert.rejects(jobs.transition(job.id,"succeeded"),/transition/);
});

test("PostgreSQL approval store persists decision actor and verifies request digest",async()=>{
 const pool=fakePool(),{approvals}=createPostgresOperationalStores({pool,clock:()=>"2026-11-17T00:00:00.000Z"});
 await approvals.init();
 const a=await approvals.create({departmentId:"content",actionClass:"publish",summary:"Publish video",details:"approved draft",idempotencyKey:"publish-1"});
 const duplicate=await approvals.create({departmentId:"content",actionClass:"publish",summary:"Publish video",details:"approved draft",idempotencyKey:"publish-1"});
 assert.equal(a.created,true);assert.equal(duplicate.created,false);
 await assert.rejects(approvals.create({departmentId:"content",actionClass:"publish",summary:"Changed operation",details:"approved draft",idempotencyKey:"publish-1"}),/idempotency key conflict/);
 const decided=await approvals.decide(a.approval.id,"approved",{reason:"reviewed",actor:"owner-api"});
 assert.equal(decided.status,"approved");assert.equal(decided.decidedBy,"owner-api");
 assert.equal((await approvals.create({departmentId:"content",actionClass:"publish",summary:"Publish video",details:"approved draft",idempotencyKey:"publish-1"})).approval.status,"approved");
 await assert.rejects(approvals.decide(a.approval.id,"rejected"),/already been decided/);
});

test("PostgreSQL approval store rejects malformed requests",async()=>{
 const {approvals}=createPostgresOperationalStores({pool:fakePool()});
 await assert.rejects(approvals.create({departmentId:"../admin",actionClass:"publish",summary:"x"}),/department/);
 await assert.rejects(approvals.create({departmentId:"content",actionClass:"invalid",summary:"x"}),/action/);
});

test("PostgreSQL job claims are exclusive, renewable, and reclaimable after lease expiry",async()=>{
 let now="2026-11-17T00:00:00.000Z";const pool=fakePool(),{jobs}=createPostgresOperationalStores({pool,clock:()=>now});
 const {job}=await jobs.create({type:"task.claim",payload:{}});
 const claims=await Promise.all([jobs.claimNext({workerId:"worker-a",leaseMs:5000}),jobs.claimNext({workerId:"worker-b",leaseMs:5000})]);
 assert.equal(claims.filter(Boolean).length,1);
 const first=claims.find(Boolean),owner=first.lease.owner;
 assert.equal(first.attempts,1);
 const renewed=await jobs.heartbeat(job.id,{workerId:owner,leaseMs:5000});
 assert.equal(renewed.lease.owner,owner);
 now="2026-11-17T00:00:06.000Z";
 const reclaimed=await jobs.claimNext({workerId:"worker-c",leaseMs:5000});
 assert.equal(reclaimed.id,job.id);assert.equal(reclaimed.attempts,2);assert.equal(reclaimed.lease.owner,"worker-c");
 await assert.rejects(jobs.heartbeat(job.id,{workerId:owner,leaseMs:5000}),/lease/);
 await assert.rejects(jobs.transition(job.id,"succeeded",{leaseOwner:owner}),/lease/);
 const retry=await jobs.transition(job.id,"queued",{leaseOwner:"worker-c"});assert.equal(retry.status,"queued");
 const retried=await jobs.claimNext({workerId:"worker-d",leaseMs:5000});assert.equal(retried.attempts,3);
 const completed=await jobs.transition(job.id,"succeeded",{leaseOwner:"worker-d",result:{ok:true}});
 assert.equal(completed.status,"succeeded");assert.equal(completed.lease,undefined);
});

test("PostgreSQL approvals bind immutable target, payload, expiry, and authorized one-time execution claim",async()=>{
 const pool=fakePool(),{approvals}=createPostgresOperationalStores({pool,clock:()=>"2026-11-17T00:00:00.000Z",authorizeActor:async actor=>actor==="owner-api"});
 const payload={videoId:"V205",destination:"youtube",operation:"publish"};
 const created=await approvals.create({departmentId:"content",actionClass:"publish",summary:"Publish V205",resourceId:"V205",operationPayload:payload,expiresAt:"2026-11-17T01:00:00.000Z"});
 const decided=await approvals.decide(created.approval.id,"approved",{actor:"owner-api"});
 assert.equal(decided.decidedBy,"owner-api");
 await assert.rejects(approvals.verifyExecutionRequest(decided.id,{resourceId:"V206",operationPayload:payload}),/integrity/);
 assert.equal((await approvals.verifyExecutionRequest(decided.id,{resourceId:"V205",operationPayload:{operation:"publish",destination:"youtube",videoId:"V205"}})).ok,true);
 await assert.rejects(approvals.claimExecution(decided.id,{resourceId:"V205",operationPayload:payload,actor:"guest"}),/not authorized/);
 const claimed=await approvals.claimExecution(decided.id,{resourceId:"V205",operationPayload:{operation:"publish",destination:"youtube",videoId:"V205"},actor:"owner-api"});
 assert.equal(claimed.executionStatus,"claimed");
 assert.equal((await approvals.validateExecutionClaim(decided.id,{claimId:claimed.executionClaim.id,resourceId:"V205",operationPayload:payload,actor:"owner-api"})).ok,true);
 await assert.rejects(approvals.validateExecutionClaim(decided.id,{claimId:claimed.executionClaim.id,resourceId:"V206",operationPayload:payload,actor:"owner-api"}),/integrity/);
 await assert.rejects(approvals.claimExecution(decided.id,{resourceId:"V205",operationPayload:payload,actor:"owner-api"}),/already been claimed/);
});

test("PostgreSQL approval execution outcomes are finalized and expired exactly once",async()=>{
 let now="2026-11-17T00:00:00.000Z";
 const {approvals}=createPostgresOperationalStores({pool:fakePool(),clock:()=>now,authorizeActor:async actor=>actor==="owner-api"});
 const payload={resourceId:"R-1",operation:"internal-test"};
 const created=await approvals.create({departmentId:"content",actionClass:"publish",summary:"Test execution",resourceId:"R-1",operationPayload:payload,expiresAt:"2026-11-17T01:00:00.000Z"});
 await approvals.decide(created.approval.id,"approved",{actor:"owner-api"});
 const claim=await approvals.claimExecution(created.approval.id,{resourceId:"R-1",operationPayload:payload,actor:"owner-api"});
 const finished=await approvals.finishExecution(created.approval.id,{claimId:claim.executionClaim.id,actor:"owner-api",outcome:"succeeded"});
 assert.equal(finished.executionStatus,"succeeded");
 await assert.rejects(approvals.finishExecution(created.approval.id,{claimId:claim.executionClaim.id,actor:"owner-api",outcome:"failed"}),/not active/);
 const exp=await approvals.create({departmentId:"content",actionClass:"publish",summary:"Will expire",resourceId:"R-2",operationPayload:{id:"R-2"},expiresAt:"2026-11-17T00:00:01.000Z"});
 await approvals.decide(exp.approval.id,"approved",{actor:"owner-api"});
 now="2026-11-17T00:00:02.000Z";
 assert.equal((await approvals.expireExecution(exp.approval.id)).executionStatus,"expired");
});
