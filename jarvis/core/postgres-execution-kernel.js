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
    const r=await pool.query("SELECT to_regclass('jarvis.coordination_leases') AS leases,to_regclass('jarvis.worker_registry') AS workers,to_regclass('jarvis.fenced_resources') AS resources,to_regclass('jarvis.fenced_operations') AS operations,EXISTS(SELECT 1 FROM jarvis.schema_migrations WHERE version='0007_execution_kernel_fencing') AS migration");
    const x=r.rows[0]||{};
    if(!x.leases||!x.workers||!x.resources||!x.operations||x.migration!==true)throw new Error("Execution kernel migration 0007 is not installed");
    initialized=true;return {ok:true};
  }
  async function tx(fn){
    const c=await pool.connect();
    try{await c.query("BEGIN");const v=await fn(c);await c.query("COMMIT");return v;}
    catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}
    finally{c.release();}
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
        const r=await c.query("SELECT status,current_task_id,lease_resource_key,fencing_token FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        const worker=r.rows[0];
        if(!worker)return null;
        if(!worker.lease_resource_key||!worker.current_task_id)return {recovered:false,reason:"worker has no active task lease"};
        const lease=await c.query("SELECT expires_at,fencing_token FROM jarvis.coordination_leases WHERE resource_key=$1 FOR UPDATE",[worker.lease_resource_key]);
        if(!lease.rows[0])throw new Error("Worker lease record is missing; quarantine required");
        if(Date.parse(lease.rows[0].expires_at)>Date.parse(clock()))return {recovered:false,reason:"lease is still active"};
        if(Number(lease.rows[0].fencing_token)!==Number(worker.fencing_token))throw new Error("Worker fencing token does not match expired lease; quarantine required");
        const now=clock();
        const updated=await c.query("UPDATE jarvis.worker_registry SET status='recovering',current_task_id=NULL,lease_resource_key=NULL,fencing_token=NULL,stopped_at=$1,version=version+1,updated_at=$1 WHERE worker_id=$2 AND version=(SELECT version FROM jarvis.worker_registry WHERE worker_id=$2) RETURNING *",[now,workerId]);
        if(!updated.rows[0])throw new Error("Worker recovery lost an optimistic concurrency race");
        return {recovered:true,worker:updated.rows[0],expiredTaskId:worker.current_task_id,expiredFencingToken:Number(worker.fencing_token)};
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
    async getWorker(workerId){
      await init();
      const r=await pool.query("SELECT * FROM jarvis.worker_registry WHERE worker_id=$1",[workerId]);
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
        if(!taskState||!["claimed","in_progress"].includes(taskState.status)||taskState.leaseOwner!==workerId||Number(taskState.fencingToken)!==taskLease.fencingToken||taskState.projectId!==projectId)throw new Error("Task is not actively owned by this worker");
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
