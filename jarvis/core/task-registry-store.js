"use strict";
const crypto = require("node:crypto");

const TASK_STATES = new Set(["proposed","ready","claimed","in_progress","blocked","review","verified","completed","cancelled"]);
const PATCH_FIELDS = new Set(["scope","ownerConversation","ownerAgent","priority","branch","baseBranch","headSha","pullRequest","dependencyTaskIds","changedPaths","testRunIds","verificationSummary","blockerIds","nextAction","startedAt","completedAt"]);
const NEXT = {
  proposed: new Set(["ready","blocked","cancelled"]),
  ready: new Set(["claimed","blocked","cancelled"]),
  claimed: new Set(["in_progress","blocked","ready","cancelled"]),
  in_progress: new Set(["blocked","review","ready","cancelled"]),
  blocked: new Set(["ready","cancelled"]),
  review: new Set(["in_progress","verified","blocked"]),
  verified: new Set(["completed","review"]),
  completed: new Set(),
  cancelled: new Set()
};
const MAX_TITLE=240, MAX_SCOPE=12000, MAX_OWNER=128, MAX_DEDUPE=240;
function text(value,max,required=true){return typeof value==="string"&&value.length<=max&&(!required||!!value.trim());}
function clone(value){return JSON.parse(JSON.stringify(value));}
function hash(value){return crypto.createHash("sha256").update(value).digest("hex");}
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
    if(!NEXT[current.task.status]?.has(status))throw new Error("Invalid task state transition");
    if(Object.prototype.hasOwnProperty.call(patch,"dependencyTaskIds")){
      await lock(c,"task-dependency-graph");
      await validateDependencies(c,taskId,patch.dependencyTaskIds);
    }
    const next={...current.task,...clone(patch),status,updatedAt:clock(),fencingToken:lease.fencingToken};
    await append(c,taskId,"status_changed",next);
    return {task:clone(next),version:current.version+1};
  }
  return {
    async init(){return init();},
    async createTask(input={}){
      await init();
      const {title,scope="",acceptanceCriteria=[],dedupeKey,projectId="one-jarvis",ownerConversation="unassigned",ownerAgent="unassigned",priority="P2",status="proposed",dependencyTaskIds=[]}=input;
      if(!text(title,MAX_TITLE)||!text(scope,MAX_SCOPE,false)||!text(dedupeKey,MAX_DEDUPE)||!text(projectId,128)||!text(ownerConversation,MAX_OWNER)||!text(ownerAgent,MAX_OWNER)||!["P0","P1","P2","P3"].includes(priority)||!TASK_STATES.has(status)||!Array.isArray(acceptanceCriteria)||acceptanceCriteria.length>100||acceptanceCriteria.some(x=>!text(x,1000))||!Array.isArray(dependencyTaskIds)||dependencyTaskIds.length>100||dependencyTaskIds.some(x=>!text(x,80)))throw new Error("Invalid task input");
      const id=crypto.randomUUID(),now=clock();
      const task={taskId:id,dedupeKey,projectId,title,scope,acceptanceCriteria:[...acceptanceCriteria],ownerConversation,ownerAgent,priority,status,dependencyTaskIds:[...new Set(dependencyTaskIds)],branch:null,baseBranch:null,headSha:null,pullRequest:null,createdAt:now,updatedAt:now,startedAt:null,completedAt:null,leaseOwner:null,leaseTokenHash:null,leaseExpiresAt:null,fencingToken:0,changedPaths:[],testRunIds:[],verificationSummary:null,blockerIds:[],nextAction:null};
      return tx(async c=>{
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
        "SELECT aggregate_id,aggregate_version,payload FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id,aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' ORDER BY aggregate_id,aggregate_version DESC) latest WHERE ($1::text IS NULL OR payload->>'status'=$1) AND ($2::text IS NULL OR payload->>'ownerAgent'=$2) AND ($3::text IS NULL OR payload->>'ownerConversation'=$3) AND ($4::text IS NULL OR payload->>'projectId'=$4) ORDER BY payload->>'updatedAt' DESC,aggregate_id ASC LIMIT $5 OFFSET $6",
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
    async claimTask({taskId,ownerId,leaseMs=60000}={}){
      await init();
      return tx(async c=>{
        const lease=await acquireInTx(c,{resourceKey:"task:"+taskId,ownerId,leaseMs});
        if(!lease)return null;
        const current=await latest(c,taskId);
        if(!current)throw new Error("Task does not exist");
        const now=clock();
        const reclaimable=current.task.status==="claimed"||current.task.status==="in_progress";
        if(current.task.status!=="ready"&&!reclaimable)throw new Error("Task is not claimable");
        if(reclaimable){
          const previousExpiry=Date.parse(current.task.leaseExpiresAt||"");
          if(!Number.isFinite(previousExpiry)||previousExpiry>Date.parse(now))throw new Error("Task lease recovery requires an expired recorded lease");
          await appendCoordinationEvent(c,lease.resourceKey,"lease_reclaimed",{resourceKey:lease.resourceKey,ownerId,previousOwnerId:current.task.leaseOwner||null,previousFencingToken:current.task.fencingToken,recoveredFromStatus:current.task.status,recoveredAt:now,fencingToken:lease.fencingToken});
        }else if(!NEXT[current.task.status]?.has("claimed")){
          throw new Error("Task is not claimable");
        }
        const next={...current.task,status:"claimed",ownerAgent:ownerId,updatedAt:now,startedAt:current.task.startedAt||now,leaseOwner:lease.ownerId,leaseTokenHash:hash(lease.token),leaseExpiresAt:lease.expiresAt,fencingToken:lease.fencingToken,...(reclaimable?{recoveredFromStatus:current.task.status,recoveredAt:now}: {})};
        await append(c,taskId,reclaimable?"lease_reclaimed":"claimed",next);
        return {task:clone(next),version:current.version+1,lease};
      });
    },
    async transitionTask(input={}){
      await init();
      return tx(c=>transitionInTx(c,input));
    }
  };
}
module.exports={createTaskRegistry,TASK_STATES};
