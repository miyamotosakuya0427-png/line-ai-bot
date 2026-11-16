"use strict";
const crypto = require("node:crypto");
const { STATES: JOB_STATES } = require("./job-store");
const { STATES: APPROVAL_STATES, ACTIONS } = require("./approval-store");

const JOB_NEXT = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["succeeded", "failed", "queued", "cancelled"]),
  succeeded: new Set(), failed: new Set(["queued", "cancelled"]), cancelled: new Set()
};
const MAX_JOBS=10000, MAX_APPROVALS=5000, MAX_JOB_PAYLOAD=16*1024, MAX_DETAILS=8000;
function clone(v){return JSON.parse(JSON.stringify(v));}
function bytes(v){try{return Buffer.byteLength(JSON.stringify(v),"utf8");}catch{return Infinity;}}
function validJobPayload(v){return !!v&&typeof v==="object"&&!Array.isArray(v)&&bytes(v)<=MAX_JOB_PAYLOAD;}
function validText(v,max,required=false){return typeof v==="string"&&v.length<=max&&(!required||!!v.trim());}
function digest(v){return crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");}
function createPostgresOperationalStores({pool,clock=()=>new Date().toISOString()}={}){
 if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")throw new Error("PostgreSQL pool is required");
 let readyPromise;
 async function init(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
   const client=await pool.connect();
   try{
    await client.query("BEGIN");
    await client.query("CREATE INDEX IF NOT EXISTS events_job_idempotency_lookup ON jarvis.events ((payload->>'idempotencyKey'), event_id DESC) WHERE aggregate_type='job' AND payload ? 'idempotencyKey'");
    await client.query("CREATE INDEX IF NOT EXISTS events_approval_idempotency_lookup ON jarvis.events ((payload->>'idempotencyKey'), event_id DESC) WHERE aggregate_type='approval' AND payload ? 'idempotencyKey'");
    await client.query("CREATE INDEX IF NOT EXISTS events_operational_latest ON jarvis.events (aggregate_type, aggregate_id, aggregate_version DESC) WHERE aggregate_type IN ('job','approval')");
    await client.query("INSERT INTO jarvis.schema_migrations(version) VALUES ('0002_job_approval_stores') ON CONFLICT (version) DO NOTHING");
    await client.query("COMMIT");
    return{ok:true};
   }catch(e){try{await client.query("ROLLBACK");}catch{}throw e;}finally{client.release();}
  })();
  try{return await readyPromise;}catch(e){readyPromise=null;throw e;}
 }
 async function tx(fn){
  const c=await pool.connect();
  try{await c.query("BEGIN");const v=await fn(c);await c.query("COMMIT");return v;}
  catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}
  finally{c.release();}
 }
 async function latest(c,type,id){
  const r=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type=$1 AND aggregate_id=$2 ORDER BY aggregate_version DESC LIMIT 1",[type,id]);
  return r.rows[0]?.payload||null;
 }
 async function append(c,type,id,event,payload,key=null){
  const r=await c.query("SELECT COALESCE(MAX(aggregate_version),0)::bigint AS v FROM jarvis.events WHERE aggregate_type=$1 AND aggregate_id=$2",[type,id]);
  const version=Number(r.rows[0].v)+1;
  await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",[type,id,version,event,JSON.stringify(payload),key,clock()]);
 }
 async function allLatest(type,limit,status){
  const r=await pool.query("SELECT payload FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id,payload FROM jarvis.events WHERE aggregate_type=$1 ORDER BY aggregate_id,aggregate_version DESC) latest WHERE ($2::text IS NULL OR payload->>'status'=$2) ORDER BY payload->>'createdAt' DESC LIMIT $3",[type,status||null,limit]);
  return r.rows.map(x=>x.payload).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
 }
 const jobs={
  async init(){await init();const r=await pool.query("SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id FROM jarvis.events WHERE aggregate_type='job' ORDER BY aggregate_id,aggregate_version DESC) q");if(r.rows[0].n>MAX_JOBS)throw new Error("Job store capacity reached");return{ok:true,count:r.rows[0].n};},
  async create({type,payload,idempotencyKey=""}={}){
   await init();
   if(typeof type!=="string"||!/^[a-z][a-z0-9._-]{1,63}$/.test(type))throw new Error("Invalid job type");
   if(!validJobPayload(payload))throw new Error("Job payload must be an object no larger than 16 KB");
   if(idempotencyKey&&(typeof idempotencyKey!=="string"||idempotencyKey.length>128))throw new Error("Invalid idempotency key");
   return tx(async c=>{
    if(idempotencyKey){const old=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type='job' AND payload->>'idempotencyKey'=$1 ORDER BY event_id DESC LIMIT 1",[idempotencyKey]);if(old.rows[0])return{job:clone(old.rows[0].payload),created:false};}
    const count=await c.query("SELECT count(DISTINCT aggregate_id)::int AS n FROM jarvis.events WHERE aggregate_type='job'");
    if(count.rows[0].n>=MAX_JOBS)throw new Error("Job store capacity reached");
    const now=clock(),job={id:crypto.randomUUID(),type,payload:clone(payload),status:"queued",attempts:0,idempotencyKey,createdAt:now,updatedAt:now,error:null,result:null};
    await append(c,"job",job.id,"created",job,idempotencyKey||null);return{job:clone(job),created:true};
   });
  },
  async get(id){await init();const r=await pool.query("SELECT payload FROM jarvis.events WHERE aggregate_type='job' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[id]);return r.rows[0]?clone(r.rows[0].payload):null;},
  async getByIdempotencyKey(key){await init();if(typeof key!=="string"||!key||key.length>128)throw new Error("Invalid idempotency key");const r=await pool.query("SELECT DISTINCT ON (aggregate_id) payload FROM jarvis.events WHERE aggregate_type='job' AND payload->>'idempotencyKey'=$1 ORDER BY aggregate_id,aggregate_version DESC LIMIT 1",[key]);return r.rows[0]?clone(r.rows[0].payload):null;},
  async list({status,limit=50}={}){await init();if(status&&!JOB_STATES.has(status))throw new Error("Invalid job status");if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid list limit");return allLatest("job",limit,status);},
  async transition(id,nextStatus,{error=null,result=undefined}={}){
   await init();return tx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["job:"+id]);
    const current=await latest(c,"job",id);if(!current)return null;
    if(!JOB_STATES.has(nextStatus)||!JOB_NEXT[current.status].has(nextStatus))throw new Error("Invalid job state transition");
    if(error!==null&&(typeof error!=="string"||error.length>500))throw new Error("Invalid job error");
    if(result!==undefined&&!validJobPayload(result))throw new Error("Invalid job result");
    const next={...current,status:nextStatus,updatedAt:clock(),error:nextStatus==="failed"?(error||"Job failed"):null,result:nextStatus==="succeeded"?(result===undefined?current.result:clone(result)):null};
    if(nextStatus==="running")next.attempts+=1;
    await append(c,"job",id,"transition",next);return clone(next);
   });
  }
 };
 const approvals={
  async init(){await init();const r=await pool.query("SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id FROM jarvis.events WHERE aggregate_type='approval' ORDER BY aggregate_id,aggregate_version DESC) q");if(r.rows[0].n>MAX_APPROVALS)throw new Error("Approval store capacity reached");return{ok:true,count:r.rows[0].n};},
  async create({departmentId,actionClass,summary,details="",idempotencyKey=""}={}){
   await init();
   if(!validText(departmentId,64,true)||!/^[a-z][a-z0-9_-]*$/.test(departmentId))throw new Error("Invalid department id");
   if(!ACTIONS.has(actionClass))throw new Error("Invalid approval action class");
   if(!validText(summary,300,true)||!validText(details,MAX_DETAILS)||!validText(idempotencyKey,128))throw new Error("Invalid approval request fields");
   return tx(async c=>{
    if(idempotencyKey){const old=await c.query("SELECT DISTINCT ON (aggregate_id) payload FROM jarvis.events WHERE aggregate_type='approval' AND payload->>'idempotencyKey'=$1 ORDER BY aggregate_id,aggregate_version DESC LIMIT 1",[idempotencyKey]);if(old.rows[0])return{created:false,approval:clone(old.rows[0].payload)};}
    const count=await c.query("SELECT count(DISTINCT aggregate_id)::int AS n FROM jarvis.events WHERE aggregate_type='approval'");if(count.rows[0].n>=MAX_APPROVALS)throw new Error("Approval store capacity reached");
    const now=clock(),approval={id:crypto.randomUUID(),departmentId,actionClass,summary:summary.trim(),details:details.trim(),status:"pending",idempotencyKey,createdAt:now,updatedAt:now,decisionAt:null,decisionReason:"",executionStatus:"not_started",requestDigest:digest({departmentId,actionClass,summary:summary.trim(),details:details.trim()})};
    await append(c,"approval",approval.id,"created",approval,idempotencyKey||null);return{created:true,approval:clone(approval)};
   });
  },
  async get(id){await init();const r=await pool.query("SELECT payload FROM jarvis.events WHERE aggregate_type='approval' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[id]);return r.rows[0]?clone(r.rows[0].payload):null;},
  async list({status,limit=50}={}){await init();if(status&&!APPROVAL_STATES.has(status))throw new Error("Invalid approval status");if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid approval list limit");return allLatest("approval",limit,status);},
  async decide(id,decision,{reason="",actor="system"}={}){
   await init();return tx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["approval:"+id]);
    const current=await latest(c,"approval",id);if(!current)return null;
    if(!["approved","rejected"].includes(decision))throw new Error("Invalid approval decision");
    if(current.status!=="pending")throw new Error("Approval has already been decided");
    if(!validText(reason,1000)||!validText(actor,128,true))throw new Error("Invalid approval decision metadata");
    const expected=digest({departmentId:current.departmentId,actionClass:current.actionClass,summary:current.summary,details:current.details});
    if(current.requestDigest&&current.requestDigest!==expected)throw new Error("Approval request integrity check failed");
    const next={...current,status:decision,updatedAt:clock(),decisionAt:clock(),decisionReason:reason.trim(),decidedBy:actor.trim(),executionStatus:"not_started"};
    await append(c,"approval",id,"decided",next);return clone(next);
   });
  }
 };
 return {jobs,approvals,init,close:()=>pool.end()};
}
module.exports={createPostgresOperationalStores};
