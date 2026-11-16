"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPostgresOperationalStores}=require("./postgres-operational-stores");

function fakePool(){
 const state={events:[],released:0};
 async function query(sql,p=[]){
  if(sql.includes("COALESCE(MAX(aggregate_version)")){const a=state.events.filter(x=>x.aggregate_type===p[0]&&x.aggregate_id===p[1]);return{rows:[{v:a.reduce((n,x)=>Math.max(n,x.aggregate_version),0)}]};}
  if(sql.includes("count(DISTINCT aggregate_id)")){return{rows:[{n:new Set(state.events.filter(x=>x.aggregate_type===p[0]).map(x=>x.aggregate_id)).size}]};}
  if(sql.includes("SELECT payload FROM jarvis.events WHERE aggregate_type='job' AND payload->>")){const x=state.events.filter(x=>x.aggregate_type==="job"&&x.payload.idempotencyKey===p[0]).at(-1);return{rows:x?[{payload:x.payload}]:[]};}
  if(sql.includes("SELECT DISTINCT ON (aggregate_id) payload FROM jarvis.events WHERE aggregate_type='approval'")){const x=state.events.filter(x=>x.aggregate_type==="approval"&&x.payload.idempotencyKey===p[0]).at(-1);return{rows:x?[{payload:x.payload}]:[]};}
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
 const decided=await approvals.decide(a.approval.id,"approved",{reason:"reviewed",actor:"owner-api"});
 assert.equal(decided.status,"approved");assert.equal(decided.decidedBy,"owner-api");
 await assert.rejects(approvals.decide(a.approval.id,"rejected"),/already been decided/);
});

test("PostgreSQL approval store rejects malformed requests",async()=>{
 const {approvals}=createPostgresOperationalStores({pool:fakePool()});
 await assert.rejects(approvals.create({departmentId:"../admin",actionClass:"publish",summary:"x"}),/department/);
 await assert.rejects(approvals.create({departmentId:"content",actionClass:"invalid",summary:"x"}),/action/);
});
