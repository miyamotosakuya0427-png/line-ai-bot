"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Pool}=require("pg");
const {createTaskRegistry}=require("./task-registry-store");

const databaseUrl=process.env.JARVIS_TASK_REGISTRY_TEST_DATABASE_URL;
test("PostgreSQL 16 Task Registry concurrency and fencing integration", {skip:!databaseUrl}, async()=>{
  const pool=new Pool({connectionString:databaseUrl,max:8});
  let now=Date.now();
  const clock=()=>new Date(now).toISOString();
  const migrations=["0001_neon_event_store.sql","0002_job_approval_stores.sql","0003_append_only_event_ledger.sql","0004_task_registry.sql"];
  try{
    for(const file of migrations){
      const sql=fs.readFileSync(path.join(__dirname,"..","migrations",file),"utf8");
      await pool.query(sql);
    }
    const a=createTaskRegistry({pool,clock});
    const b=createTaskRegistry({pool,clock});
    await a.init();
    const dedupe="integration:"+cryptoRandom();
    const created=await a.createTask({title:"Integration task",scope:"ephemeral postgres test",dedupeKey:dedupe,status:"ready"});
    const duplicate=await b.createTask({title:"duplicate should not replace original",dedupeKey:dedupe,status:"ready"});
    assert.equal(created.created,true);
    assert.equal(duplicate.created,false);
    assert.equal(duplicate.task.taskId,created.task.taskId);

    const resourceKey="integration-resource:"+cryptoRandom();
    const claims=await Promise.all([
      a.acquireLease({resourceKey,ownerId:"worker-a",leaseMs:5000}),
      b.acquireLease({resourceKey,ownerId:"worker-b",leaseMs:5000})
    ]);
    assert.equal(claims.filter(Boolean).length,1,"only one concurrent lease winner");
    const first=claims.find(Boolean);
    now+=6000;
    const reclaimed=await b.acquireLease({resourceKey,ownerId:"worker-b",leaseMs:10000});
    assert.ok(reclaimed);
    assert.ok(reclaimed.fencingToken>first.fencingToken,"fencing token must increase after expiry takeover");
    await assert.rejects(a.heartbeatLease({lease:first,leaseMs:10000}),/expired, stale, or not owned/);

    const claim=await a.claimTask({taskId:created.task.taskId,ownerId:"worker-a",leaseMs:10000});
    assert.ok(claim);
    const moved=await a.transitionTask({taskId:created.task.taskId,expectedVersion:claim.version,lease:claim.lease,status:"in_progress",patch:{nextAction:"integration verified"}});
    assert.equal(moved.task.status,"in_progress");
    await assert.rejects(a.transitionTask({taskId:created.task.taskId,expectedVersion:claim.version,lease:claim.lease,status:"review"}),/Stale task version/);
    await assert.rejects(a.transitionTask({taskId:created.task.taskId,expectedVersion:moved.version,lease:claim.lease,status:"review",patch:{taskId:"tamper"}}),/Invalid task patch/);

    const staleRace=await Promise.allSettled([
      a.acquireLease({resourceKey:"integration-race:"+cryptoRandom(),ownerId:"race-a",leaseMs:5000}),
      b.acquireLease({resourceKey:"integration-race:"+cryptoRandom(),ownerId:"race-b",leaseMs:5000})
    ]);
    assert.equal(staleRace.filter(x=>x.status==="fulfilled"&&x.value).length,2,"independent resources can be leased concurrently");
  }finally{
    await pool.end();
  }
});
function cryptoRandom(){return require("node:crypto").randomUUID();}
