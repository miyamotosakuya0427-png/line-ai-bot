"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createTaskRegistry}=require("./task-registry-store");
const {createPostgresExecutionKernel}=require("./postgres-execution-kernel");
const url=process.env.JARVIS_EXECUTION_TEST_DATABASE_URL||"";
const enabled=Boolean(url)&&process.env.JARVIS_ALLOW_TEST_SCHEMA_RESET==="yes";

test("PostgreSQL 16 execution kernel fences stale workers at the resource write transaction",{skip:!enabled},async()=>{
 const {Pool}=require("pg");
 const parsed=new URL(url),database=decodeURIComponent(parsed.pathname.replace(/^\//,""));
 if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname))throw new Error("Execution kernel tests require loopback PostgreSQL; remote databases are prohibited");
 if(!/(^|[_-])test([_-]|$)/i.test(database))throw new Error("Execution test database name must include test");
 const pool=new Pool({connectionString:url,max:12,ssl:parsed.searchParams.get("sslmode")==="disable"?false:{rejectUnauthorized:true}});
 let now=Date.parse("2026-11-18T00:00:00.000Z");
 const clock=()=>new Date(now).toISOString();
 try{
  await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");
  const fs=require("node:fs/promises"),path=require("node:path"),root=path.join(__dirname,"..","migrations");
  for(const file of ["0001_neon_event_store.sql","0003_append_only_event_ledger.sql","0004_task_registry.sql","0005_task_registry_scoped_dedupe.sql","0006_scheduling_reservation_store.sql","0007_execution_kernel_fencing.sql"])await pool.query(await fs.readFile(path.join(root,file),"utf8"));
  const registry=createTaskRegistry({pool,clock,tokenFactory:()=>require("node:crypto").randomBytes(32).toString("hex")});
  const kernel=createPostgresExecutionKernel({pool,clock,allowedOperationScopes:["resource.update"]});
  await kernel.init();
  const makeTask=async(id,worker)=>registry.createTask({title:"Synthetic "+id,dedupeKey:"dedupe-"+id,projectId:"one-jarvis",ownerConversation:"test-conversation",ownerAgent:worker,status:"ready"});
  const first=await makeTask("one","worker-a");
  await kernel.registerWorker({workerId:"worker-a",agentId:"agent-a",departmentId:"engineering",instanceId:"instance-a",processId:"100"});
  await kernel.registerWorker({workerId:"worker-b",agentId:"agent-b",departmentId:"engineering",instanceId:"instance-b",processId:"200"});
  const claimRace=await Promise.all([
   registry.claimTaskForWorker({taskId:first.task.taskId,workerId:"worker-a",leaseMs:5000}),
   registry.claimTaskForWorker({taskId:first.task.taskId,workerId:"worker-b",leaseMs:5000})
  ]);
  assert.equal(claimRace.filter(Boolean).length,1,"only one Worker can atomically claim and bind the Task");
  const claimedA=claimRace.find(Boolean);
  const winnerId=claimedA.worker.worker_id;
  assert.ok(["worker-a","worker-b"].includes(winnerId));
  const loserId=winnerId==="worker-a"?"worker-b":"worker-a";
  assert.equal((await kernel.getWorker(winnerId)).status,"running");
  assert.equal((await kernel.getWorker(loserId)).status,"idle");
  const resourceAttempts=await Promise.all([
   registry.acquireLease({resourceKey:"resource:race",ownerId:"worker-a",leaseMs:5000}),
   registry.acquireLease({resourceKey:"resource:race",ownerId:"worker-b",leaseMs:5000})
  ]);
  assert.equal(resourceAttempts.filter(Boolean).length,1,"only one worker may acquire the same resource lease");
  const resourceLeaseA=await registry.acquireLease({resourceKey:"resource:shared-doc",ownerId:"worker-a",leaseMs:5000});
  assert.ok(resourceLeaseA);
  assert.equal(await registry.acquireLease({resourceKey:"resource:shared-doc",ownerId:"worker-b",leaseMs:5000}),null);
  const initial=await kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:"worker-a",taskId:first.task.taskId,taskLease:claimedA.lease,lease:resourceLeaseA,operationId:"op-a1",idempotencyKey:"idem-a1",operationScope:"resource.update",payload:{value:1},expectedVersion:0});
  assert.equal(initial.version,1);
  const replay=await kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:"worker-a",taskId:first.task.taskId,taskLease:claimedA.lease,lease:resourceLeaseA,operationId:"op-a1",idempotencyKey:"idem-a1",operationScope:"resource.update",payload:{value:1},expectedVersion:0});
  assert.equal(replay.replayed,true);
  assert.equal(replay.version,1);
  now+=6000;
  const second=await makeTask("two","worker-b");
  const claimedB=await registry.claimTaskForWorker({taskId:second.task.taskId,workerId:loserId,leaseMs:60000});
  const resourceLeaseB=await registry.acquireLease({resourceKey:"resource:shared-doc",ownerId:loserId,leaseMs:60000});
  assert.ok(resourceLeaseB);
  assert.ok(resourceLeaseB.fencingToken>resourceLeaseA.fencingToken);
  await assert.rejects(kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:"worker-a",taskId:first.task.taskId,taskLease:claimedA.lease,lease:resourceLeaseA,operationId:"op-stale",idempotencyKey:"idem-stale",operationScope:"resource.update",payload:{value:"stale"},expectedVersion:1}),/expired, stale, or not owned/);
  const fresh=await kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:loserId,taskId:second.task.taskId,taskLease:claimedB.lease,lease:resourceLeaseB,operationId:"op-b1",idempotencyKey:"idem-b1",operationScope:"resource.update",payload:{value:2},expectedVersion:1});
  assert.equal(fresh.version,2);
  const stored=await pool.query("SELECT payload,version,fencing_token FROM jarvis.fenced_resources WHERE resource_id='shared-doc'");
  assert.deepEqual(stored.rows[0].payload,{value:2});
  assert.equal(Number(stored.rows[0].version),2);
  assert.equal(Number(stored.rows[0].fencing_token),resourceLeaseB.fencingToken);
  await assert.rejects(kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:loserId,taskId:second.task.taskId,taskLease:claimedB.lease,lease:resourceLeaseB,operationId:"op-cross-scope",idempotencyKey:"idem-cross-scope",operationScope:"resource.delete",payload:{value:3},expectedVersion:2}),/Invalid or unauthorized/);
  const ops=await pool.query("SELECT count(*)::int AS count FROM jarvis.fenced_operations WHERE resource_id='shared-doc'");
  assert.equal(ops.rows[0].count,2,"only committed writes are journaled");
 } finally {try{await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");}finally{await pool.end();}}
});
