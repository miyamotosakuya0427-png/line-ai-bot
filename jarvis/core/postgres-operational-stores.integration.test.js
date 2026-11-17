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
  await pool.query(await fs.readFile(path.join(root,"migrations/0003_append_only_event_ledger.sql"),"utf8"));
  const triggerCount=await pool.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='jarvis.events'::regclass AND NOT tgisinternal");
  assert.equal(triggerCount.rows[0].count,2,"row mutation and truncate protection triggers must both exist");

  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jarvis_runtime_test') THEN CREATE ROLE jarvis_runtime_test NOLOGIN; END IF; END $$");
  await pool.query("GRANT USAGE ON SCHEMA jarvis TO jarvis_runtime_test");
  await pool.query("GRANT SELECT, INSERT ON jarvis.events TO jarvis_runtime_test");
  await pool.query("GRANT USAGE, SELECT ON SEQUENCE jarvis.events_event_id_seq TO jarvis_runtime_test");
  const runtime=await pool.connect();
  let eventId;
  try {
   await runtime.query("SET ROLE jarvis_runtime_test");
   const privileges=await runtime.query("SELECT current_user, has_table_privilege(current_user,'jarvis.events','SELECT') AS can_select, has_table_privilege(current_user,'jarvis.events','INSERT') AS can_insert, has_table_privilege(current_user,'jarvis.events','UPDATE') AS can_update, has_table_privilege(current_user,'jarvis.events','DELETE') AS can_delete, has_table_privilege(current_user,'jarvis.events','TRUNCATE') AS can_truncate");
   assert.equal(privileges.rows[0].current_user,"jarvis_runtime_test");
   assert.equal(privileges.rows[0].can_select,true);
   assert.equal(privileges.rows[0].can_insert,true);
   assert.equal(privileges.rows[0].can_update,false);
   assert.equal(privileges.rows[0].can_delete,false);
   assert.equal(privileges.rows[0].can_truncate,false);
   const inserted=await runtime.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('integration','ledger-check',1,'created',$1::jsonb) RETURNING event_id",['{"ok":true}']);
   eventId=inserted.rows[0].event_id;
   const selected=await runtime.query("SELECT payload FROM jarvis.events WHERE event_id=$1",[eventId]);
   assert.deepEqual(selected.rows[0].payload,{ok:true});
  } finally {
   try { await runtime.query("RESET ROLE"); } finally { runtime.release(); }
  }
  await assert.rejects(pool.query("UPDATE jarvis.events SET event_type='tampered' WHERE event_id=$1",[eventId]),/append-only/);
  await assert.rejects(pool.query("DELETE FROM jarvis.events WHERE event_id=$1",[eventId]),/append-only/);
  await assert.rejects(pool.query("TRUNCATE jarvis.events"),/append-only/);

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
