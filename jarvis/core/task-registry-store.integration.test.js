"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createTaskRegistry}=require("./task-registry-store");

const databaseUrl=process.env.JARVIS_TASK_REGISTRY_TEST_DATABASE_URL;
test("PostgreSQL 16 Task Registry concurrency and fencing integration", {skip:!databaseUrl}, async()=>{
  // Load the optional PostgreSQL driver only when the isolated integration
  // database is configured. The repository-wide unit suite discovers this
  // file too, but intentionally does not install the jarvis workspace deps.
  const {Pool}=require("pg");
  const pool=new Pool({connectionString:databaseUrl,max:8});
  let now=Date.now();
  const clock=()=>new Date(now).toISOString();
  const migrations=["0001_neon_event_store.sql","0002_job_approval_stores.sql","0003_append_only_event_ledger.sql","0004_task_registry.sql"];
  try{
    for(const file of migrations){
      const sql=fs.readFileSync(path.join(__dirname,"..","migrations",file),"utf8");
      await pool.query(sql);
    }
    const migration4=fs.readFileSync(path.join(__dirname,"..","migrations","0004_task_registry.sql"),"utf8");
    await pool.query(migration4); // idempotent rerun
    const a=createTaskRegistry({pool,clock});
    const b=createTaskRegistry({pool,clock});
    await a.init();
    const dedupe="integration:"+cryptoRandom();
    const created=await a.createTask({title:"Integration task",scope:"ephemeral postgres test",dedupeKey:dedupe,status:"ready"});
    const duplicate=await b.createTask({title:"duplicate should not replace original",dedupeKey:dedupe,status:"ready"});
    assert.equal(created.created,true);
    assert.equal(duplicate.created,false);
    assert.equal(duplicate.task.taskId,created.task.taskId);

    await assert.rejects(
      a.createTask({title:"Missing dependency",dedupeKey:"missing-dependency:"+cryptoRandom(),dependencyTaskIds:["missing-task-id"]}),
      /Dependency task does not exist/
    );
    const root=await a.createTask({title:"Dependency root",dedupeKey:"dependency-root:"+cryptoRandom(),status:"ready"});
    const child=await b.createTask({title:"Dependency child",dedupeKey:"dependency-child:"+cryptoRandom(),status:"ready",dependencyTaskIds:[root.task.taskId]});
    assert.deepEqual(child.task.dependencyTaskIds,[root.task.taskId]);
    const rootLease=await a.acquireLease({resourceKey:"task:"+root.task.taskId,ownerId:"dependency-check",leaseMs:10000});
    await assert.rejects(
      a.transitionTask({taskId:root.task.taskId,expectedVersion:root.version,lease:rootLease,status:"blocked",patch:{dependencyTaskIds:[child.task.taskId]}}),
      /Task dependency cycle detected/
    );
    assert.equal(await a.releaseLease({lease:rootLease}),true);

    const firstPage=await a.listTasks({status:"ready",limit:1,offset:0});
    const secondPage=await b.listTasks({status:"ready",limit:1,offset:1});
    assert.equal(firstPage.length,1);
    assert.equal(secondPage.length,1);
    assert.notEqual(firstPage[0].task.taskId,secondPage[0].task.taskId,"SQL pagination must return distinct pages");

    const protectedTask=await a.createTask({title:"Resource-locked task",dedupeKey:"resource-lock:"+cryptoRandom(),status:"ready"});
    const protectedClaim=await a.claimTask({taskId:protectedTask.task.taskId,ownerId:"resource-worker",leaseMs:60000});
    const branchKey="branch:one-jarvis:feature/resource-lock-test";
    const pathKey="path:one-jarvis:jarvis/core/resource-lock-test.js";
    await assert.rejects(
      a.transitionTask({taskId:protectedTask.task.taskId,expectedVersion:protectedClaim.version,lease:protectedClaim.lease,status:"in_progress",patch:{branch:"feature/resource-lock-test",changedPaths:["jarvis/core/resource-lock-test.js"]}}),
      /Current resource lease is required/
    );
    const wrongBranchLease=await b.acquireLease({resourceKey:branchKey,ownerId:"different-worker",leaseMs:10000});
    await assert.rejects(
      a.transitionTask({taskId:protectedTask.task.taskId,expectedVersion:protectedClaim.version,lease:protectedClaim.lease,status:"in_progress",patch:{branch:"feature/resource-lock-test"},resourceLeases:[wrongBranchLease]}),
      /Current resource lease is required/
    );
    assert.equal(await b.releaseLease({lease:wrongBranchLease}),true);
    const branchLease=await a.acquireLease({resourceKey:branchKey,ownerId:"resource-worker",leaseMs:10000});
    const pathLease=await b.acquireLease({resourceKey:pathKey,ownerId:"resource-worker",leaseMs:10000});
    const protectedMoved=await a.transitionTask({
      taskId:protectedTask.task.taskId,expectedVersion:protectedClaim.version,lease:protectedClaim.lease,status:"in_progress",
      patch:{branch:"feature/resource-lock-test",changedPaths:["jarvis/core/resource-lock-test.js"]},
      resourceLeases:[branchLease,pathLease]
    });
    assert.equal(protectedMoved.task.branch,"feature/resource-lock-test");
    assert.deepEqual(protectedMoved.task.changedPaths,["jarvis/core/resource-lock-test.js"]);
    await assert.rejects(
      a.transitionTask({taskId:protectedTask.task.taskId,expectedVersion:protectedMoved.version,lease:protectedClaim.lease,status:"review",patch:{changedPaths:["../escape.js"]},resourceLeases:[branchLease,pathLease]}),
      /Invalid task path/
    );
    assert.equal(await a.releaseLease({lease:branchLease}),true);
    assert.equal(await b.releaseLease({lease:pathLease}),true);

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

    const taskClaims=await Promise.all([
      a.claimTask({taskId:created.task.taskId,ownerId:"worker-a",leaseMs:10000}),
      b.claimTask({taskId:created.task.taskId,ownerId:"worker-b",leaseMs:10000})
    ]);
    assert.equal(taskClaims.filter(Boolean).length,1,"one worker may claim a task");
    const claim=taskClaims.find(Boolean);
    assert.ok(claim);
    const moved=await a.transitionTask({taskId:created.task.taskId,expectedVersion:claim.version,lease:claim.lease,status:"in_progress",patch:{nextAction:"integration verified"}});
    assert.equal(moved.task.status,"in_progress");
    await assert.rejects(a.transitionTask({taskId:created.task.taskId,expectedVersion:claim.version,lease:claim.lease,status:"review"}),/Stale task version/);
    await assert.rejects(a.transitionTask({taskId:created.task.taskId,expectedVersion:moved.version,lease:claim.lease,status:"review",patch:{taskId:"tamper"}}),/Invalid task patch/);
    now+=11000;
    const recovered=await b.claimTask({taskId:created.task.taskId,ownerId:"worker-recovery",leaseMs:10000});
    assert.ok(recovered,"expired in_progress task can be reclaimed");
    assert.equal(recovered.task.status,"claimed");
    assert.equal(recovered.task.recoveredFromStatus,"in_progress");
    assert.ok(recovered.lease.fencingToken>claim.lease.fencingToken,"task recovery increments fencing token");
    await assert.rejects(a.transitionTask({taskId:created.task.taskId,expectedVersion:moved.version,lease:claim.lease,status:"review"}),/expired, stale, or not owned/);
    const leaseAudit=await pool.query("SELECT event_type,payload FROM jarvis.events WHERE aggregate_type='coordination_lease' AND aggregate_id=$1 ORDER BY aggregate_version",[ "task:"+created.task.taskId ]);
    assert.ok(leaseAudit.rows.some(x=>x.event_type==="lease_acquired"));
    assert.ok(leaseAudit.rows.some(x=>x.event_type==="lease_reclaimed"));
    await assert.rejects(pool.query("UPDATE jarvis.events SET event_type='tampered' WHERE aggregate_type='task' AND aggregate_id=$1",[created.task.taskId]),/append-only/);
    await assert.rejects(pool.query("DELETE FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1",[created.task.taskId]),/append-only/);
    await assert.rejects(pool.query("TRUNCATE jarvis.events"),/append-only/);

    const releaseKey="integration-release:"+cryptoRandom();
    const released=await a.acquireLease({resourceKey:releaseKey,ownerId:"release-a",leaseMs:5000});
    assert.ok(released);
    const renewed=await a.heartbeatLease({lease:released,leaseMs:10000});
    assert.ok(Date.parse(renewed.expiresAt)>Date.parse(released.expiresAt),"heartbeat extends lease");
    assert.equal(await a.releaseLease({lease:renewed}),true);
    const afterRelease=await b.acquireLease({resourceKey:releaseKey,ownerId:"release-b",leaseMs:5000});
    assert.ok(afterRelease.fencingToken>released.fencingToken,"release/reacquire must not reset fencing token");
    const lifecycle=await pool.query("SELECT event_type FROM jarvis.events WHERE aggregate_type='coordination_lease' AND aggregate_id=$1 ORDER BY aggregate_version",[releaseKey]);
    assert.deepEqual(lifecycle.rows.map(x=>x.event_type),["lease_acquired","lease_heartbeat","lease_released","lease_acquired"]);

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
