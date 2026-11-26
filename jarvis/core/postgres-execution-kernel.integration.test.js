"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {fork}=require("node:child_process");
const path=require("node:path");
async function runWorkerProcess(mode,workerId,taskId="",extraEnv={}){
 const child=fork(path.join(__dirname,"postgres-execution-worker-child.js"),[],{env:{...process.env,JARVIS_EXECUTION_CHILD_MODE:mode,JARVIS_EXECUTION_CHILD_WORKER_ID:workerId,JARVIS_EXECUTION_CHILD_TASK_ID:taskId,...extraEnv},stdio:["ignore","ignore","inherit","ipc"]});
 let message;
 child.on("message",value=>{message=value;});
 await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error("Worker child exited "+code+" without a successful result: "+JSON.stringify(message))));});
 if(!message?.ok)throw new Error("Worker child failed: "+JSON.stringify(message));
 return message;
}
const {createTaskRegistry}=require("./task-registry-store");
const {createPostgresExecutionKernel}=require("./postgres-execution-kernel");
const {createTaskEventOutbox}=require("./task-event-outbox");
const url=process.env.JARVIS_EXECUTION_TEST_DATABASE_URL||"";
const enabled=Boolean(url)&&process.env.JARVIS_ALLOW_TEST_SCHEMA_RESET==="yes";

