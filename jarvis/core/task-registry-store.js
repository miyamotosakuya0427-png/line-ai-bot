"use strict";
const crypto = require("node:crypto");

const {ALL_TASK_STATES,canonicalTaskState,canTransitionTask}=require("./task-state-machine");
const TASK_STATES = ALL_TASK_STATES;
const PATCH_FIELDS = new Set(["scope","ownerConversation","ownerAgent","departmentId","priority","branch","baseBranch","headSha","pullRequest","dependencyTaskIds","changedPaths","testRunIds","verificationSummary","blockerIds","nextAction","startedAt","completedAt","outcomeUnknownReason","reconciliationId","reconciledBy"]);
const MAX_TITLE=240, MAX_SCOPE=12000, MAX_OWNER=128, MAX_DEDUPE=240;
function text(value,max,required=true){return typeof value==="string"&&value.length<=max&&(!required||!!value.trim());}
function clone(value){return JSON.parse(JSON.stringify(value));}
function hash(value){return crypto.createHash("sha256").update(value).digest("hex");}
function validateHandoffRoute(history,fromDepartmentId,toDepartmentId,maxHandoffs=8){
  if(!text(fromDepartmentId,128)||!text(toDepartmentId,128)||fromDepartmentId===toDepartmentId)throw new Error("Handoff must target a different department");
  if(!Array.isArray(history)||!Number.isInteger(maxHandoffs)||maxHandoffs<1||maxHandoffs>32)throw new Error("Invalid handoff route history");
  if(history.length>=maxHandoffs)throw new Error("Handoff limit exceeded");
  const visited=new Set([fromDepartmentId]);
  for(const row of history){
    const payload=row?.payload||{};
    if(typeof payload.fromDepartmentId==="string")visited.add(payload.fromDepartmentId);
    if(typeof payload.toDepartmentId==="string")visited.add(payload.toDepartmentId);
  }
  if(visited.has(toDepartmentId))throw new Error("Handoff department cycle detected");
  return true;
}

