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
    return {resourceKey,ownerId,token,fencingToken:Number(r.rows[0].fencing_token),expiresAt:r.rows[0].expires_at};
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
    const next={...current.task,...clone(patch),status,updatedAt:clock(),fencingToken:lease.fencingToken};
    await append(c,taskId,"status_changed",next);
    return {task:clone(next),version:current.version+1};
  }
  return {
    async init(){return init();},
    async createTask(input={}){
      await init();
      const {title,scope="",dedupeKey,projectId="one-jarvis",ownerConversation="unassigned",ownerAgent="unassigned",priority="P2",status="proposed",dependencyTaskIds=[]}=input;
      if(!text(title,MAX_TITLE)||!text(scope,MAX_SCOPE,false)||!text(dedupeKey,MAX_DEDUPE)||!text(projectId,128)||!text(ownerConversation,MAX_OWNER)||!text(ownerAgent,MAX_OWNER)||!["P0","P1","P2","P3"].includes(priority)||!TASK_STATES.has(status)||!Array.isArray(dependencyTaskIds)||dependencyTaskIds.length>100||dependencyTaskIds.some(x=>!text(x,80)))throw new Error("Invalid task input");
      const id=crypto.randomUUID(),now=clock();
      const task={taskId:id,dedupeKey,projectId,title,scope,ownerConversation,ownerAgent,priority,status,dependencyTaskIds:[...new Set(dependencyTaskIds)],branch:null,baseBranch:null,headSha:null,pullRequest:null,createdAt:now,updatedAt:now,startedAt:null,completedAt:null,changedPaths:[],testRunIds:[],verificationSummary:null,blockerIds:[],nextAction:null};
      return tx(async c=>{
        await lock(c,"task-dedupe:"+dedupeKey);
        const existing=await c.query("SELECT aggregate_id,payload FROM jarvis.events WHERE aggregate_type='task' AND event_type='created' AND payload->>'dedupeKey'=$1 LIMIT 1",[dedupeKey]);
        if(existing.rows[0])return {task:clone(existing.rows[0].payload),created:false,version:1};
        await append(c,id,"created",task,dedupeKey);
        return {task:clone(task),created:true,version:1};
      });
    },
    async getTask(taskId){
      await init();
      const r=await pool.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[taskId]);
      return r.rows[0]?{task:clone(r.rows[0].payload),version:Number(r.rows[0].aggregate_version)}:null;
    },
    async listTasks({status=null,limit=50}={}){
      await init();
      if(status!==null&&!TASK_STATES.has(status))throw new Error("Invalid task status");
      if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid task limit");
      const r=await pool.query("SELECT DISTINCT ON (aggregate_id) aggregate_id,aggregate_version,payload FROM jarvis.events WHERE aggregate_type='task' ORDER BY aggregate_id,aggregate_version DESC");
      return r.rows.filter(x=>status===null||x.payload.status===status).slice(0,limit).map(x=>({task:clone(x.payload),version:Number(x.aggregate_version)}));
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
        return {...lease,expiresAt:r.rows[0].expires_at};
      });
    },
    async releaseLease({lease}={}){
      await init();
      return tx(async c=>{
        await assertLease(c,lease);
        const now=clock();
        const r=await c.query("UPDATE jarvis.coordination_leases SET expires_at=$1,updated_at=$1 WHERE resource_key=$2 AND owner_id=$3 AND token_hash=$4 AND fencing_token=$5 RETURNING resource_key",[now,lease.resourceKey,lease.ownerId,hash(lease.token),lease.fencingToken]);
        return r.rowCount===1;
      });
    },
    async claimTask({taskId,ownerId,leaseMs=60000}={}){
      await init();
      return tx(async c=>{
        const lease=await acquireInTx(c,{resourceKey:"task:"+taskId,ownerId,leaseMs});
        if(!lease)return null;
        const current=await latest(c,taskId);
        if(!current||!NEXT[current.task.status]?.has("claimed"))throw new Error("Task is not claimable");
        const next={...current.task,status:"claimed",ownerAgent:ownerId,updatedAt:clock(),startedAt:current.task.startedAt||clock(),fencingToken:lease.fencingToken};
        await append(c,taskId,"claimed",next);
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