test("PostgreSQL 16 execution kernel preserves fencing across multi-process claims recovery and idempotent writes",{skip:!enabled},async()=>{
 const {Pool}=require("pg");
 const parsed=new URL(url),database=decodeURIComponent(parsed.pathname.replace(/^\//,""));
 if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname))throw new Error("Execution kernel tests require loopback PostgreSQL; remote databases are prohibited");
 if(!/(^|[_-])test([_-]|$)/i.test(database))throw new Error("Execution test database name must include test");
 const pool=new Pool({connectionString:url,max:12,ssl:parsed.searchParams.get("sslmode")==="disable"?false:{rejectUnauthorized:true}});
 let now=Date.parse("2026-11-18T00:00:00.000Z");
 const clock=()=>new Date(now).toISOString();
 process.env.JARVIS_EXECUTION_TEST_CLOCK=clock();
 try{
  await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");
  const fs=require("node:fs/promises"),path=require("node:path"),root=path.join(__dirname,"..","migrations");
  for(const file of ["0001_neon_event_store.sql","0003_append_only_event_ledger.sql","0004_task_registry.sql","0005_task_registry_scoped_dedupe.sql","0006_scheduling_reservation_store.sql","0007_execution_kernel_fencing.sql","0008_worker_scope_grants.sql","0009_task_event_outbox.sql","0010_task_registry_agent_revocations.sql"])await pool.query(await fs.readFile(path.join(root,file),"utf8"));
  const registry=createTaskRegistry({pool,clock,tokenFactory:()=>require("node:crypto").randomBytes(32).toString("hex"),requireAgentRevocation:true});
  const kernel=createPostgresExecutionKernel({pool,clock,allowedOperationScopes:["resource.update","task.result.persist"]});
  await kernel.init();
  const registerScopedWorker=async(input)=>{await kernel.registerWorker(input);await kernel.grantWorkerScope({workerId:input.workerId,projectId:"one-jarvis",conversationId:"test-conversation",grantedBy:"integration-test"});};
  const makeTask=async(id,worker)=>registry.createTask({title:"Synthetic "+id,dedupeKey:"dedupe-"+id,projectId:"one-jarvis",ownerConversation:"test-conversation",ownerAgent:worker==="worker-a"?"agent-a":worker==="worker-b"?"agent-b":worker==="worker-ungranted"?"agent-ungranted":worker==="worker-revoked"?"agent-revoked":worker.startsWith("process-worker-")?"agent-process-"+worker.slice("process-worker-".length):worker,departmentId:"engineering",status:"ready"});
  const first=await makeTask("one","worker-a");
  const outbox=createTaskEventOutbox({pool});
  const {createPostgresTaskRegistryRevocationStore}=require("./postgres-task-registry-revocation-store");
  const revocations=createPostgresTaskRegistryRevocationStore({pool,clock});
  await revocations.init();
  assert.equal((await revocations.revoke({agentId:"agent-revoked-live",revokedBy:"integration-test"})).revoked,true);
  assert.equal(await revocations.isRevoked("agent-revoked-live"),true,"shared token revocation must be visible through PostgreSQL");
  await assert.rejects(pool.query("UPDATE jarvis.task_registry_agent_revocations SET revoked_by='tampered' WHERE agent_id=$1",["agent-revoked-live"]),/append-only/,"revocation ledger rejects UPDATE");
  await assert.rejects(pool.query("DELETE FROM jarvis.task_registry_agent_revocations WHERE agent_id=$1",["agent-revoked-live"]),/append-only/,"revocation ledger rejects DELETE");
  await assert.rejects(pool.query("TRUNCATE jarvis.task_registry_agent_revocations"),/append-only/,"revocation ledger rejects TRUNCATE");
  await registerScopedWorker({workerId:"worker-revoked-live",agentId:"agent-revoked-live",departmentId:"engineering",instanceId:"instance-revoked-live"});
  const revokedAgentTask=await registry.createTask({title:"Revoked Agent claim",dedupeKey:"dedupe-revoked-agent-claim",projectId:"one-jarvis",ownerConversation:"test-conversation",ownerAgent:"agent-revoked-live",departmentId:"engineering",status:"ready"});
  await assert.rejects(registry.claimTaskForWorker({taskId:revokedAgentTask.task.taskId,workerId:"worker-revoked-live",leaseMs:5000}),/Agent credential is revoked/);
  const revokedPublicTask=await registry.createTask({title:"Revoked public Claim",dedupeKey:"dedupe-revoked-public-claim",projectId:"one-jarvis",ownerConversation:"test-conversation",ownerAgent:"agent-revoked-live",departmentId:"engineering",status:"ready"});
  await assert.rejects(registry.claimTask({taskId:revokedPublicTask.task.taskId,ownerId:"agent-revoked-live",leaseMs:5000}),/Agent credential is revoked/);


  const initialEvents=await outbox.replay({projectId:"one-jarvis",conversationId:"test-conversation",afterCursor:0,limit:20});
  assert.ok(initialEvents.some(event=>event.taskId===first.task.taskId&&event.eventType==="created"),"Task creation and durable outbox row commit together");
  assert.deepEqual(await outbox.replay({projectId:"another-project",conversationId:"test-conversation",afterCursor:0,limit:20}),[],"outbox replay cannot cross Project scope");
  assert.deepEqual(await outbox.replay({projectId:"one-jarvis",conversationId:"another-conversation",afterCursor:0,limit:20}),[],"outbox replay cannot cross Conversation scope");
  const replayCursor=initialEvents[initialEvents.length-1].cursor;
  assert.deepEqual(await outbox.replay({projectId:"one-jarvis",conversationId:"test-conversation",afterCursor:replayCursor,limit:20}),[],"cursor replay does not duplicate acknowledged events");
  await assert.rejects(outbox.replay({projectId:"one-jarvis",conversationId:"test-conversation",afterCursor:999999,limit:20}),/ahead of the authorized scope/);
  await assert.rejects(pool.query("UPDATE jarvis.task_event_outbox SET event_type='tampered' WHERE source_event_id=$1",[initialEvents[0].eventId]),/append-only/);
  await registerScopedWorker({workerId:"worker-a",agentId:"agent-a",departmentId:"engineering",instanceId:"instance-a",processId:"100"});
  await registerScopedWorker({workerId:"worker-b",agentId:"agent-b",departmentId:"engineering",instanceId:"instance-b",processId:"200"});
  await registerScopedWorker({workerId:"worker-target",agentId:"agent-target",departmentId:"management",instanceId:"instance-target",processId:"300"});
  await registerScopedWorker({workerId:"worker-target-revoked",agentId:"agent-target-revoked",departmentId:"management",instanceId:"instance-target-revoked",processId:"400"});
  const scopedWorkers=await kernel.listWorkersForScope({projectId:"one-jarvis",conversationId:"test-conversation"});
  assert.ok(scopedWorkers.some(row=>row.worker_id==="worker-a"&&row.grant_id),"only explicitly granted Workers are returned in a scope listing");
  const grantAudit=await kernel.listWorkerScopeGrants({limit:50});
  const workerAGrant=grantAudit.find(row=>row.worker_id==="worker-a"&&row.project_id==="one-jarvis"&&row.conversation_id==="test-conversation");
  assert.ok(workerAGrant&&workerAGrant.granted_by==="integration-test"&&workerAGrant.granted_at,"Owner audit listing includes grantor and timestamp");
  assert.equal(Object.keys(workerAGrant).some(key=>/secret|hash|lease_token|access_token|api_token/i.test(key)),false,"Grant audit listing never returns secrets or token hashes");
  await kernel.registerWorker({workerId:"worker-ungranted",agentId:"agent-ungranted",departmentId:"engineering",instanceId:"instance-ungranted"});
  const ungrantedTask=await makeTask("ungranted","worker-ungranted");
  await assert.rejects(registry.claimTaskForWorker({taskId:ungrantedTask.task.taskId,workerId:"worker-ungranted",leaseMs:5000}),/no active grant/);
  await registerScopedWorker({workerId:"worker-revoked",agentId:"agent-revoked",departmentId:"engineering",instanceId:"instance-revoked"});
  const revokedTask=await makeTask("revoked","worker-revoked");
  const revokedRows=await kernel.listWorkersForScope({projectId:"one-jarvis",conversationId:"test-conversation"});
  const revokedGrant=revokedRows.find(row=>row.worker_id==="worker-revoked").grant_id;
  assert.equal((await kernel.revokeWorkerScope({grantId:revokedGrant,revokedBy:"integration-test"})).revoked,true);
  await assert.rejects(registry.claimTaskForWorker({taskId:revokedTask.task.taskId,workerId:"worker-revoked",leaseMs:5000}),/no active grant/);
  const revokedAudit=await kernel.listWorkerScopeGrants({limit:50});
  assert.ok(revokedAudit.some(row=>row.grant_id===revokedGrant&&row.revoked_by==="integration-test"&&row.revoked_at),"Revoked grant remains visible in the audit history");
  // Exercise real OS processes with independent PostgreSQL pools.
  const processTask=await makeTask("ten-process-claim","process-worker-0");
  const processWorkers=Array.from({length:10},(_,i)=>"process-worker-"+i);
  for(let i=0;i<processWorkers.length;i++)await registerScopedWorker({workerId:processWorkers[i],agentId:"agent-process-"+i,departmentId:"engineering",instanceId:"process-instance-"+i,processId:String(1000+i)});
  const processClaims=await Promise.all(processWorkers.map(workerId=>runWorkerProcess("claim",workerId,processTask.task.taskId)));
  assert.equal(processClaims.filter(x=>x.acquired).length,1,"exactly one of ten independent OS processes may claim the same Task");
  const processResourceLeases=await Promise.all(processWorkers.map(workerId=>runWorkerProcess("resource",workerId)));
  assert.equal(processResourceLeases.filter(x=>x.acquired).length,1,"exactly one of ten independent OS processes may lease the same Resource");
  const sharedQuota=await Promise.all(processWorkers.map(workerId=>runWorkerProcess("rate-limit",workerId)));
  assert.equal(sharedQuota.filter(x=>x.acquired).length,5,"PostgreSQL shared Agent quota must allow exactly five of ten concurrent processes");
  assert.ok(sharedQuota.filter(x=>!x.acquired).every(x=>x.retryAfter>0),"shared rate limit must return Retry-After for rejected calls");
  await registerScopedWorker({workerId:"worker-result",agentId:"agent-result",departmentId:"engineering",instanceId:"instance-result"});
  const resultTask=await registry.createTask({title:"Persisted Handler result",dedupeKey:"dedupe-task-result",projectId:"one-jarvis",ownerConversation:"test-conversation",ownerAgent:"agent-result",departmentId:"engineering",status:"ready"});
  const resultClaim=await registry.claimTaskForWorker({taskId:resultTask.task.taskId,workerId:"worker-result",leaseMs:5000});
  const resultRunning=await registry.transitionTask({taskId:resultTask.task.taskId,expectedVersion:resultClaim.version,lease:resultClaim.lease,status:"running"});
  const resultResourceId="task-result-"+resultTask.task.taskId;
  const resultResourceLease=await registry.acquireLease({resourceKey:"resource:"+resultResourceId,ownerId:"worker-result",leaseMs:5000});
  const resultWriteInput={resourceId:resultResourceId,projectId:"one-jarvis",workerId:"worker-result",taskId:resultTask.task.taskId,taskLease:resultClaim.lease,lease:resultResourceLease,operationId:"result-op-"+resultTask.task.taskId,idempotencyKey:"result-idem-"+resultTask.task.taskId,operationScope:"task.result.persist",payload:{answer:"PostgreSQL fenced result"},expectedVersion:0};
  const resultWrite=await kernel.writeResource(resultWriteInput);
  const resultReplay=await kernel.writeResource(resultWriteInput);
  assert.equal(resultWrite.version,1);
  assert.equal(resultReplay.replayed,true,"Fenced Task result persistence is idempotent");
  const resultDone=await registry.transitionTask({taskId:resultTask.task.taskId,expectedVersion:resultRunning.version,lease:resultClaim.lease,status:"completed",patch:{resultResourceId,verificationSummary:"Fenced result persisted"}});
  assert.equal(resultDone.task.resultResourceId,resultResourceId,"Task state references its durable result resource");
  await kernel.completeWorkerTask({workerId:"worker-result",taskId:resultTask.task.taskId,lease:resultClaim.lease,finalState:"completed"});
  await registry.releaseLease({lease:resultClaim.lease});
  await registry.releaseLease({lease:resultResourceLease});

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
  const heartbeatProcesses=await Promise.all([0,1].map(()=>runWorkerProcess("heartbeat",winnerId,first.task.taskId,{JARVIS_EXECUTION_CHILD_HEARTBEAT_LEASE:JSON.stringify(claimedA.lease)})));
  assert.equal(heartbeatProcesses.filter(x=>x.acquired).length,2,"independent processes may heartbeat the same active Worker Lease");
  // Force a failure after the Task Lease upsert but before Worker binding.
  // The transaction must roll back both the lease row and any Task event.
  const rollbackTask=await makeTask("rollback",loserId);
  let loser=await kernel.getWorker(loserId);
  loser=await kernel.transitionWorker({workerId:loserId,expectedVersion:Number(loser.version),status:"stopped"});
  await assert.rejects(registry.claimTaskForWorker({taskId:rollbackTask.task.taskId,workerId:loserId,leaseMs:5000}),/Worker is not available/);
  const rolledBackLease=await pool.query("SELECT resource_key FROM jarvis.coordination_leases WHERE resource_key=$1",["task:"+rollbackTask.task.taskId]);
  assert.equal(rolledBackLease.rowCount,0,"failed Worker binding must roll back the newly acquired Task Lease");
  const rolledBackTask=await registry.getTask(rollbackTask.task.taskId);
  assert.equal(rolledBackTask.task.status,"ready","failed Worker binding must roll back the Task claim event");
  const rollbackEvents=await outbox.replay({projectId:"one-jarvis",conversationId:"test-conversation",afterCursor:0,limit:500});
  assert.equal(rollbackEvents.some(event=>event.taskId===rollbackTask.task.taskId&&event.eventType==="claimed"),false,"failed Task transaction must not leave an Outbox claim event");
  assert.deepEqual(rollbackEvents.map(event=>event.cursor),rollbackEvents.map((_,index)=>index+1),"transaction rollback must not leave gaps in scoped cursors");
  loser=await kernel.transitionWorker({workerId:loserId,expectedVersion:Number(loser.version),status:"recovering"});
  await kernel.transitionWorker({workerId:loserId,expectedVersion:Number(loser.version),status:"idle"});
  const handoffTask=await makeTask("handoff",loserId);
  const handoffClaim=await registry.claimTaskForWorker({taskId:handoffTask.task.taskId,workerId:loserId,leaseMs:5000});
  const handoffRunning=await registry.transitionTask({taskId:handoffTask.task.taskId,expectedVersion:handoffClaim.version,lease:handoffClaim.lease,status:"running"});
  const handoffInput={taskId:handoffTask.task.taskId,expectedVersion:handoffRunning.version,lease:handoffClaim.lease,targetWorkerId:"worker-target",fromAgentId:(loserId==="worker-a"?"agent-a":"agent-b"),toAgentId:"agent-target",fromDepartmentId:"engineering",toDepartmentId:"management",idempotencyKey:"handoff-once",resultResourceId:"task-result-handoff",handoffRequest:{reason:"経営部門の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"}};
  const handoffAttempts=await Promise.all([
    runWorkerProcess("handoff",loserId,handoffTask.task.taskId,{JARVIS_EXECUTION_CHILD_HANDOFF_INPUT:JSON.stringify(handoffInput)}),
    runWorkerProcess("handoff",loserId,handoffTask.task.taskId,{JARVIS_EXECUTION_CHILD_HANDOFF_INPUT:JSON.stringify(handoffInput)})
  ]);
  assert.equal(handoffAttempts.filter(result=>result.created===true).length,1,"exactly one independent OS process commits a duplicate Handoff");
  assert.equal(handoffAttempts.filter(result=>result.created===false).length,1,"the other process receives the idempotent Handoff replay");
  const handoff=(await registry.getTask(handoffTask.task.taskId)).task;
  assert.equal(handoff.state,"queued");
  assert.equal(handoff.resultResourceId,"task-result-handoff");
  assert.equal((await kernel.getWorker(loserId)).status,"idle");
  const handoffEvents=await registry.listTaskEvents({taskIds:[handoffTask.task.taskId],limit:10});
  assert.equal(handoffEvents.filter(row=>row.eventType==="agent_handoff").length,1);
   assert.deepEqual(handoffEvents.find(row=>row.eventType==="agent_handoff").payload.handoffRequest,{reason:"経営部門の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"},"PostgreSQL persists structured Handoff details in the atomic event");
  const handoffReplay=await registry.recordTaskHandoff({taskId:handoffTask.task.taskId,expectedVersion:handoffRunning.version,lease:handoffClaim.lease,targetWorkerId:"worker-target",fromAgentId:(loserId==="worker-a"?"agent-a":"agent-b"),toAgentId:"agent-target",fromDepartmentId:"engineering",toDepartmentId:"management",idempotencyKey:"handoff-once",resultResourceId:"task-result-handoff",handoffRequest:{reason:"経営部門の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"}});
  assert.equal(handoffReplay.created,false,"handoff idempotency key must prevent duplicate transfer events");
  const revokedTargetTask=await makeTask("handoff-revoked-target",loserId);
  const revokedTargetClaim=await registry.claimTaskForWorker({taskId:revokedTargetTask.task.taskId,workerId:loserId,leaseMs:5000});
  const revokedTargetRunning=await registry.transitionTask({taskId:revokedTargetTask.task.taskId,expectedVersion:revokedTargetClaim.version,lease:revokedTargetClaim.lease,status:"running"});
  await revocations.revoke({agentId:"agent-target-revoked",revokedBy:"integration-test"});
  await assert.rejects(registry.recordTaskHandoff({taskId:revokedTargetTask.task.taskId,expectedVersion:revokedTargetRunning.version,lease:revokedTargetClaim.lease,targetWorkerId:"worker-target-revoked",fromAgentId:(loserId==="worker-a"?"agent-a":"agent-b"),toAgentId:"agent-target-revoked",fromDepartmentId:"engineering",toDepartmentId:"management",idempotencyKey:"handoff-revoked-target"}),/Agent credential is revoked/);
  const failedHandoffCleanup=await registry.transitionTask({taskId:revokedTargetTask.task.taskId,expectedVersion:revokedTargetRunning.version,lease:revokedTargetClaim.lease,status:"failed",patch:{nextAction:"Test cleanup after revoked target rejection"}});
  await kernel.completeWorkerTask({workerId:loserId,taskId:revokedTargetTask.task.taskId,lease:revokedTargetClaim.lease,finalState:"failed"});
  await registry.releaseLease({lease:revokedTargetClaim.lease});


  const resourceAttempts=await Promise.all([
   registry.acquireLease({resourceKey:"resource:race",ownerId:"worker-a",leaseMs:5000}),
   registry.acquireLease({resourceKey:"resource:race",ownerId:"worker-b",leaseMs:5000})
  ]);
  assert.equal(resourceAttempts.filter(Boolean).length,1,"only one worker may acquire the same resource lease");
  const resourceLeaseA=await registry.acquireLease({resourceKey:"resource:shared-doc",ownerId:winnerId,leaseMs:5000});
  assert.ok(resourceLeaseA);
  assert.equal(await registry.acquireLease({resourceKey:"resource:shared-doc",ownerId:loserId,leaseMs:5000}),null);
  const initial=await kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:winnerId,taskId:first.task.taskId,taskLease:claimedA.lease,lease:resourceLeaseA,operationId:"op-a1",idempotencyKey:"idem-a1",operationScope:"resource.update",payload:{value:1},expectedVersion:0});
  assert.equal(initial.version,1);
  const replay=await kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:winnerId,taskId:first.task.taskId,taskLease:claimedA.lease,lease:resourceLeaseA,operationId:"op-a1",idempotencyKey:"idem-a1",operationScope:"resource.update",payload:{value:1},expectedVersion:0});
  assert.equal(replay.replayed,true);
  assert.equal(replay.version,1);
  const idempotentLease=await registry.acquireLease({resourceKey:"resource:idempotent-doc",ownerId:winnerId,leaseMs:5000});
  const concurrentWriteInput={resourceId:"idempotent-doc",projectId:"one-jarvis",workerId:winnerId,taskId:first.task.taskId,taskLease:claimedA.lease,lease:idempotentLease,operationId:"op-idempotent-shared",idempotencyKey:"idem-idempotent-shared",operationScope:"resource.update",payload:{same:true},expectedVersion:0};
  const concurrentWrites=await Promise.all(Array.from({length:10},()=>runWorkerProcess("idempotency",winnerId,first.task.taskId,{JARVIS_EXECUTION_CHILD_WRITE_INPUT:JSON.stringify(concurrentWriteInput)})));
  assert.equal(concurrentWrites.filter(x=>x.replayed===false).length,1,"one process commits the idempotent operation");
  assert.equal(concurrentWrites.filter(x=>x.replayed===true).length,9,"the other nine processes receive the committed replay result");
  await pool.query("UPDATE jarvis.worker_registry SET heartbeat_at=$1 WHERE worker_id=$2",["2020-01-01T00:00:00.000Z",winnerId]);
  const prematureRecovery=await kernel.recoverExpiredWorker({workerId:winnerId});
  assert.equal(prematureRecovery.recovered,false,"a live lease must never be recovered");
  now+=5000;
  const candidates=await kernel.listExpiredWorkers({limit:20});
  assert.ok(candidates.some(x=>x.worker_id===winnerId),"expired Worker must be discoverable by the recovery scanner");
  const recovery=await kernel.recoverExpiredWorker({workerId:winnerId});
  assert.equal(recovery.recovered,true,"an expired lease permits Worker recovery");
  assert.equal(recovery.expiredTaskId,first.task.taskId);
  assert.equal(recovery.taskRecoveryState,"queued","a Task whose Worker died before execution is safely requeued");
  assert.equal((await registry.getTask(first.task.taskId)).task.state,"queued");
  assert.equal((await kernel.getWorker(winnerId)).status,"recovering");
  const recoveryAudit=await pool.query("SELECT event_type,payload FROM jarvis.events WHERE aggregate_type='worker' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[winnerId]);
  assert.equal(recoveryAudit.rows[0]?.event_type,"worker_recovered","recovery must append an audit event");
  assert.equal(recoveryAudit.rows[0]?.payload.expiredTaskId,first.task.taskId);

  const runningRecoveryTask=await makeTask("running-recovery",loserId);
  const runningRecoveryClaim=await registry.claimTaskForWorker({taskId:runningRecoveryTask.task.taskId,workerId:loserId,leaseMs:5000});
  await registry.transitionTask({taskId:runningRecoveryTask.task.taskId,expectedVersion:runningRecoveryClaim.version,lease:runningRecoveryClaim.lease,status:"running"});
  now+=5000;
  const ambiguousRecovery=await kernel.recoverExpiredWorker({workerId:loserId});
  assert.equal(ambiguousRecovery.recovered,true);
  assert.equal(ambiguousRecovery.taskRecoveryState,"outcome_unknown","a Worker lost during execution must be quarantined, not retried");
  assert.equal((await registry.getTask(runningRecoveryTask.task.taskId)).task.state,"outcome_unknown");
  const quarantinedEvent=await pool.query("SELECT event_type,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[runningRecoveryTask.task.taskId]);
  assert.equal(quarantinedEvent.rows[0]?.event_type,"worker_lease_recovered");
  assert.equal(quarantinedEvent.rows[0]?.payload.state,"outcome_unknown");
  let recoveredLoser=await kernel.getWorker(loserId);
  recoveredLoser=await kernel.transitionWorker({workerId:loserId,expectedVersion:Number(recoveredLoser.version),status:"idle"});
  await assert.rejects(registry.claimTaskForWorker({taskId:runningRecoveryTask.task.taskId,workerId:loserId,leaseMs:5000}),/Task is not claimable/);
  const claimedB=await registry.claimTaskForWorker({taskId:first.task.taskId,workerId:loserId,leaseMs:60000});
  const resourceLeaseB=await registry.acquireLease({resourceKey:"resource:shared-doc",ownerId:loserId,leaseMs:60000});
  assert.ok(resourceLeaseB);
  assert.ok(resourceLeaseB.fencingToken>resourceLeaseA.fencingToken);
  await assert.rejects(kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:winnerId,taskId:first.task.taskId,taskLease:claimedA.lease,lease:resourceLeaseA,operationId:"op-stale",idempotencyKey:"idem-stale",operationScope:"resource.update",payload:{value:"stale"},expectedVersion:1}),/expired, stale, or not owned/);
  const fresh=await kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:loserId,taskId:first.task.taskId,taskLease:claimedB.lease,lease:resourceLeaseB,operationId:"op-b1",idempotencyKey:"idem-b1",operationScope:"resource.update",payload:{value:2},expectedVersion:1});
  assert.equal(fresh.version,2);
  const stored=await pool.query("SELECT payload,version,fencing_token FROM jarvis.fenced_resources WHERE resource_id='shared-doc'");
  assert.deepEqual(stored.rows[0].payload,{value:2});
  assert.equal(Number(stored.rows[0].version),2);
  assert.equal(Number(stored.rows[0].fencing_token),resourceLeaseB.fencingToken);
  const bRunning=await registry.transitionTask({taskId:first.task.taskId,expectedVersion:claimedB.version,lease:claimedB.lease,status:"running"});
  const bCompleted=await registry.transitionTask({taskId:first.task.taskId,expectedVersion:bRunning.version,lease:claimedB.lease,status:"completed"});
  assert.equal(bCompleted.task.state,"completed");
  const workerReleased=await kernel.completeWorkerTask({workerId:loserId,taskId:first.task.taskId,lease:claimedB.lease,finalState:"completed"});
  assert.equal(workerReleased.status,"idle");
  assert.equal(workerReleased.current_task_id,null);
  assert.equal(await registry.releaseLease({lease:claimedB.lease}),true);
  await assert.rejects(kernel.writeResource({resourceId:"shared-doc",projectId:"one-jarvis",workerId:loserId,taskId:first.task.taskId,taskLease:claimedB.lease,lease:resourceLeaseB,operationId:"op-cross-scope",idempotencyKey:"idem-cross-scope",operationScope:"resource.delete",payload:{value:3},expectedVersion:2}),/Invalid or unauthorized/);
  const ops=await pool.query("SELECT count(*)::int AS count FROM jarvis.fenced_operations WHERE resource_id='shared-doc'");
  assert.equal(ops.rows[0].count,2,"only committed writes are journaled");
 } finally {try{await pool.query("DROP SCHEMA IF EXISTS jarvis CASCADE");}finally{await pool.end();}}
});