function createTaskRegistry({pool,clock=()=>new Date().toISOString(),tokenFactory=()=>crypto.randomBytes(32).toString("base64url")}={}){
  if(!pool||typeof pool.connect!=="function")throw new Error("PostgreSQL pool is required");
  let initialized=false;
  async function init(){
    if(initialized)return {ok:true};
    const r=await pool.query("SELECT to_regclass('jarvis.events') AS events, to_regclass('jarvis.coordination_leases') AS leases");
    if(!r.rows[0]?.events||!r.rows[0]?.leases)throw new Error("Task Registry migration 0004 is not installed");
    initialized=true;return {ok:true};
  }
  async function tx(fn){
    const c=await pool.connect();
    try{await c.query("BEGIN");const result=await fn(c);await c.query("COMMIT");return result;}
    catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}
    finally{c.release();}
  }
  async function lock(c,key){await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[key]);}
  async function latest(c,id){
    const r=await c.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[id]);
    return r.rows[0]?{version:Number(r.rows[0].aggregate_version),task:r.rows[0].payload}:null;
  }
  async function append(c,id,eventType,payload,idempotencyKey=null){
    const r=await c.query("SELECT COALESCE(MAX(aggregate_version),0)::bigint AS version FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1",[id]);
    const version=Number(r.rows[0].version)+1;
    await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,idempotency_key,created_at) VALUES('task',$1,$2,$3,$4::jsonb,$5,$6)",[id,version,eventType,JSON.stringify(payload),idempotencyKey,clock()]);
    return version;
  }
  async function appendCoordinationEvent(c,resourceKey,eventType,payload){
    await lock(c,"coordination-lease:"+resourceKey);
    const r=await c.query("SELECT COALESCE(MAX(aggregate_version),0)::bigint AS version FROM jarvis.events WHERE aggregate_type='coordination_lease' AND aggregate_id=$1",[resourceKey]);
    const version=Number(r.rows[0].version)+1;
    await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,created_at) VALUES('coordination_lease',$1,$2,$3,$4::jsonb,$5)",[resourceKey,version,eventType,JSON.stringify(payload),clock()]);
    return version;
  }
  async function validateDependencies(c,taskId,dependencyTaskIds){
    const dependencies=[...new Set(dependencyTaskIds||[])];
    if(dependencies.length!==(dependencyTaskIds||[]).length||dependencies.includes(taskId))throw new Error("Invalid task dependencies");
    const r=await c.query("SELECT DISTINCT ON (aggregate_id) aggregate_id,payload FROM jarvis.events WHERE aggregate_type='task' ORDER BY aggregate_id,aggregate_version DESC");
    const graph=new Map(r.rows.map(row=>[row.aggregate_id,row.payload.dependencyTaskIds||[]]));
    graph.set(taskId,dependencies);
    const visited=new Set(),visiting=new Set();
    function visit(id){
      if(id===taskId&&visiting.size)throw new Error("Task dependency cycle detected");
      if(visiting.has(id))throw new Error("Task dependency cycle detected");
      if(visited.has(id))return;
      if(!graph.has(id))throw new Error("Dependency task does not exist");
      visiting.add(id);
      for(const dependencyId of graph.get(id)||[])visit(dependencyId);
      visiting.delete(id);visited.add(id);
    }
    for(const dependencyId of dependencies)visit(dependencyId);
  }
  function validateLeaseInput({resourceKey,ownerId,leaseMs}){
    if(!text(resourceKey,240)||!text(ownerId,MAX_OWNER)||!Number.isInteger(leaseMs)||leaseMs<5000||leaseMs>3600000)throw new Error("Invalid lease request");
  }
  async function acquireInTx(c,{resourceKey,ownerId,leaseMs}){
    validateLeaseInput({resourceKey,ownerId,leaseMs});
    const token=tokenFactory();
    if(!text(token,256))throw new Error("Lease token generator returned an invalid token");
    const tokenHash=hash(token),now=clock(),expiresAt=new Date(Date.parse(now)+leaseMs).toISOString();
    const r=await c.query(
      "INSERT INTO jarvis.coordination_leases(resource_key,owner_id,token_hash,fencing_token,expires_at,created_at,updated_at) VALUES($1,$2,$3,1,$4,$5,$5) ON CONFLICT(resource_key) DO UPDATE SET owner_id=EXCLUDED.owner_id,token_hash=EXCLUDED.token_hash,fencing_token=jarvis.coordination_leases.fencing_token+1,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at WHERE jarvis.coordination_leases.expires_at <= $5::timestamptz RETURNING fencing_token,expires_at",
      [resourceKey,ownerId,tokenHash,expiresAt,now]
    );
    if(!r.rows[0])return null;
    const lease={resourceKey,ownerId,token,fencingToken:Number(r.rows[0].fencing_token),expiresAt:r.rows[0].expires_at};
    await appendCoordinationEvent(c,resourceKey,"lease_acquired",{resourceKey,ownerId,tokenHash,fencingToken:lease.fencingToken,expiresAt:lease.expiresAt});
    return lease;
  }
  async function assertLease(c,lease){
    if(!lease||!text(lease.resourceKey,240)||!text(lease.ownerId,MAX_OWNER)||!text(lease.token,256)||!Number.isSafeInteger(lease.fencingToken))throw new Error("Current lease is required");
    const r=await c.query("SELECT 1 FROM jarvis.coordination_leases WHERE resource_key=$1 AND owner_id=$2 AND token_hash=$3 AND fencing_token=$4 AND expires_at > $5::timestamptz FOR UPDATE",[lease.resourceKey,lease.ownerId,hash(lease.token),lease.fencingToken,clock()]);
    if(!r.rows[0])throw new Error("Lease is expired, stale, or not owned by this caller");
  }
  async function transitionInTx(c,{taskId,expectedVersion,lease,status,patch={}}){
    if(!TASK_STATES.has(status))throw new Error("Invalid task status");
    if(!patch||typeof patch!=="object"||Array.isArray(patch)||Object.keys(patch).some(key=>!PATCH_FIELDS.has(key)))throw new Error("Invalid task patch");
    await assertLease(c,lease);
    if(lease.resourceKey!=="task:"+taskId)throw new Error("Task lease resource does not match task");
    await lock(c,"task:"+taskId);
    const current=await latest(c,taskId);
    if(!current)return null;
    if(current.version!==expectedVersion)throw new Error("Stale task version");
    if(!canTransitionTask(current.task.status||current.task.state,status))throw new Error("Invalid task state transition");
    const nextState=canonicalTaskState(status);
    if(canonicalTaskState(current.task.status||current.task.state)==="outcome_unknown"&&["completed","failed"].includes(nextState)&&(!text(patch.reconciliationId,128)||!text(patch.reconciledBy,128)))throw new Error("Outcome reconciliation ID and human/operator identity are required");
    if(nextState==="completed"){
      await lock(c,"task-parent:"+taskId);
      const children=await c.query("SELECT DISTINCT ON (aggregate_id) aggregate_id,payload FROM jarvis.events WHERE aggregate_type='task' ORDER BY aggregate_id,aggregate_version DESC");
      const required=children.rows.filter(row=>row.payload.parentTaskId===taskId);
      if(required.some(row=>canonicalTaskState(row.payload.state||row.payload.status)!=="completed"))throw new Error("Parent task cannot complete before every child task is completed");
    }
    if(current.task.parentTaskId&&(nextState==="completed"||nextState==="failed"))await lock(c,"task-parent:"+current.task.parentTaskId);
    if(Object.prototype.hasOwnProperty.call(patch,"dependencyTaskIds")){
      await lock(c,"task-dependency-graph");
      await validateDependencies(c,taskId,patch.dependencyTaskIds);
    }
    const next={...current.task,...clone(patch),status,state:nextState,updatedAt:clock(),fencingToken:lease.fencingToken,...(nextState==="completed"?{completedAt:clock()}: {})};
    await append(c,taskId,"status_changed",next);
    return {task:clone(next),version:current.version+1};
  }
  return {
    async init(){return init();},
    async createTask(input={}){
      await init();
      const {title,scope="",acceptanceCriteria=[],dedupeKey,projectId="one-jarvis",ownerConversation="unassigned",ownerAgent="unassigned",departmentId="general",priority="P2",status="proposed",dependencyTaskIds=[],parentTaskId=null}=input;
      if(!text(title,MAX_TITLE)||!text(scope,MAX_SCOPE,false)||!text(dedupeKey,MAX_DEDUPE)||!text(projectId,128)||!text(ownerConversation,MAX_OWNER)||!text(ownerAgent,MAX_OWNER)||!text(departmentId,128)||!["P0","P1","P2","P3"].includes(priority)||!TASK_STATES.has(status)||!Array.isArray(acceptanceCriteria)||acceptanceCriteria.length>100||acceptanceCriteria.some(x=>!text(x,1000))||!Array.isArray(dependencyTaskIds)||dependencyTaskIds.length>100||dependencyTaskIds.some(x=>!text(x,80))||(parentTaskId!==null&&!text(parentTaskId,80)))throw new Error("Invalid task input");
      const id=crypto.randomUUID(),now=clock();
      const task={taskId:id,dedupeKey,projectId,title,scope,acceptanceCriteria:[...acceptanceCriteria],ownerConversation,ownerAgent,departmentId,priority,status,state:canonicalTaskState(status),parentTaskId,dependencyTaskIds:[...new Set(dependencyTaskIds)],branch:null,baseBranch:null,headSha:null,pullRequest:null,createdAt:now,updatedAt:now,startedAt:null,completedAt:null,leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,fencingToken:0,changedPaths:[],testRunIds:[],verificationSummary:null,blockerIds:[],nextAction:null};
      return tx(async c=>{
        if(parentTaskId){await lock(c,"task-parent:"+parentTaskId);const parent=await latest(c,parentTaskId);if(!parent||["completed","cancelled"].includes(canonicalTaskState(parent.task.state||parent.task.status)))throw new Error("Parent task is missing or terminal");if(parent.task.projectId!==projectId||parent.task.ownerConversation!==ownerConversation)throw new Error("Parent task scope mismatch");}
        await lock(c,"task-dedupe:"+dedupeKey);
        const existing=await c.query("SELECT aggregate_id,payload FROM jarvis.events WHERE aggregate_type='task' AND event_type='created' AND payload->>'dedupeKey'=$1 AND payload->>'ownerAgent'=$2 AND payload->>'ownerConversation'=$3 AND payload->>'projectId'=$4 LIMIT 1",[dedupeKey,ownerAgent,ownerConversation,projectId]);
        if(existing.rows[0])return {task:clone(existing.rows[0].payload),created:false,version:1};
        await lock(c,"task-dependency-graph");
        await validateDependencies(c,id,task.dependencyTaskIds);
        const scopedIdempotencyKey=hash(JSON.stringify([projectId,ownerAgent,ownerConversation,dedupeKey]));
        await append(c,id,"created",task,scopedIdempotencyKey);
        return {task:clone(task),created:true,version:1};
      });
    },
    async getTask(taskId,{ownerAgent=null,ownerConversation=null,projectId=null}={}){
      await init();
      const r=await pool.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[taskId]);
      if(!r.rows[0])return null;
      const task=r.rows[0].payload;
      if(ownerAgent!==null&&task.ownerAgent!==ownerAgent)return null;
      if(ownerConversation!==null&&task.ownerConversation!==ownerConversation)return null;
      if(projectId!==null&&task.projectId!==projectId)return null;
      return {task:clone(task),version:Number(r.rows[0].aggregate_version)};
    },
    async listTasks({status=null,limit=50,offset=0,ownerAgent=null,ownerConversation=null,projectId=null}={}){
      await init();
      if(status!==null&&!TASK_STATES.has(status))throw new Error("Invalid task status");
      if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid task limit");
      if(!Number.isInteger(offset)||offset<0||offset>1000000)throw new Error("Invalid task offset");
      const r=await pool.query(
        "SELECT aggregate_id,aggregate_version,payload FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id,aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' ORDER BY aggregate_id,aggregate_version DESC) latest WHERE ($1::text IS NULL OR payload->>'status'=$1 OR payload->>'state'=$1) AND ($2::text IS NULL OR payload->>'ownerAgent'=$2) AND ($3::text IS NULL OR payload->>'ownerConversation'=$3) AND ($4::text IS NULL OR payload->>'projectId'=$4) ORDER BY payload->>'updatedAt' DESC,aggregate_id ASC LIMIT $5 OFFSET $6",
        [status,ownerAgent,ownerConversation,projectId,limit,offset]
      );
      return r.rows.map(x=>({task:clone(x.payload),version:Number(x.aggregate_version)}));
    },
    async acquireLease(input={}){
      await init();
      return tx(async c=>acquireInTx(c,input));
    },
    async heartbeatLease({lease,leaseMs=60000}={}){
      await init();
      if(!Number.isInteger(leaseMs)||leaseMs<5000||leaseMs>3600000)throw new Error("Invalid lease duration");
      return tx(async c=>{
        await assertLease(c,lease);
        const now=clock(),expiresAt=new Date(Date.parse(now)+leaseMs).toISOString();
        const r=await c.query("UPDATE jarvis.coordination_leases SET expires_at=$1,updated_at=$2 WHERE resource_key=$3 AND owner_id=$4 AND token_hash=$5 AND fencing_token=$6 AND expires_at>$2::timestamptz RETURNING expires_at",[expiresAt,now,lease.resourceKey,lease.ownerId,hash(lease.token),lease.fencingToken]);
        if(!r.rows[0])throw new Error("Lease heartbeat rejected");
        const renewed={...lease,expiresAt:r.rows[0].expires_at};
        await appendCoordinationEvent(c,lease.resourceKey,"lease_heartbeat",{resourceKey:lease.resourceKey,ownerId:lease.ownerId,tokenHash:hash(lease.token),fencingToken:lease.fencingToken,expiresAt:renewed.expiresAt});
        return renewed;
      });
    },
    async releaseLease({lease}={}){
      await init();
      return tx(async c=>{
        await assertLease(c,lease);
        const now=clock();
        const r=await c.query("UPDATE jarvis.coordination_leases SET expires_at=$1,updated_at=$1 WHERE resource_key=$2 AND owner_id=$3 AND token_hash=$4 AND fencing_token=$5 RETURNING resource_key",[now,lease.resourceKey,lease.ownerId,hash(lease.token),lease.fencingToken]);
        if(r.rowCount!==1)return false;
        await appendCoordinationEvent(c,lease.resourceKey,"lease_released",{resourceKey:lease.resourceKey,ownerId:lease.ownerId,tokenHash:hash(lease.token),fencingToken:lease.fencingToken,releasedAt:now});
        return true;
      });
    },
    async claimTaskForWorker({taskId,workerId,leaseMs=60000}={}){
      await init();
      if(typeof taskId!=="string"||!taskId.trim()||typeof workerId!=="string"||!workerId.trim())throw new Error("Task and Worker IDs are required");
      return tx(async c=>{
        // Lock order is task lease -> worker row -> task event. Keep this order
        // consistent with the fenced writer to minimize deadlock risk.
        const lease=await acquireInTx(c,{resourceKey:"task:"+taskId,ownerId:workerId,leaseMs});
        if(!lease)return null;
        const worker=await c.query("SELECT status,current_task_id FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        if(!worker.rows[0])throw new Error("Worker is not registered");
        if(!["idle","recovering"].includes(worker.rows[0].status)||worker.rows[0].current_task_id)throw new Error("Worker is not available for task claim");
        const current=await latest(c,taskId);
        if(!current)throw new Error("Task does not exist");
        const scopeGrant=await c.query("SELECT grant_id FROM jarvis.worker_scope_grants WHERE worker_id=$1 AND project_id=$2 AND conversation_id=$3 AND revoked_at IS NULL FOR SHARE",[workerId,current.task.projectId,current.task.ownerConversation]);
        if(!scopeGrant.rows[0])throw new Error("Worker has no active grant for this Project and Conversation");
        const now=clock();
        const currentState=canonicalTaskState(current.task.state||current.task.status);
        const reclaimable=currentState==="claimed";
        if(currentState==="running")throw new Error("Expired running Task requires outcome_unknown reconciliation; automatic reclaim is prohibited");
        if(currentState!=="queued"&&!reclaimable)throw new Error("Task is not claimable");
        if(reclaimable){
          const previousExpiry=Date.parse(current.task.leaseExpiresAt||"");
          if(!Number.isFinite(previousExpiry)||previousExpiry>Date.parse(now))throw new Error("Task lease recovery requires an expired recorded lease");
          await appendCoordinationEvent(c,lease.resourceKey,"lease_reclaimed",{resourceKey:lease.resourceKey,ownerId:workerId,previousOwnerId:current.task.leaseOwner||null,previousFencingToken:current.task.fencingToken,recoveredFromStatus:current.task.status,recoveredAt:now,fencingToken:lease.fencingToken});
        }
        const next={...current.task,status:"claimed",state:"claimed",updatedAt:now,startedAt:current.task.startedAt||now,leaseOwner:lease.ownerId,leaseTokenHash:hash(lease.token),leaseExpiresAt:lease.expiresAt,fencingToken:lease.fencingToken,...(reclaimable?{recoveredFromStatus:current.task.status,recoveredAt:now}:{})};
        await append(c,taskId,reclaimable?"lease_reclaimed":"claimed",next);
        const bound=await c.query("UPDATE jarvis.worker_registry SET current_task_id=$1,lease_resource_key=$2,fencing_token=$3,status='running',heartbeat_at=$4,version=version+1,updated_at=$4 WHERE worker_id=$5 AND status IN ('idle','recovering') AND current_task_id IS NULL RETURNING *",[taskId,lease.resourceKey,lease.fencingToken,now,workerId]);
        if(bound.rowCount!==1)throw new Error("Atomic Worker binding failed");
        return {task:clone(next),version:current.version+1,lease,worker:bound.rows[0]};
      });
    },
    async claimTask({taskId,ownerId,leaseMs=60000}={}){
      await init();
      return tx(async c=>{
        const lease=await acquireInTx(c,{resourceKey:"task:"+taskId,ownerId,leaseMs});
        if(!lease)return null;
        const current=await latest(c,taskId);
        if(!current)throw new Error("Task does not exist");
        const now=clock();
        const currentState=canonicalTaskState(current.task.state||current.task.status);
        const reclaimable=currentState==="claimed";
        if(currentState==="running")throw new Error("Expired running Task requires outcome_unknown reconciliation; automatic reclaim is prohibited");
        if(currentState!=="queued"&&!reclaimable)throw new Error("Task is not claimable");
        if(reclaimable){
          const previousExpiry=Date.parse(current.task.leaseExpiresAt||"");
          if(!Number.isFinite(previousExpiry)||previousExpiry>Date.parse(now))throw new Error("Task lease recovery requires an expired recorded lease");
          await appendCoordinationEvent(c,lease.resourceKey,"lease_reclaimed",{resourceKey:lease.resourceKey,ownerId,previousOwnerId:current.task.leaseOwner||null,previousFencingToken:current.task.fencingToken,recoveredFromStatus:current.task.status,recoveredAt:now,fencingToken:lease.fencingToken});
        }
        const next={...current.task,status:"claimed",state:"claimed",ownerAgent:ownerId,updatedAt:now,startedAt:current.task.startedAt||now,leaseOwner:lease.ownerId,leaseTokenHash:hash(lease.token),leaseExpiresAt:lease.expiresAt,fencingToken:lease.fencingToken,...(reclaimable?{recoveredFromStatus:current.task.status,recoveredAt:now}: {})};
        await append(c,taskId,reclaimable?"lease_reclaimed":"claimed",next);
        return {task:clone(next),version:current.version+1,lease};
      });
    },
    async listTaskEvents({taskIds=[],limit=500}={}){
      await init();
      if(!Array.isArray(taskIds)||taskIds.length>200||taskIds.some(id=>!text(id,200))||new Set(taskIds).size!==taskIds.length)throw new Error("Invalid scoped Task IDs");
      if(!Number.isInteger(limit)||limit<1||limit>2000)throw new Error("Invalid Task event limit");
      if(taskIds.length===0)return [];
      const r=await pool.query("SELECT event_id,aggregate_id,aggregate_version,event_type,payload,created_at FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=ANY($1::text[]) ORDER BY event_id DESC LIMIT $2",[taskIds,limit]);
      return r.rows.map(row=>({eventId:Number(row.event_id),taskId:row.aggregate_id,version:Number(row.aggregate_version),eventType:row.event_type,payload:clone(row.payload),createdAt:row.created_at}));
    },
    async recordTaskHandoff({taskId,expectedVersion,lease,fromAgentId,toAgentId,fromDepartmentId,toDepartmentId,idempotencyKey,handoffRequest=null}={}){
      await init();
      if(!text(taskId,200)||!Number.isSafeInteger(expectedVersion)||![fromAgentId,toAgentId,fromDepartmentId,toDepartmentId].every(x=>text(x,128))||!text(idempotencyKey,240))throw new Error("Invalid Task handoff request");\n       if(handoffRequest!==null&&(!handoffRequest||typeof handoffRequest!=="object"||Array.isArray(handoffRequest)||!text(handoffRequest.reason,10,500)||!Array.isArray(handoffRequest.deliverables)||handoffRequest.deliverables.length<1||handoffRequest.deliverables.length>20||handoffRequest.deliverables.some(x=>!text(x,500))||!Array.isArray(handoffRequest.acceptanceCriteria)||handoffRequest.acceptanceCriteria.length<1||handoffRequest.acceptanceCriteria.length>20||handoffRequest.acceptanceCriteria.some(x=>!text(x,500))||!["read","analyze","draft","notify","internal_task"].includes(handoffRequest.actionClass)))throw new Error("Invalid structured Task handoff details");
      const keyHash=hash("task-handoff:"+idempotencyKey);
      return tx(async c=>{
        await lock(c,"task-handoff:"+keyHash);
        const prior=await c.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 AND idempotency_key=$2 LIMIT 1",[taskId,keyHash]);
        if(prior.rows[0]){
          const p=prior.rows[0].payload;
          if(p.fromAgentId!==fromAgentId||p.toAgentId!==toAgentId||p.fromDepartmentId!==fromDepartmentId||p.toDepartmentId!==toDepartmentId)throw new Error("Handoff idempotency key replayed with different target");
          return {created:false,task:clone(p),version:Number(prior.rows[0].aggregate_version)};
        }
        await assertLease(c,lease);
        if(lease.resourceKey!=="task:"+taskId)throw new Error("Handoff Task Lease mismatch");
        const worker=await c.query("SELECT worker_id,agent_id,department_id,current_task_id,lease_resource_key,fencing_token,version FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[lease.ownerId]);
        if(!worker.rows[0]||worker.rows[0].current_task_id!==taskId||worker.rows[0].lease_resource_key!==lease.resourceKey||Number(worker.rows[0].fencing_token)!==lease.fencingToken)throw new Error("Handoff Worker binding is stale");
        await lock(c,"task:"+taskId);
        const current=await latest(c,taskId);
        if(!current||current.version!==expectedVersion)throw new Error("Stale Task version for handoff");
        const task=current.task;
        const handoffHistory=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 AND event_type='agent_handoff' ORDER BY aggregate_version ASC",[taskId]);
        validateHandoffRoute(handoffHistory.rows,fromDepartmentId,toDepartmentId,8);
        if((task.state||task.status)!=="running"||task.leaseOwner!==lease.ownerId||Number(task.fencingToken)!==lease.fencingToken||worker.rows[0].agent_id!==fromAgentId||task.ownerAgent!==fromAgentId||worker.rows[0].department_id!==fromDepartmentId||task.departmentId!==fromDepartmentId)throw new Error("Handoff source ownership or fencing validation failed");
        const now=clock();
        const next={...task,ownerAgent:toAgentId,departmentId:toDepartmentId,status:"queued",state:"queued",leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,fencingToken:0,updatedAt:now,nextAction:"Queued for authorized Agent handoff"};
        await c.query("UPDATE jarvis.coordination_leases SET expires_at=$1::timestamptz,updated_at=$1::timestamptz WHERE resource_key=$2 AND owner_id=$3 AND fencing_token=$4",[now,lease.resourceKey,lease.ownerId,lease.fencingToken]);
        const released=await c.query("UPDATE jarvis.worker_registry SET status='idle',current_task_id=NULL,lease_resource_key=NULL,fencing_token=NULL,version=version+1,updated_at=$1 WHERE worker_id=$2 AND version=$3 RETURNING worker_id",[now,lease.ownerId,Number(worker.rows[0].version)]);
        if(released.rowCount!==1)throw new Error("Handoff Worker release lost concurrency race");
        await append(c,taskId,"agent_handoff",{...next,fromAgentId,toAgentId,fromDepartmentId,toDepartmentId,fromWorkerId:lease.ownerId,handoffRequest:handoffRequest?clone(handoffRequest):null,handoffAt:now},keyHash);
        return {created:true,task:clone(next),version:current.version+1,event:{eventType:"agent_handoff",fromAgentId,toAgentId,fromDepartmentId,toDepartmentId,workerId:lease.ownerId,createdAt:now}};
      });
    },
    async transitionTask(input={}){
      await init();
      return tx(c=>transitionInTx(c,input));
    }
  };
}
module.exports={createTaskRegistry,TASK_STATES,validateHandoffRoute};
