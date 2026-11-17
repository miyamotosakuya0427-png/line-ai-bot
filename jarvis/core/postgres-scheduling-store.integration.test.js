"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPostgresSchedulingStore}=require("./postgres-scheduling-store");

const url=process.env.JARVIS_SCHEDULING_TEST_DATABASE_URL||"";
const enabled=Boolean(url)&&process.env.JARVIS_ALLOW_TEST_SCHEMA_RESET==="yes";

test("real PostgreSQL applies migrations 0001-0006 twice and persists reservation state with append-only audit and concurrency fencing",{skip:!enabled},async()=>{
 const {Pool}=require("pg");
 const parsed=new URL(url),database=decodeURIComponent(parsed.pathname.replace(/^\//,""));
 if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname))throw new Error("Scheduling integration tests are restricted to local PostgreSQL; remote databases are prohibited");
 if(!/(^|[_-])test([_-]|$)/i.test(database))throw new Error("Test database name must include test");
 const pool=new Pool({connectionString:url,max:8,ssl:parsed.searchParams.get("sslmode")==="disable"?false:{rejectUnauthorized:true}});
 try{
  await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");
  const fs=require("node:fs/promises"),path=require("node:path"),root=path.join(__dirname,"..");
  const migrations=["0001_neon_event_store.sql","0002_job_approval_stores.sql","0003_append_only_event_ledger.sql","0004_task_registry.sql","0005_task_registry_scoped_dedupe.sql","0006_scheduling_reservation_store.sql"];
  for(const file of migrations)await pool.query(await fs.readFile(path.join(root,"migrations",file),"utf8"));
  // Reapplying the complete chain must be safe and preserve the recorded versions.
  for(const file of migrations)await pool.query(await fs.readFile(path.join(root,"migrations",file),"utf8"));
  const applied=await pool.query("SELECT version FROM jarvis.schema_migrations ORDER BY version");
  assert.deepEqual(applied.rows.map(row=>row.version),[
   "0001_neon_event_store","0002_job_approval_stores","0003_append_only_event_ledger",
   "0004_task_registry","0005_task_registry_scoped_dedupe","0006_scheduling_reservation_store"
  ]);
  const store=createPostgresSchedulingStore({pool});
  const record={id:"reservation-fixture-1",type:"reservation",state:"proposed",operationHash:"a".repeat(64),idempotencyKey:"fixture-key-1",createdAt:"2026-11-18T00:00:00.000Z",updatedAt:"2026-11-18T00:00:00.000Z",proposal:{title:"Synthetic fixture"}};
  const created=await store.create(record);
  assert.equal(created.version,1);
  assert.equal((await store.create(record)).id,record.id,"idempotent create returns existing record");
  const attempts=await Promise.allSettled([
   store.update(record.id,{state:"approval_pending",approvalId:"approval-a"}),
   store.update(record.id,{state:"approval_pending",approvalId:"approval-b"})
  ]);
  assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1,"only one concurrent state transition may win");
  const current=await store.get(record.id);
  assert.equal(current.state,"approval_pending");
  assert.equal(current.version,2);
  const audit=await pool.query("SELECT event_type,payload FROM jarvis.events WHERE aggregate_type='reservation_audit' AND aggregate_id=$1 ORDER BY aggregate_version",[record.id]);
  assert.equal(audit.rows.length,2,"creation and state transition are both audited");
  await assert.rejects(pool.query("UPDATE jarvis.events SET event_type='tampered' WHERE aggregate_type='reservation' AND aggregate_id=$1",[record.id]),/append-only/);
 } finally {try{await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");}finally{await pool.end();}}
});
