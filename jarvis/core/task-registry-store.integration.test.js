"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createTaskRegistry}=require("./task-registry-store");
const {createServer}=require("../server");
const {createPostgresTaskRegistryRateLimiter}=require("./postgres-task-registry-rate-limiter");

const databaseUrl=process.env.JARVIS_TASK_REGISTRY_TEST_DATABASE_URL;
test("PostgreSQL 16 Task Registry concurrency and fencing integration", {skip:!databaseUrl}, async()=>{
  // Load the optional PostgreSQL driver only when the isolated integration
  // database is configured. The repository-wide unit suite discovers this
  // file too, but intentionally does not install the jarvis workspace deps.
  const {Pool}=require("pg");
  const pool=new Pool({connectionString:databaseUrl,max:8});
  let now=Date.now();
  const clock=()=>new Date(now).toISOString();
  const migrations=["0001_neon_event_store.sql","0002_job_approval_stores.sql","0003_append_only_event_ledger.sql","0004_task_registry.sql","0005_task_registry_scoped_dedupe.sql","0006_scheduling_reservation_store.sql","0007_execution_kernel_fencing.sql"];
  try{
    for(const file of migrations){
      const sql=fs.readFileSync(path.join(__dirname,"..","migrations",file),"utf8");
      await pool.query(sql);
    }
    const migration4=fs.readFileSync(path.join(__dirname,"..","migrations","0004_task_registry.sql"),"utf8");
    await pool.query(migration4); // idempotent rerun
    const migration5=fs.readFileSync(path.join(__dirname,"..","migrations","0005_task_registry_scoped_dedupe.sql"),"utf8");
    await pool.query(migration5); // scoped index and migration ledger are idempotent
    const migrationVersion=await pool.query("SELECT 1 FROM jarvis.schema_migrations WHERE version='0005_task_registry_scoped_dedupe'");
    assert.equal(migrationVersion.rowCount,1,"migration 0005 must be recorded exactly once");
    const a=createTaskRegistry({pool,clock});
    const b=createTaskRegistry({pool,clock});
    await a.init();
    const dedupe="integration:"+cryptoRandom();
    const created=await a.createTask({title:"Integration task",scope:"ephemeral postgres test",dedupeKey:dedupe,status:"ready"});
    const duplicate=await b.createTask({title:"duplicate should not replace original",dedupeKey:dedupe,status:"ready"});
    assert.equal(created.created,true);
    assert.equal(duplicate.created,false);
    assert.equal(duplicate.task.taskId,created.task.taskId);
    const sameKeyOtherAgent=await b.createTask({title:"Same key, different owner",dedupeKey:dedupe,status:"ready",ownerAgent:"different-agent",ownerConversation:"different-conversation"});
    assert.equal(sameKeyOtherAgent.created,true,"idempotency keys are isolated by agent and conversation ownership");
    assert.notEqual(sameKeyOtherAgent.task.taskId,created.task.taskId);

    await assert.rejects(
      a.createTask({title:"Missing dependency",dedupeKey:"missing-dependency:"+cryptoRandom(),dependencyTaskIds:["missing-task-id"]}),
      /Dependency task does not exist/
    );
    const root=await a.createTask({title:"Dependency root",dedupeKey:"dependency-root:"+cryptoRandom(),status:"ready"});
    const child=await b.createTask({title:"Dependency child",dedupeKey:"dependency-child:"+cryptoRandom(),status:"ready",dependencyTaskIds:[root.task.taskId]});
    assert.deepEqual(child.task.dependencyTaskIds,[root.task.taskId]);

    const parent=await a.createTask({title:"Parent aggregate",dedupeKey:"parent-aggregate:"+cryptoRandom(),status:"ready"});
    const requiredChild=await b.createTask({title:"Required child",dedupeKey:"required-child:"+cryptoRandom(),status:"ready",parentTaskId:parent.task.taskId});
    assert.equal(requiredChild.task.parentTaskId,parent.task.taskId);
    const parentClaim=await a.claimTask({taskId:parent.task.taskId,ownerId:"parent-worker",leaseMs:10000});
    const parentRunning=await a.transitionTask({taskId:parent.task.taskId,expectedVersion:parentClaim.version,lease:parentClaim.lease,status:"in_progress"});
    await assert.rejects(a.transitionTask({taskId:parent.task.taskId,expectedVersion:parentRunning.version,lease:parentClaim.lease,status:"completed"}),/every child task is completed/);
    const childClaim=await b.claimTask({taskId:requiredChild.task.taskId,ownerId:"child-worker",leaseMs:10000});
    const childRunning=await b.transitionTask({taskId:requiredChild.task.taskId,expectedVersion:childClaim.version,lease:childClaim.lease,status:"in_progress"});
    const childCompleted=await b.transitionTask({taskId:requiredChild.task.taskId,expectedVersion:childRunning.version,lease:childClaim.lease,status:"completed"});
    assert.equal(childCompleted.task.state,"completed");
    const parentCompleted=await a.transitionTask({taskId:parent.task.taskId,expectedVersion:parentRunning.version,lease:parentClaim.lease,status:"completed"});
    assert.equal(parentCompleted.task.state,"completed");
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

    const apiScopes=["tasks:read","tasks:write","tasks:dispatch","tasks:claim","tasks:lease","tasks:transition","resources:lease"];
    const api=createServer({
      token:"api-test-token-".padEnd(64,"x"),
      taskRegistry:a,
      taskRegistryRateLimiter:createPostgresTaskRegistryRateLimiter({pool}),
      authorizeTaskRegistry:async req=>{
        if(req.headers.authorization==="Bearer agent-a")return{agentId:"api-agent-a",conversationId:"api-conversation-a",scopes:apiScopes,projectIds:["one-jarvis"],resourcePrefixes:["path:one-jarvis:"]};
        if(req.headers.authorization==="Bearer agent-b")return{agentId:"api-agent-b",conversationId:"api-conversation-b",scopes:apiScopes,projectIds:["one-jarvis"],resourcePrefixes:["path:one-jarvis:"]};
        return null;
      }
    });
    await new Promise(resolve=>api.listen(0,"127.0.0.1",resolve));
    const apiRoot="http://127.0.0.1:"+api.address().port;
    try{
      const createdResponse=await fetch(apiRoot+"/v1/tasks",{method:"POST",headers:{Authorization:"Bearer agent-a","Content-Type":"application/json"},body:JSON.stringify({title:"PostgreSQL HTTP API task",dedupeKey:"api-integration:"+cryptoRandom(),status:"ready"})});
      assert.equal(createdResponse.status,201);
      const createdBody=await createdResponse.json();
      const apiTaskId=createdBody.task.taskId;
      assert.equal(createdBody.task.ownerAgent,"api-agent-a");
      const claimedResponse=await fetch(apiRoot+"/v1/tasks/"+apiTaskId+"/claim",{method:"POST",headers:{Authorization:"Bearer agent-a","Content-Type":"application/json"},body:JSON.stringify({leaseMs:10000})});
      assert.equal(claimedResponse.status,200);
      const claimBody=await claimedResponse.json();
      const foreignHeartbeat=await fetch(apiRoot+"/v1/tasks/"+apiTaskId+"/heartbeat",{method:"POST",headers:{Authorization:"Bearer agent-b","Content-Type":"application/json"},body:JSON.stringify({lease:claimBody.lease})});
      assert.equal(foreignHeartbeat.status,403);
      const transitionResponse=await fetch(apiRoot+"/v1/tasks/"+apiTaskId+"/transition",{method:"POST",headers:{Authorization:"Bearer agent-a","Content-Type":"application/json"},body:JSON.stringify({expectedVersion:2,lease:claimBody.lease,status:"in_progress",patch:{nextAction:"PostgreSQL API verified"}})});
      assert.equal(transitionResponse.status,200);
      const resourceResponse=await fetch(apiRoot+"/v1/resources/leases",{method:"POST",headers:{Authorization:"Bearer agent-a","Content-Type":"application/json"},body:JSON.stringify({resourceKey:"path:one-jarvis:jarvis/server.js",leaseMs:10000})});
      assert.equal(resourceResponse.status,201);
      const resourceLease=(await resourceResponse.json()).lease;
      const resourceRelease=await fetch(apiRoot+"/v1/resources/leases/release",{method:"POST",headers:{Authorization:"Bearer agent-a","Content-Type":"application/json"},body:JSON.stringify({lease:resourceLease})});
      assert.equal(resourceRelease.status,200);
      assert.equal((await resourceRelease.json()).released,true);
      const listResponse=await fetch(apiRoot+"/v1/tasks?status=in_progress&limit=10",{headers:{Authorization:"Bearer agent-a"}});
      assert.equal(listResponse.status,200);
      assert.ok((await listResponse.json()).tasks.some(x=>x.task.taskId===apiTaskId));
    }finally{
      await new Promise(resolve=>api.close(resolve));
    }
  }finally{
    await pool.end();
  }
});
function cryptoRandom(){return require("node:crypto").randomUUID();}
