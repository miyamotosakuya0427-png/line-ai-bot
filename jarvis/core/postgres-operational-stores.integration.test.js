"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const {createPostgresOperationalStores}=require("./postgres-operational-stores");

const connectionString=process.env.JARVIS_TEST_DATABASE_URL||"";
const enabled=Boolean(connectionString)&&process.env.JARVIS_ALLOW_TEST_SCHEMA_RESET==="yes";

test("real PostgreSQL multi-connection claims and approval integrity", {skip:!enabled}, async()=>{
 const {Pool}=require("pg");
 const parsed=new URL(connectionString);
 const database=decodeURIComponent(parsed.pathname.replace(/^\//,""));
 if(!/(^|[_-])test([_-]|$)/i.test(database))throw new Error("JARVIS_TEST_DATABASE_URL must point to a dedicated database whose name includes test");
 const pool=new Pool({connectionString,max:8,ssl:parsed.searchParams.get("sslmode")==="disable"?false:{rejectUnauthorized:true}});
 try{
  await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");
  const root=path.join(__dirname,"..");
  await pool.query(await fs.readFile(path.join(root,"migrations/0001_neon_event_store.sql"),"utf8"));
  await pool.query(await fs.readFile(path.join(root,"migrations/0002_job_approval_stores.sql"),"utf8"));
  let now="2026-11-17T00:00:00.000Z";
  const stores=createPostgresOperationalStores({pool,clock:()=>now,authorizeActor:async actor=>actor==="integration-owner"});
  const {jobs,approvals}=stores;
  const {job}=await jobs.create({type:"integration.claim",payload:{id:"one"}});
  const claims=await Promise.all(Array.from({length:6},(_,i)=>jobs.claimNext({workerId:"integration-"+i,leaseMs:5000})));
  const first=claims.filter(Boolean);
  assert.equal(first.length,1,"only one concurrent connection may claim a queued job");
  const owner=first[0].lease.owner;
  now="2026-11-17T00:00:06.000Z";
  const reclaimed=await jobs.claimNext({workerId:"integration-recovery",leaseMs:5000});
  assert.equal(reclaimed.id,job.id);
  assert.equal(reclaimed.attempts,2);
  await assert.rejects(jobs.transition(job.id,"succeeded",{leaseOwner:owner}),/lease/);
  const completed=await jobs.transition(job.id,"succeeded",{leaseOwner:"integration-recovery",result:{ok:true}});
  assert.equal(completed.status,"succeeded");

  const payload={resourceId:"R-1",operation:"publish",version:1};
  const approval=await approvals.create({departmentId:"content",actionClass:"publish",summary:"Publish R-1",resourceId:"R-1",operationPayload:payload,expiresAt:"2026-11-17T01:00:00.000Z"});
  await approvals.decide(approval.approval.id,"approved",{actor:"integration-owner"});
  const attempts=await Promise.allSettled(Array.from({length:4},()=>approvals.claimExecution(approval.approval.id,{resourceId:"R-1",operationPayload:payload,actor:"integration-owner"})));
  assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1,"only one execution claim may be granted");
  assert.equal((await approvals.get(approval.approval.id)).executionStatus,"claimed");
 } finally {
  try{await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");}finally{await pool.end();}
 }
});
