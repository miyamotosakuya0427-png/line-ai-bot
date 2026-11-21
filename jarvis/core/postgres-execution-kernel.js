"use strict";
const crypto=require("node:crypto");
const WORKER_STATES=new Set(["idle","assigned","running","waiting","retrying","stopping","stopped","failed","recovering"]);
const OP_SCOPE=/^[a-z][a-z0-9._:-]{1,95}$/;
const ID=/^[A-Za-z0-9._:-]{1,160}$/;
function sha(v){return crypto.createHash("sha256").update(v).digest("hex");}
function canonical(v){if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";if(v&&typeof v==="object")return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";return JSON.stringify(v);}
function validId(v){return typeof v==="string"&&ID.test(v);}
function createPostgresExecutionKernel({pool,clock=()=>new Date().toISOString(),allowedOperationScopes=[]}={}){
  if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")throw new Error("PostgreSQL pool is required");
  const scopes=new Set(allowedOperationScopes);
  if([...scopes].some(x=>typeof x!=="string"||!OP_SCOPE.test(x)))throw new Error("Invalid operation scope allowlist");
  let initialized=false;
  async function init(){
    if(initialized)return {ok:true};
    const r=await pool.query("SELECT to_regclass('jarvis.coordination_leases') AS leases,to_regclass('jarvis.worker_registry') AS workers,to_regclass('jarvis.fenced_resources') AS resources,to_regclass('jarvis.fenced_operations') AS operations,EXISTS(SELECT 1 FROM jarvis.schema_migrations WHERE version='0007_execution_kernel_fencing') AS migration,EXISTS(SELECT 1 FROM jarvis.schema_migrations WHERE version='0008_worker_scope_grants') AS scope_grants");
    const x=r.rows[0]||{};
    if(!x.leases||!x.workers||!x.resources||!x.operations||x.migration!==true||x.scope_grants!==true)throw new Error("Execution kernel migration 0007 is not installed");
    initialized=true;return {ok:true};
  }
  async function tx(fn){
    const c=await pool.connect();
    try{await c.query("BEGIN");const v=await fn(c);await c.query("COMMIT");return v;}
    catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}
    finally{c.release();}
  }
  async function appendWorkerEvent(c,workerId,eventType,payload){
    const r=await c.query("SELECT COALESCE(MAX(aggregate_version),0)::bigint AS version FROM jarvis.events WHERE aggregate_type='worker' AND aggregate_id=$1",[workerId]);
    const version=Number(r.rows[0].version)+1;
    await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,created_at) VALUES('worker',$1,$2,$3,$4::jsonb,$5)",[workerId,version,eventType,JSON.stringify(payload),clock()]);
  }
  async function appendTaskRecoveryEvent(c,taskId,payload){
    const r=await c.query("SELECT COALESCE(MAX(aggregate_version),0)::bigint AS version FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1",[taskId]);
    const version=Number(r.rows[0].version)+1;
    await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,created_at) VALUES('task',$1,$2,'worker_lease_recovered',$3::jsonb,$4)",[taskId,version,JSON.stringify(payload),clock()]);
  }
  async function getLease(c,lease,{lock=true}={}){
    if(!lease||!validId(lease.resourceKey)||!validId(lease.ownerId)||typeof lease.token!=="string"||!Number.isSafeInteger(lease.fencingToken))throw new Error("A valid lease is required");
    const r=await c.query("SELECT resource_key,owner_id,token_hash,fencing_token,expires_at FROM jarvis.coordination_leases WHERE resource_key=$1"+(lock?" FOR UPDATE":""),[lease.resourceKey]);
    const row=r.rows[0];
    if(!row||row.owner_id!==lease.ownerId||row.token_hash!==sha(lease.token)||Number(row.fencing_token)!==lease.fencingToken||Date.parse(row.expires_at)<=Date.parse(clock()))throw new Error("Lease is expired, stale, or not owned by this worker");
    return row;
  }
  return {
    async init(){return init();},
    async registerWorker(input={}){
      await init();
      const {workerId,agentId,departmentId,instanceId,processId=null}=input;
      if(![workerId,agentId,departmentId,instanceId].every(validId)||(processId!==null&&!validId(processId)))throw new Error("Invalid worker registration");
      const now=clock();
      return tx(async c=>{
        const r=await c.query("INSERT INTO jarvis.worker_registry(worker_id,agent_id,department_id,instance_id,process_id,status,heartbeat_at,started_at,version,updated_at) VALUES($1,$2,$3,$4,$5,'idle',$6,$6,1,$6) ON CONFLICT(worker_id) DO UPDATE SET agent_id=EXCLUDED.agent_id,department_id=EXCLUDED.department_id,instance_id=EXCLUDED.instance_id,process_id=EXCLUDED.process_id,status='recovering',heartbeat_at=EXCLUDED.heartbeat_at,version=jarvis.worker_registry.version+1,updated_at=EXCLUDED.updated_at WHERE jarvis.worker_registry.status IN ('stopped','failed','recovering') RETURNING *",[workerId,agentId,departmentId,instanceId,processId,now]);
        if(!r.rows[0])throw new Error("Worker is already active");
        return r.rows[0];
      });
    },
    async bindWorker({workerId,taskId,lease,status="running"}={}){
      await init();
      if(!validId(workerId)||!validId(taskId)||!["assigned","running"].includes(status))throw new Error("Invalid worker binding");
      return tx(async c=>{
        await getLease(c,lease);
        if(lease.ownerId!==workerId||lease.resourceKey!=="task:"+taskId)throw new Error("Task lease does not belong to worker");
        const now=clock();
        const r=await c.query("UPDATE jarvis.worker_registry SET current_task_id=$1,lease_resource_key=$2,fencing_token=$3,status=$4,heartbeat_at=$5,version=version+1,updated_at=$5 WHERE worker_id=$6 AND status IN ('idle','assigned','running','recovering') RETURNING *",[taskId,lease.resourceKey,lease.fencingToken,status,now,workerId]);
        if(!r.rows[0])throw new Error("Worker is not available for task binding");
        return r.rows[0];
      });
    },
    async heartbeatWorker({workerId,lease}={}){
      await init();
      if(!validId(workerId))throw new Error("Invalid worker ID");
      return tx(async c=>{
        await getLease(c,lease);
        const now=clock();
        const r=await c.query("UPDATE jarvis.worker_registry SET heartbeat_at=$1,version=version+1,updated_at=$1 WHERE worker_id=$2 AND lease_resource_key=$3 AND fencing_token=$4 AND status IN ('assigned','running','waiting','retrying') RETURNING *",[now,workerId,lease.resourceKey,lease.fencingToken]);
        if(!r.rows[0])throw new Error("Worker heartbeat rejected");
        return r.rows[0];
      });
    },
    async recoverExpiredWorker({workerId}={}){
      await init();
      if(!validId(workerId))throw new Error("Invalid worker ID");
      return tx(async c=>{
        // Read the lease key without locking, then lock Lease -> Worker.
        // claimTaskForWorker uses the same order; Worker -> Lease here could deadlock.
        const snapshot=await c.query("SELECT lease_resource_key FROM jarvis.worker_registry WHERE worker_id=$1",[workerId]);
        if(!snapshot.rows[0])return null;
        const leaseKey=snapshot.rows[0].lease_resource_key;
        let leaseRow=null;
        if(leaseKey){
          const lease=await c.query("SELECT owner_id,token_hash,expires_at,fencing_token FROM jarvis.coordination_leases WHERE resource_key=$1 FOR UPDATE",[leaseKey]);
          leaseRow=lease.rows[0]||null;
          if(!leaseRow)throw new Error("Worker lease record is missing; quarantine required");
        }
        const r=await c.query("SELECT status,current_task_id,lease_resource_key,fencing_token,version FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        const worker=r.rows[0];
        if(!worker)return null;
        if(!worker.lease_resource_key||!worker.current_task_id)return {recovered:false,reason:"worker has no active task lease"};
        if(worker.lease_resource_key!==leaseKey)return {recovered:false,reason:"worker lease changed during recovery; retry scan"};
        if(!leaseRow)throw new Error("Worker lease record is missing; quarantine required");
        if(Date.parse(leaseRow.expires_at)>Date.parse(clock()))return {recovered:false,reason:"lease is still active"};
        if(Number(leaseRow.fencing_token)!==Number(worker.fencing_token)||leaseRow.owner_id!==workerId)throw new Error("Worker fencing token or owner does not match expired lease; quarantine required");
        const taskResult=await c.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[worker.current_task_id]);
        const taskRow=taskResult.rows[0];
        if(!taskRow)throw new Error("Worker references a missing Task; quarantine required");
        const task=taskRow.payload;
        if(task.leaseOwner!==workerId||Number(task.fencingToken)!==Number(worker.fencing_token)||task.leaseTokenHash!==leaseRow.token_hash)throw new Error("Task and Worker fencing metadata disagree; quarantine required");
        const legacy={verified:"completed",in_progress:"running",ready:"queued",blocked:"waiting",review:"waiting_approval",proposed:"pending"};
        const taskState=task.state||legacy[task.status]||task.status;
        let taskRecoveryState=taskState;
        const now=clock();
        if(taskState==="running"){
          const recoveredTask={...task,status:"outcome_unknown",state:"outcome_unknown",leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,outcomeUnknownReason:"Worker lease expired during execution; explicit reconciliation is required",nextAction:"Reconcile external side effects before any retry",updatedAt:now};
          await appendTaskRecoveryEvent(c,worker.current_task_id,recoveredTask);
          taskRecoveryState="outcome_unknown";
        }else if(taskState==="claimed"){
          const recoveredTask={...task,status:"ready",state:"queued",leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,recoveredFromStatus:"claimed",recoveredAt:now,nextAction:"Requeue after lease expired before execution",updatedAt:now};
          await appendTaskRecoveryEvent(c,worker.current_task_id,recoveredTask);
          taskRecoveryState="queued";
        }
        const updated=await c.query("UPDATE jarvis.worker_registry SET status='recovering',current_task_id=NULL,lease_resource_key=NULL,fencing_token=NULL,stopped_at=$1,version=version+1,updated_at=$1 WHERE worker_id=$2 AND version=$3 RETURNING *",[now,workerId,Number(worker.version)]);
        if(!updated.rows[0])throw new Error("Worker recovery lost an optimistic concurrency race");
        await appendWorkerEvent(c,workerId,"worker_recovered",{workerId,expiredTaskId:worker.current_task_id,leaseResourceKey:leaseKey,expiredFencingToken:Number(worker.fencing_token),taskRecoveryState,recoveredAt:now,workerVersion:Number(updated.rows[0].version)});
        return {recovered:true,worker:updated.rows[0],expiredTaskId:worker.current_task_id,expiredFencingToken:Number(worker.fencing_token),taskRecoveryState};
      });
    },
    async listExpiredWorkers({limit=50}={}){
      await init();
      if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error("Invalid recovery candidate limit");
      const r=await pool.query("SELECT w.worker_id,w.current_task_id,w.lease_resource_key,w.fencing_token,w.heartbeat_at,l.expires_at FROM jarvis.worker_registry w JOIN jarvis.coordination_leases l ON l.resource_key=w.lease_resource_key WHERE w.current_task_id IS NOT NULL AND w.lease_resource_key IS NOT NULL AND w.status IN ('assigned','running','waiting','retrying','stopping') AND l.expires_at<=$1::timestamptz ORDER BY l.expires_at ASC,w.worker_id ASC LIMIT $2",[clock(),limit]);
      return r.rows;
    },
    async recoverExpiredWorkers({limit=50}={}){
      const candidates=await this.listExpiredWorkers({limit});
      const results=[];
      for(const candidate of candidates)results.push({workerId:candidate.worker_id,...await this.recoverExpiredWorker({workerId:candidate.worker_id})});
      return results;
    },
    async completeWorkerTask({workerId,taskId,lease,finalState}={}){
      await init();
      if(!validId(workerId)||!validId(taskId)||!["completed","failed","outcome_unknown","quarantined","cancelled","waiting","retry_wait"].includes(finalState))throw new Error("Invalid Worker task completion");
      return tx(async c=>{
        await getLease(c,lease);
        if(lease.ownerId!==workerId||lease.resourceKey!=="task:"+taskId)throw new Error("Task lease does not belong to Worker");
        const current=await c.query("SELECT status,current_task_id,lease_resource_key,fencing_token,version FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        const worker=current.rows[0];
        if(!worker||worker.current_task_id!==taskId||worker.lease_resource_key!==lease.resourceKey||Number(worker.fencing_token)!==lease.fencingToken)throw new Error("Worker task binding is stale");
        const task=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[taskId]);
        const payload=task.rows[0]?.payload;
        const legacy={verified:"completed",in_progress:"running",ready:"queued",blocked:"waiting",review:"waiting_approval",proposed:"pending"};
        const persistedState=payload?.state||legacy[payload?.status]||payload?.status;
        if(persistedState!==finalState)throw new Error("Worker cannot be released before the matching Task state is durable");
        const now=clock();
        const updated=await c.query("UPDATE jarvis.worker_registry SET status='idle',current_task_id=NULL,lease_resource_key=NULL,fencing_token=NULL,version=version+1,updated_at=$1 WHERE worker_id=$2 AND version=$3 RETURNING *",[now,workerId,Number(worker.version)]);
        if(updated.rowCount!==1)throw new Error("Worker release lost an optimistic concurrency race");
        await appendWorkerEvent(c,workerId,"worker_task_released",{workerId,taskId,finalState,fencingToken:lease.fencingToken,releasedAt:now,workerVersion:Number(updated.rows[0].version)});
        return updated.rows[0];
      });
    },
    async transitionWorker({workerId,expectedVersion,status}={}){
      await init();
      if(!validId(workerId)||!Number.isSafeInteger(expectedVersion)||!WORKER_STATES.has(status))throw new Error("Invalid worker transition");
      const allowed={idle:["assigned","stopped"],assigned:["running","waiting","stopping","failed"],running:["waiting","retrying","stopping","stopped","failed"],waiting:["running","retrying","stopping","failed"],retrying:["running","waiting","stopping","failed"],stopping:["stopped","failed"],recovering:["idle","assigned","failed"],stopped:["recovering"],failed:["recovering"]};
      return tx(async c=>{
        const current=await c.query("SELECT status,version FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        if(!current.rows[0])return null;
        if(Number(current.rows[0].version)!==expectedVersion)throw new Error("Stale worker version");
        if(!allowed[current.rows[0].status]?.includes(status))throw new Error("Invalid worker state transition");
        const now=clock();
        const r=await c.query("UPDATE jarvis.worker_registry SET status=$1,stopped_at=CASE WHEN $1 IN ('stopped','failed') THEN $2 ELSE stopped_at END,version=version+1,updated_at=$2 WHERE worker_id=$3 RETURNING *",[status,now,workerId]);
        return r.rows[0];
      });
    },
    async grantWorkerScope({workerId,projectId,conversationId,grantedBy}={}){
      await init();
      if(![workerId,projectId,conversationId,grantedBy].every(validId))throw new Error("Invalid Worker scope grant");
      const grantId=crypto.randomUUID(),now=clock();
      return tx(async c=>{
        const w=await c.query("SELECT worker_id FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        if(!w.rows[0])throw new Error("Worker is not registered");
        const prior=await c.query("SELECT grant_id FROM jarvis.worker_scope_grants WHERE worker_id=$1 AND project_id=$2 AND conversation_id=$3 AND revoked_at IS NULL FOR UPDATE",[workerId,projectId,conversationId]);
        if(prior.rows[0])return {created:false,grantId:prior.rows[0].grant_id};
        await c.query("INSERT INTO jarvis.worker_scope_grants(grant_id,worker_id,project_id,conversation_id,granted_by,created_at) VALUES($1,$2,$3,$4,$5,$6)",[grantId,workerId,projectId,conversationId,grantedBy,now]);
        await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,created_at) VALUES('worker_scope_grant',$1,1,'scope_granted',$2::jsonb,$3)",[grantId,JSON.stringify({grantId,workerId,projectId,conversationId,grantedBy,createdAt:now}),now]);
        return {created:true,grantId};
      });
    },
    async revokeWorkerScope({grantId,revokedBy}={}){
      await init();
      if(typeof grantId!=="string"||!/^[0-9a-f-]{36}$/i.test(grantId)||!validId(revokedBy))throw new Error("Invalid Worker scope revocation");
      const snapshot=await pool.query("SELECT worker_id FROM jarvis.worker_scope_grants WHERE grant_id=$1",[grantId]);
      if(!snapshot.rows[0])return {revoked:false,reason:"grant not found"};
      const now=clock();
      return tx(async c=>{
        // Match claim lock order: Worker row before Grant row.
        await c.query("SELECT worker_id FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[snapshot.rows[0].worker_id]);
        const current=await c.query("SELECT grant_id,worker_id,project_id,conversation_id,revoked_at FROM jarvis.worker_scope_grants WHERE grant_id=$1 FOR UPDATE",[grantId]);
        if(!current.rows[0])return {revoked:false,reason:"grant not found"};
        if(current.rows[0].revoked_at)return {revoked:false,reason:"already revoked"};
        const g=current.rows[0];
        await c.query("UPDATE jarvis.worker_scope_grants SET revoked_at=$1,revoked_by=$2,version=version+1 WHERE grant_id=$3 AND revoked_at IS NULL",[now,revokedBy,grantId]);
        const stopping=await c.query("UPDATE jarvis.worker_registry SET status=CASE WHEN current_task_id IS NULL THEN status ELSE 'stopping' END,version=version+1,updated_at=$1 WHERE worker_id=$2 AND current_task_id IS NOT NULL RETURNING current_task_id,version",[now,g.worker_id]);
        if(stopping.rows[0])await appendWorkerEvent(c,g.worker_id,"worker_scope_revoked",{workerId:g.worker_id,grantId,activeTaskId:stopping.rows[0].current_task_id,revokedAt:now,workerVersion:Number(stopping.rows[0].version)});
        await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,created_at) VALUES('worker_scope_grant',$1,2,'scope_revoked',$2::jsonb,$3)",[grantId,JSON.stringify({grantId,workerId:g.worker_id,projectId:g.project_id,conversationId:g.conversation_id,revokedBy,revokedAt:now}),now]);
        return {revoked:true,grantId,workerId:g.worker_id};
      });
    },
    async listWorkerScopeGrants({limit=200}={}) {
      await init();
      if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error("Invalid Worker scope grant limit");
      const r=await pool.query(
        "SELECT g.grant_id,g.worker_id,g.project_id,g.conversation_id,g.granted_by,g.created_at AS granted_at,g.revoked_by,g.revoked_at,g.version AS grant_version,"+
        "w.agent_id,w.department_id,w.status AS worker_status,w.current_task_id,w.heartbeat_at,"+
        "l.expires_at AS lease_expires_at,l.fencing_token AS lease_fencing_token "+
        "FROM jarvis.worker_scope_grants g JOIN jarvis.worker_registry w ON w.worker_id=g.worker_id "+
        "LEFT JOIN jarvis.coordination_leases l ON l.resource_key=w.lease_resource_key "+
        "ORDER BY g.created_at DESC,g.grant_id LIMIT $1",[limit]);
      return r.rows;
    },
    async listWorkersForScope({projectId,conversationId}={}){
      await init();
      if(!validId(projectId)||!validId(conversationId))throw new Error("Invalid Worker listing scope");
      const r=await pool.query("SELECT w.*,l.expires_at AS lease_expires_at,l.owner_id AS lease_owner,l.fencing_token AS lease_fencing_token,g.grant_id,g.granted_by,g.created_at AS grant_created_at FROM jarvis.worker_scope_grants g JOIN jarvis.worker_registry w ON w.worker_id=g.worker_id LEFT JOIN jarvis.coordination_leases l ON l.resource_key=w.lease_resource_key WHERE g.project_id=$1 AND g.conversation_id=$2 AND g.revoked_at IS NULL ORDER BY w.worker_id",[projectId,conversationId]);
      return r.rows;
    },
    async getWorker(workerId){
      await init();
      const r=await pool.query("SELECT w.*,l.expires_at AS lease_expires_at,l.owner_id AS lease_owner,l.fencing_token AS lease_fencing_token FROM jarvis.worker_registry w LEFT JOIN jarvis.coordination_leases l ON l.resource_key=w.lease_resource_key WHERE w.worker_id=$1",[workerId]);
      return r.rows[0]||null;
    },
    async writeResource(input={}){
      await init();
      const {resourceId,projectId,workerId,taskId,lease,taskLease,operationId,idempotencyKey,operationScope,payload,expectedVersion}=input;
      if(![resourceId,projectId,workerId,taskId,operationId,idempotencyKey].every(validId)||!OP_SCOPE.test(operationScope||"")||!scopes.has(operationScope)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||payload===undefined)throw new Error("Invalid or unauthorized fenced write request");
      const payloadJson=canonical(payload),payloadHash=sha(payloadJson),now=clock();
      return tx(async c=>{
        await getLease(c,lease);
        await getLease(c,taskLease);
        if(lease.ownerId!==workerId||lease.resourceKey!=="resource:"+resourceId)throw new Error("Resource lease owner or key does not match worker and resource");
        if(taskLease.ownerId!==workerId||taskLease.resourceKey!=="task:"+taskId)throw new Error("Task lease owner or key does not match worker and task");
        const w=await c.query("SELECT status,current_task_id,lease_resource_key,fencing_token FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        const worker=w.rows[0];
        if(!worker||worker.status!=="running"||worker.current_task_id!==taskId||worker.lease_resource_key!==taskLease.resourceKey||Number(worker.fencing_token)!==taskLease.fencingToken)throw new Error("Worker does not own the active task lease");
        const task=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1 FOR SHARE",[taskId]);
        const taskState=task.rows[0]?.payload;
        if(!taskState||!["claimed","running","in_progress"].includes(taskState.state||taskState.status)||taskState.leaseOwner!==workerId||Number(taskState.fencingToken)!==taskLease.fencingToken||taskState.projectId!==projectId)throw new Error("Task is not actively owned by this worker");
        const grant=await c.query("SELECT grant_id FROM jarvis.worker_scope_grants WHERE worker_id=$1 AND project_id=$2 AND conversation_id=$3 AND revoked_at IS NULL FOR SHARE",[workerId,projectId,taskState.ownerConversation]);
        if(!grant.rows[0])throw new Error("Worker Project/Conversation scope grant is missing or revoked");
        // Serialize both operation-ID and idempotency-key races before reading
        // the journal. Sorted advisory locks avoid lock-order inversion.
        const operationLocks=["fenced-operation:"+operationId,"fenced-idempotency:"+idempotencyKey].sort();
        for(const lockKey of operationLocks)await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[lockKey]);
        const prior=await c.query("SELECT * FROM jarvis.fenced_operations WHERE operation_id=$1 OR idempotency_key=$2 FOR UPDATE",[operationId,idempotencyKey]);
        if(prior.rows[0]){
          const p=prior.rows[0];
          if(p.operation_id!==operationId||p.idempotency_key!==idempotencyKey||p.resource_id!==resourceId||p.payload_hash!==payloadHash||p.worker_id!==workerId||p.task_id!==taskId||p.operation_scope!==operationScope)throw new Error("Operation or idempotency key was replayed with different content");
          return {replayed:true,version:Number(p.result_version)};
        }
        const current=await c.query("SELECT version,fencing_token FROM jarvis.fenced_resources WHERE resource_id=$1 AND project_id=$2 FOR UPDATE",[resourceId,projectId]);
        const currentVersion=current.rows[0]?Number(current.rows[0].version):0;
        if(currentVersion!==expectedVersion)throw new Error("Stale resource version");
        if(current.rows[0]&&Number(current.rows[0].fencing_token)>lease.fencingToken)throw new Error("Stale fencing token rejected at database write boundary");
        const nextVersion=currentVersion+1;
        const write=await c.query("INSERT INTO jarvis.fenced_resources(resource_id,project_id,payload,version,fencing_token,updated_at) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(resource_id) DO UPDATE SET payload=EXCLUDED.payload,version=EXCLUDED.version,fencing_token=EXCLUDED.fencing_token,updated_at=EXCLUDED.updated_at WHERE jarvis.fenced_resources.project_id=EXCLUDED.project_id AND jarvis.fenced_resources.version=$7 AND jarvis.fenced_resources.fencing_token<=EXCLUDED.fencing_token",[resourceId,projectId,payloadJson,nextVersion,lease.fencingToken,now,currentVersion]);
        if(write.rowCount!==1)throw new Error("Concurrent or stale resource write rejected");
        await c.query("INSERT INTO jarvis.fenced_operations(operation_id,idempotency_key,resource_id,project_id,worker_id,task_id,lease_resource_key,fencing_token,operation_scope,payload_hash,result_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[operationId,idempotencyKey,resourceId,projectId,workerId,taskId,lease.resourceKey,lease.fencingToken,operationScope,payloadHash,nextVersion,now]);
        return {replayed:false,version:nextVersion,fencingToken:lease.fencingToken};
      });
    }
  };
}
module.exports={createPostgresExecutionKernel,WORKER_STATES};
