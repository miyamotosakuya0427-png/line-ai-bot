"use strict";
const crypto = require("node:crypto");

const {ALL_TASK_STATES,canonicalTaskState,canTransitionTask}=require("./task-state-machine");
const TASK_STATES = ALL_TASK_STATES;
const PATCH_FIELDS = new Set(["scope","ownerConversation","ownerAgent","departmentId","priority","branch","baseBranch","headSha","pullRequest","dependencyTaskIds","changedPaths","testRunIds","verificationSummary","resultResourceId","blockerIds","nextAction","startedAt","completedAt","outcomeUnknownReason","reconciliationId","reconciledBy"]);
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

function createTaskRegistry({pool,clock=()=>new Date().toISOString(),tokenFactory=()=>crypto.randomBytes(32).toString("base64url"),requireAgentRevocation=false}={}){
  if(!pool||typeof pool.connect!=="function")throw new Error("PostgreSQL pool is required");
  let initialized=false;
  async function init(){
    if(initialized)return {ok:true};
    const r=await pool.query("SELECT to_regclass('jarvis.events') AS events, to_regclass('jarvis.coordination_leases') AS leases, to_regclass('jarvis.task_registry_agent_revocations') AS revocations");
    if(!r.rows[0]?.events||!r.rows[0]?.leases)throw new Error("Task Registry migration 0004 is not installed");
    if(requireAgentRevocation&&!r.rows[0]?.revocations)throw new Error("Task Registry migration 0010 is required for Worker dispatch");
    initialized=true;return {ok:true};
  }
  async function tx(fn){
    const c=await pool.connect();
    try{await c.query("BEGIN");const result=await fn(c);await c.query("COMMIT");return result;}
    catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}
    finally{c.release();}
  }
  async function lock(c,key){await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[key]);}
  async function assertAgentsActive(c,agentIds){
    if(!requireAgentRevocation)return;
    const ids=[...new Set(agentIds)].sort();
    for(const agentId of ids){
      if(!text(agentId,128))throw new Error("Invalid Agent identity for revocation check");
      await lock(c,"agent-revocation:"+agentId);
      const revoked=await c.query("SELECT 1 FROM jarvis.task_registry_agent_revocations WHERE agent_id=$1",[agentId]);
      if(revoked.rows[0])throw new Error("Agent credential is revoked; Task claim or Handoff denied");
    }
  }
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
      const task={taskId:id,dedupeKey,projectId,title,scope,acceptanceCriteria:[...acceptanceCriteria],ownerConversation,ownerAgent,departmentId,priority,status,state:canonicalTaskState(status),parentTaskId,dependencyTaskIds:[...new Set(dependencyTaskIds)],branch:null,baseBranch:null,headSha:null,pullRequest:null,createdAt:now,updatedAt:now,startedAt:null,completedAt:null,leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,fencingToken:0,changedPaths:[],testRunIds:[],verificationSummary:null,resultResourceId:null,blockerIds:[],nextAction:null};
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
        const worker=await c.query("SELECT agent_id,status,current_task_id FROM jarvis.worker_registry WHERE worker_id=$1 FOR UPDATE",[workerId]);
        if(!worker.rows[0])throw new Error("Worker is not registered");
        await assertAgentsActive(c,[worker.rows[0].agent_id]);
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
        await assertAgentsActive(c,[ownerId]);
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
    async recordTaskHandoff({taskId,expectedVersion,lease,targetWorkerId,fromAgentId,toAgentId,fromDepartmentId,toDepartmentId,idempotencyKey,handoffRequest=null,resultResourceId=null}={}){
      await init();
      if(!text(taskId,200)||!Number.isSafeInteger(expectedVersion)||!text(targetWorkerId,160)||targetWorkerId===lease?.ownerId||![fromAgentId,toAgentId,fromDepartmentId,toDepartmentId].every(x=>text(x,128))||!text(idempotencyKey,240)||(resultResourceId!==null&&!text(resultResourceId,160)))throw new Error("Invalid Task handoff request");
       if(handoffRequest!==null&&(!handoffRequest||typeof handoffRequest!=="object"||Array.isArray(handoffRequest)||!(typeof handoffRequest.reason==="string"&&handoffRequest.reason.trim().length>=10&&handoffRequest.reason.length<=500)||!Array.isArray(handoffRequest.deliverables)||handoffRequest.deliverables.length<1||handoffRequest.deliverables.length>20||handoffRequest.deliverables.some(x=>!text(x,500))||!Array.isArray(handoffRequest.acceptanceCriteria)||handoffRequest.acceptanceCriteria.length<1||handoffRequest.acceptanceCriteria.length>20||handoffRequest.acceptanceCriteria.some(x=>!text(x,500))||!["read","analyze","draft","internal_task"].includes(handoffRequest.actionClass)))throw new Error("Invalid structured Task handoff details");
      const keyHash=hash("task-handoff:"+idempotencyKey);
      return tx(async c=>{
        await lock(c,"task-handoff:"+keyHash);
        const prior=await c.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 AND idempotency_key=$2 LIMIT 1",[taskId,keyHash]);
        if(prior.rows[0]){
          const p=prior.rows[0].payload;
          const priorRequest=p.handoffRequest||null;
          const sameRequest=priorRequest===null?handoffRequest===null:!!handoffRequest&&priorRequest.reason===handoffRequest.reason&&priorRequest.actionClass===handoffRequest.actionClass&&JSON.stringify(priorRequest.deliverables)===JSON.stringify(handoffRequest.deliverables)&&JSON.stringify(priorRequest.acceptanceCriteria)===JSON.stringify(handoffRequest.acceptanceCriteria);
          if(p.fromAgentId!==fromAgentId||p.toAgentId!==toAgentId||p.toWorkerId!==targetWorkerId||p.fromDepartmentId!==fromDepartmentId||p.toDepartmentId!==toDepartmentId||(p.resultResourceId||null)!==resultResourceId||!sameRequest)throw new Error("Handoff idempotency key replayed with different target or payload");
          return {created:false,task:clone(p),version:Number(prior.rows[0].aggregate_version)};
        }
        await assertLease(c,lease);
        if(lease.resourceKey!=="task:"+taskId)throw new Error("Handoff Task Lease mismatch");
        // Acquire both Worker row locks in a globally stable order. Opposite-direction
        // Handoffs must not deadlock by locking source then destination in reverse order.
        const lockedWorkers=await c.query("SELECT worker_id,agent_id,department_id,status,current_task_id,lease_resource_key,fencing_token,heartbeat_at,version FROM jarvis.worker_registry WHERE worker_id=ANY($1::text[]) ORDER BY worker_id FOR UPDATE",[[lease.ownerId,targetWorkerId]]);
        const worker=lockedWorkers.rows.find(row=>row.worker_id===lease.ownerId)||null;
        const target=lockedWorkers.rows.find(row=>row.worker_id===targetWorkerId)||null;
        // Revalidate the destination inside the same transaction as the Task/event handoff.
        if(!target||target.agent_id!==toAgentId||target.department_id!==toDepartmentId||target.status!=="idle"||target.current_task_id!==null)throw new Error("Handoff target Worker is no longer idle or does not match the requested Agent/Department");
        const targetHeartbeat=Date.parse(target.heartbeat_at||"");
        if(!Number.isFinite(targetHeartbeat)||Date.parse(clock())-targetHeartbeat>120000)throw new Error("Handoff target Worker heartbeat is stale");
        const targetGrant=await c.query("SELECT grant_id FROM jarvis.worker_scope_grants WHERE worker_id=$1 AND project_id=(SELECT payload->>'projectId' FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$2 ORDER BY aggregate_version DESC LIMIT 1) AND conversation_id=(SELECT payload->>'ownerConversation' FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$2 ORDER BY aggregate_version DESC LIMIT 1) AND revoked_at IS NULL FOR SHARE",[targetWorkerId,taskId]);
        if(!targetGrant.rows[0])throw new Error("Handoff target Worker has no active Project/Conversation Grant");
        await assertAgentsActive(c,[fromAgentId,toAgentId]);
        if(!worker||worker.current_task_id!==taskId||worker.lease_resource_key!==lease.resourceKey||Number(worker.fencing_token)!==lease.fencingToken)throw new Error("Handoff Worker binding is stale");
        await lock(c,"task:"+taskId);
        const current=await latest(c,taskId);
        if(!current||current.version!==expectedVersion)throw new Error("Stale Task version for handoff");
        const task=current.task;
        const handoffHistory=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 AND event_type='agent_handoff' ORDER BY aggregate_version ASC",[taskId]);
        validateHandoffRoute(handoffHistory.rows,fromDepartmentId,toDepartmentId,8);
        if((task.state||task.status)!=="running"||task.leaseOwner!==lease.ownerId||Number(task.fencingToken)!==lease.fencingToken||worker.agent_id!==fromAgentId||task.ownerAgent!==fromAgentId||worker.department_id!==fromDepartmentId||task.departmentId!==fromDepartmentId)throw new Error("Handoff source ownership or fencing validation failed");
        const now=clock();
        const next={...task,ownerAgent:toAgentId,departmentId:toDepartmentId,resultResourceId,status:"queued",state:"queued",leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,fencingToken:0,updatedAt:now,nextAction:"Queued for authorized Agent handoff"};
        await c.query("UPDATE jarvis.coordination_leases SET expires_at=$1::timestamptz,updated_at=$1::timestamptz WHERE resource_key=$2 AND owner_id=$3 AND fencing_token=$4",[now,lease.resourceKey,lease.ownerId,lease.fencingToken]);
        const released=await c.query("UPDATE jarvis.worker_registry SET status='idle',current_task_id=NULL,lease_resource_key=NULL,fencing_token=NULL,version=version+1,updated_at=$1 WHERE worker_id=$2 AND version=$3 RETURNING worker_id",[now,lease.ownerId,Number(worker.version)]);
        if(released.rowCount!==1)throw new Error("Handoff Worker release lost concurrency race");
        await append(c,taskId,"agent_handoff",{...next,fromAgentId,toAgentId,toWorkerId:targetWorkerId,fromDepartmentId,toDepartmentId,fromWorkerId:lease.ownerId,handoffRequest:handoffRequest?clone(handoffRequest):null,handoffAt:now},keyHash);
        return {created:true,task:clone(next),version:current.version+1,event:{eventType:"agent_handoff",fromAgentId,toAgentId,fromDepartmentId,toDepartmentId,workerId:lease.ownerId,createdAt:now}};
      });
    },
    async recoverPostCommitHandoff({taskId,expectedVersion,candidateWorkerId=null,oldAgentAuthorized=true,maxAttempts=3}={}) {
      await init();
      if(!text(taskId,200)||!Number.isSafeInteger(expectedVersion)||(candidateWorkerId!==null&&!text(candidateWorkerId,160))||typeof oldAgentAuthorized!=="boolean"||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)throw new Error("Invalid Handoff recovery request");
      return tx(async c=>{
        await lock(c,"task-handoff-recovery:"+taskId);
        const currentSnapshot=await latest(c,taskId);
        if(!currentSnapshot)throw new Error("Handoff recovery Task does not exist");
        const handoffs=await c.query("SELECT event_id,aggregate_version,event_type,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 AND event_type IN ('agent_handoff','handoff_reselected','handoff_recovery_waiting','handoff_recovery_exhausted') ORDER BY aggregate_version ASC",[taskId]);
        const original=handoffs.rows.find(row=>row.event_type==="agent_handoff");
        if(!original)throw new Error("Task has no committed Handoff to recover");
        const latestHandoff=handoffs.rows[handoffs.rows.length-1];
        const originalPayload=original.payload;
        const latestPayload=latestHandoff.payload;
        const originVersion=Number(original.aggregate_version);
        const attempts=handoffs.rows.filter(row=>row.event_type==="handoff_reselected"||row.event_type==="handoff_recovery_waiting"||row.event_type==="handoff_recovery_exhausted").length;
        const attempt=attempts+1;
        if(attempts>maxAttempts)return {created:false,replayed:false,reason:"MAX_HANDOFF_RECOVERY_ATTEMPTS_REACHED",task:clone(currentSnapshot.task),version:currentSnapshot.version,attempt:attempts};
        if(!candidateWorkerId&&(currentSnapshot.task.state||currentSnapshot.task.status)==="waiting"&&latestHandoff.event_type==="handoff_recovery_waiting")return {created:false,replayed:false,reason:"WAITING_FOR_REPLACEMENT_WORKER",task:clone(currentSnapshot.task),version:currentSnapshot.version,attempt:attempts};
        const recoveryKey=hash(["handoff-post-commit-recovery",taskId,String(originVersion),String(attempt),candidateWorkerId||"waiting"].join(":"));
        const prior=await c.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 AND idempotency_key=$2 LIMIT 1",[taskId,recoveryKey]);
        if(prior.rows[0])return {created:false,replayed:true,task:clone(prior.rows[0].payload),version:Number(prior.rows[0].aggregate_version),attempt};
        if(currentSnapshot.version!==expectedVersion)throw new Error("Stale Task version for Handoff recovery");
        const current=currentSnapshot.task;
        if(!["queued","waiting"].includes(current.state||current.status))throw new Error("Handoff recovery only accepts queued or waiting Tasks");
        if(current.projectId!==originalPayload.projectId||current.ownerConversation!==originalPayload.ownerConversation||current.departmentId!==originalPayload.toDepartmentId||current.ownerAgent!==latestPayload.toAgentId)throw new Error("Handoff recovery Project/Conversation/Agent scope mismatch");
        if(attempt>maxAttempts){
          const next={...current,status:"waiting",state:"waiting",updatedAt:clock(),nextAction:"Handoff recovery attempt limit reached; Owner review required"};
          await lock(c,"task:"+taskId);
          const latestNow=await latest(c,taskId);
          if(!latestNow||latestNow.version!==expectedVersion)throw new Error("Task changed during Handoff recovery");
          await append(c,taskId,"handoff_recovery_exhausted",{...next,originalHandoffVersion:originVersion,attempt,maxAttempts,reason:"maximum_attempts"},recoveryKey);
          return {created:true,replayed:false,task:clone(next),version:expectedVersion+1,attempt,waiting:true};
        }
        const oldWorkerId=latestPayload.toWorkerId||null;
        const ids=[oldWorkerId,candidateWorkerId].filter(Boolean);
        const locked=ids.length?await c.query("SELECT worker_id,agent_id,department_id,status,current_task_id,heartbeat_at,version FROM jarvis.worker_registry WHERE worker_id=ANY($1::text[]) ORDER BY worker_id FOR UPDATE",[ids]):{rows:[]};
        const oldWorker=locked.rows.find(row=>row.worker_id===oldWorkerId)||null;
        const candidate=locked.rows.find(row=>row.worker_id===candidateWorkerId)||null;
        let oldGrant=false,oldRevoked=false;
        if(oldWorker){
          const grant=await c.query("SELECT grant_id FROM jarvis.worker_scope_grants WHERE worker_id=$1 AND project_id=$2 AND conversation_id=$3 AND revoked_at IS NULL FOR SHARE",[oldWorkerId,current.projectId,current.ownerConversation]);
          oldGrant=!!grant.rows[0];
          if(requireAgentRevocation){
            await lock(c,"agent-revocation:"+oldWorker.agent_id);
            const revoked=await c.query("SELECT 1 FROM jarvis.task_registry_agent_revocations WHERE agent_id=$1",[oldWorker.agent_id]);
            oldRevoked=!!revoked.rows[0];
          }
        }
        const oldHeartbeat=Date.parse(oldWorker?.heartbeat_at||"");
        const oldUnavailable=!oldWorker||oldWorker.agent_id!==latestPayload.toAgentId||oldWorker.department_id!==current.departmentId||oldWorker.status!=="idle"||oldWorker.current_task_id!==null||!Number.isFinite(oldHeartbeat)||Date.parse(clock())-oldHeartbeat>120000||!oldGrant||oldRevoked||!oldAgentAuthorized;
        if(!oldUnavailable)return {created:false,replayed:false,reason:"CURRENT_HANDOFF_TARGET_STILL_ELIGIBLE",task:clone(current),version:currentSnapshot.version,attempt:attempts};
        let candidateValid=false;
        if(candidateWorkerId&&candidate){
          if(candidate.worker_id===oldWorkerId||candidate.agent_id===latestPayload.toAgentId||candidate.department_id!==current.departmentId||candidate.status!=="idle"||candidate.current_task_id!==null)throw new Error("Handoff recovery candidate Worker is not eligible");
          const heartbeat=Date.parse(candidate.heartbeat_at||"");
          if(!Number.isFinite(heartbeat)||Date.parse(clock())-heartbeat>120000)throw new Error("Handoff recovery candidate heartbeat is stale");
          const candidateGrant=await c.query("SELECT grant_id FROM jarvis.worker_scope_grants WHERE worker_id=$1 AND project_id=$2 AND conversation_id=$3 AND revoked_at IS NULL FOR SHARE",[candidateWorkerId,current.projectId,current.ownerConversation]);
          if(!candidateGrant.rows[0])throw new Error("Handoff recovery candidate has no active Project/Conversation Grant");
          await assertAgentsActive(c,[candidate.agent_id]);
          const seen=handoffs.rows.some(row=>row.payload?.toAgentId===candidate.agent_id||row.payload?.toWorkerId===candidate.worker_id||row.payload?.fromAgentId===candidate.agent_id||row.payload?.fromWorkerId===candidate.worker_id);
          if(seen)throw new Error("Handoff recovery candidate would create an Agent/Worker cycle");
          candidateValid=true;
        } else if(candidateWorkerId) {
          throw new Error("Handoff recovery candidate Worker does not exist");
        }
        await lock(c,"task:"+taskId);
        const latestNow=await latest(c,taskId);
        if(!latestNow||latestNow.version!==expectedVersion)throw new Error("Task changed during Handoff recovery");
        const now=clock();
        const next=candidateValid
          ? {...current,ownerAgent:candidate.agent_id,status:"queued",state:"queued",leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,fencingToken:0,updatedAt:now,nextAction:"Handoff target automatically reselected after destination became unavailable"}
          : {...current,status:"waiting",state:"waiting",leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,fencingToken:0,updatedAt:now,nextAction:"No eligible replacement Handoff Worker; awaiting safe retry"};
        const eventType=candidateValid?"handoff_reselected":"handoff_recovery_waiting";
        const payload={...next,eventType,originalHandoffVersion:originVersion,previousWorkerId:oldWorkerId,previousAgentId:latestPayload.toAgentId||null,toWorkerId:candidateValid?candidate.worker_id:oldWorkerId,toAgentId:candidateValid?candidate.agent_id:(latestPayload.toAgentId||null),attempt,maxAttempts,projectId:current.projectId,conversationId:current.ownerConversation,recoveredAt:now};
        await append(c,taskId,eventType,payload,recoveryKey);
        return {created:true,replayed:false,task:clone(next),version:expectedVersion+1,attempt,waiting:!candidateValid,selectedWorker:candidateValid?{workerId:candidate.worker_id,agentId:candidate.agent_id,departmentId:candidate.department_id}:null};
      });
    },
    async transitionTask(input={}){
      await init();
      return tx(c=>transitionInTx(c,input));
    }
  };
}
module.exports={createTaskRegistry,TASK_STATES,validateHandoffRoute};
