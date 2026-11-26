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
function canonicalJson(value){const normalized=JSON.parse(JSON.stringify(value));function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==="object"){const out={};for(const key of Object.keys(v).sort())out[key]=sort(v[key]);return out;}return v;}return JSON.stringify(sort(normalized));}
function digest(v){return crypto.createHash("sha256").update(canonicalJson(v)).digest("hex");}
function approvalRequestDigest(a){if(a.digestVersion!==2)return digest({departmentId:a.departmentId,actionClass:a.actionClass,summary:a.summary,details:a.details});return digest({departmentId:a.departmentId,actionClass:a.actionClass,summary:a.summary,details:a.details,resourceId:a.resourceId||null,operationPayload:a.operationPayload??null,expiresAt:a.expiresAt||null});}
function createPostgresOperationalStores({pool,clock=()=>new Date().toISOString(),authorizeActor=null}={}){
 if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")throw new Error("PostgreSQL pool is required");
 let readyPromise;let migrationPromise;
 async function assertSchema(){
  const base=await pool.query("SELECT to_regclass('jarvis.events') AS events, to_regclass('jarvis.schema_migrations') AS migrations");
  const baseRow=base.rows[0]||{};
  if(!baseRow.events||!baseRow.migrations)throw new Error("Operational store base migration 0001 is not installed");
  const r=await pool.query("SELECT EXISTS(SELECT 1 FROM jarvis.schema_migrations WHERE version='0002_job_approval_stores') AS migration_0002, EXISTS(SELECT 1 FROM jarvis.schema_migrations WHERE version='0003_append_only_event_ledger') AS migration_0003, EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('jarvis.events') AND tgname='jarvis_events_append_only_row' AND NOT tgisinternal) AS append_only_row, EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('jarvis.events') AND tgname='jarvis_events_append_only_truncate' AND NOT tgisinternal) AS append_only_truncate");
  const x=r.rows[0]||{};
  if(x.migration_0002!==true||x.migration_0003!==true||x.append_only_row!==true||x.append_only_truncate!==true)throw new Error("Operational store migrations 0002 and 0003 are not installed");
  return {ok:true};
 }
 async function init(){
  if(readyPromise)return readyPromise;
  readyPromise=assertSchema();
  try{return await readyPromise;}catch(e){readyPromise=null;throw e;}
 }
 async function migrate(){
  if(migrationPromise)return migrationPromise;
  migrationPromise=(async()=>{
   const client=await pool.connect();
   try{
    await client.query("BEGIN");
    await client.query("CREATE INDEX IF NOT EXISTS events_job_idempotency_lookup ON jarvis.events ((payload->>'idempotencyKey'), event_id DESC) WHERE aggregate_type='job' AND payload ? 'idempotencyKey'");
    await client.query("CREATE INDEX IF NOT EXISTS events_approval_idempotency_lookup ON jarvis.events ((payload->>'idempotencyKey'), event_id DESC) WHERE aggregate_type='approval' AND payload ? 'idempotencyKey'");
    await client.query("CREATE INDEX IF NOT EXISTS events_operational_latest ON jarvis.events (aggregate_type, aggregate_id, aggregate_version DESC) WHERE aggregate_type IN ('job','approval')");
    await client.query("INSERT INTO jarvis.schema_migrations(version) VALUES ('0002_job_approval_stores') ON CONFLICT (version) DO NOTHING");
    await client.query("CREATE OR REPLACE FUNCTION jarvis.reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'jarvis.events is append-only' USING ERRCODE = '55000'; END; $$");
    await client.query("DROP TRIGGER IF EXISTS jarvis_events_append_only_row ON jarvis.events");
    await client.query("CREATE TRIGGER jarvis_events_append_only_row BEFORE UPDATE OR DELETE ON jarvis.events FOR EACH ROW EXECUTE FUNCTION jarvis.reject_event_mutation()");
    await client.query("DROP TRIGGER IF EXISTS jarvis_events_append_only_truncate ON jarvis.events");
    await client.query("CREATE TRIGGER jarvis_events_append_only_truncate BEFORE TRUNCATE ON jarvis.events FOR EACH STATEMENT EXECUTE FUNCTION jarvis.reject_event_mutation()");
    await client.query("INSERT INTO jarvis.schema_migrations(version) VALUES ('0003_append_only_event_ledger') ON CONFLICT (version) DO NOTHING");
    await client.query("COMMIT");
    return{ok:true};
   }catch(e){try{await client.query("ROLLBACK");}catch{}throw e;}finally{client.release();}
  })();
  try{return await migrationPromise;}catch(e){migrationPromise=null;throw e;}
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
 async function claimNextJob({workerId,leaseMs=60000}={}){
  await init();
  if(!validText(workerId,128,true)||!Number.isInteger(leaseMs)||leaseMs<5000||leaseMs>3600000)throw new Error("Invalid job lease");
  return tx(async c=>{
   const now=clock();
   const expired=await c.query("SELECT e.aggregate_id,e.payload FROM jarvis.events e WHERE e.aggregate_type='job' AND e.aggregate_version=(SELECT MAX(x.aggregate_version) FROM jarvis.events x WHERE x.aggregate_type='job' AND x.aggregate_id=e.aggregate_id) AND e.payload->>'status'='running' AND NULLIF(e.payload->'lease'->>'expiresAt','')::timestamptz <= $1::timestamptz ORDER BY e.payload->>'createdAt' ASC LIMIT 200 FOR UPDATE SKIP LOCKED",[now]);
   for(const row of expired.rows){
    const id=row.aggregate_id;
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["job:"+id]);
    const current=await latest(c,"job",id);
    if(current?.status==="running"&&current.lease&&Date.parse(current.lease.expiresAt)<=Date.parse(now)){
     const failed={...current,status:"failed",updatedAt:now,error:"Lease expired; external outcome unknown; manual reconciliation required",outcomeUnknown:true,retryAt:null};
     delete failed.lease;
     await append(c,"job",id,"lease_expired_unknown",failed);
    }
   }
   const selected=await c.query("SELECT e.aggregate_id,e.payload FROM jarvis.events e WHERE e.aggregate_type='job' AND e.aggregate_version=(SELECT MAX(x.aggregate_version) FROM jarvis.events x WHERE x.aggregate_type='job' AND x.aggregate_id=e.aggregate_id) AND e.payload->>'status'='queued' AND (NULLIF(e.payload->>'retryAt','') IS NULL OR NULLIF(e.payload->>'retryAt','')::timestamptz <= $1::timestamptz) ORDER BY e.payload->>'createdAt' ASC LIMIT 1 FOR UPDATE SKIP LOCKED",[now]);
   if(!selected.rows[0])return null;
   const id=selected.rows[0].aggregate_id;
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["job:"+id]);
   const latestJob=await latest(c,"job",id);
   if(!latestJob||latestJob.status!=="queued"||(latestJob.retryAt&&Date.parse(latestJob.retryAt)>Date.parse(now)))return null;
   const next={...latestJob,status:"running",attempts:(latestJob.attempts||0)+1,updatedAt:now,retryAt:null,outcomeUnknown:false,lease:{owner:workerId,heartbeatAt:now,expiresAt:new Date(Date.parse(now)+leaseMs).toISOString()}};
   await append(c,"job",next.id,"claimed",next);
   return clone(next);
  });
 }
 async function heartbeatJob(id,{workerId,leaseMs=60000}={}){
  await init();
  if(!validText(workerId,128,true)||!Number.isInteger(leaseMs)||leaseMs<5000||leaseMs>3600000)throw new Error("Invalid job lease");
  return tx(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["job:"+id]);
   const current=await latest(c,"job",id);if(!current)return null;
   const now=clock();
   if(current.status!=="running"||current.lease?.owner!==workerId||Date.parse(current.lease.expiresAt)<=Date.parse(now))throw new Error("Job lease is no longer owned by this worker");
   const next={...current,updatedAt:now,lease:{owner:workerId,heartbeatAt:now,expiresAt:new Date(Date.parse(now)+leaseMs).toISOString()}};
   await append(c,"job",id,"heartbeat",next);return clone(next);
  });
 }
 const jobs={
  async init(){await init();const r=await pool.query("SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id FROM jarvis.events WHERE aggregate_type='job' ORDER BY aggregate_id,aggregate_version DESC) q");if(r.rows[0].n>MAX_JOBS)throw new Error("Job store capacity reached");return{ok:true,count:r.rows[0].n};},
  async create({type,payload,idempotencyKey=""}={}){
   await init();
   if(typeof type!=="string"||!/^[a-z][a-z0-9._-]{1,63}$/.test(type))throw new Error("Invalid job type");
   if(!validJobPayload(payload))throw new Error("Job payload must be an object no larger than 16 KB");
   if(idempotencyKey&&(typeof idempotencyKey!=="string"||idempotencyKey.length>128))throw new Error("Invalid idempotency key");
   return tx(async c=>{
    if(idempotencyKey)await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["job-idempotency:"+idempotencyKey]);
    if(idempotencyKey){const old=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type='job' AND aggregate_id=(SELECT aggregate_id FROM jarvis.events WHERE aggregate_type='job' AND payload->>'idempotencyKey'=$1 ORDER BY event_id ASC LIMIT 1) ORDER BY aggregate_version DESC LIMIT 1",[idempotencyKey]);if(old.rows[0])return{job:clone(old.rows[0].payload),created:false};}
    const count=await c.query("SELECT count(DISTINCT aggregate_id)::int AS n FROM jarvis.events WHERE aggregate_type='job'");
    if(count.rows[0].n>=MAX_JOBS)throw new Error("Job store capacity reached");
    const now=clock(),job={id:crypto.randomUUID(),type,payload:clone(payload),status:"queued",attempts:0,idempotencyKey,createdAt:now,updatedAt:now,error:null,lastError:null,retryAt:null,outcomeUnknown:false,result:null};
    await append(c,"job",job.id,"created",job,idempotencyKey||null);return{job:clone(job),created:true};
   });
  },
  async get(id){await init();const r=await pool.query("SELECT payload FROM jarvis.events WHERE aggregate_type='job' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[id]);return r.rows[0]?clone(r.rows[0].payload):null;},
  async getByIdempotencyKey(key){await init();if(typeof key!=="string"||!key||key.length>128)throw new Error("Invalid idempotency key");const r=await pool.query("SELECT payload FROM jarvis.events WHERE aggregate_type='job' AND aggregate_id=(SELECT aggregate_id FROM jarvis.events WHERE aggregate_type='job' AND payload->>'idempotencyKey'=$1 ORDER BY event_id ASC LIMIT 1) ORDER BY aggregate_version DESC LIMIT 1",[key]);return r.rows[0]?clone(r.rows[0].payload):null;},
  async list({status,limit=50}={}){await init();if(status&&!JOB_STATES.has(status))throw new Error("Invalid job status");if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid list limit");return allLatest("job",limit,status);},
  async transition(id,nextStatus,options={}){
   const {error=null,result=undefined,leaseOwner=null}=options;
   await init();return tx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["job:"+id]);
    const current=await latest(c,"job",id);if(!current)return null;
    if(!JOB_STATES.has(nextStatus)||!JOB_NEXT[current.status].has(nextStatus))throw new Error("Invalid job state transition");
    if(current.lease&&(current.status==="running")&&(!leaseOwner||current.lease.owner!==leaseOwner||Date.parse(current.lease.expiresAt)<=Date.parse(clock())))throw new Error("Job lease is no longer owned by this worker");
    if(error!==null&&(typeof error!=="string"||error.length>500))throw new Error("Invalid job error");
    if(result!==undefined&&!validJobPayload(result))throw new Error("Invalid job result");
    const retryAt=options.retryAt,lastError=options.lastError,outcomeUnknown=options.outcomeUnknown;
    if(retryAt!==undefined&&retryAt!==null&&(typeof retryAt!=="string"||!Number.isFinite(Date.parse(retryAt))))throw new Error("Invalid retry time");
    if(lastError!==undefined&&lastError!==null&&(typeof lastError!=="string"||lastError.length>500))throw new Error("Invalid last error");
    if(outcomeUnknown!==undefined&&typeof outcomeUnknown!=="boolean")throw new Error("Invalid outcome-unknown flag");
    const next={...current,status:nextStatus,updatedAt:clock(),error:nextStatus==="failed"?(error||"Job failed"):null,
      lastError:lastError===undefined?(nextStatus==="queued"?current.lastError||null:null):lastError,
      retryAt:nextStatus==="queued"?(retryAt||null):null,
      outcomeUnknown:nextStatus==="failed"?(outcomeUnknown===undefined?Boolean(current.outcomeUnknown):outcomeUnknown):false,
      result:nextStatus==="succeeded"?(result===undefined?current.result:clone(result)):null};
    if(nextStatus!=="running")delete next.lease;
    if(nextStatus==="running")next.attempts+=1;
    await append(c,"job",id,"transition",next);return clone(next);
   });
  }
 };
 const approvals={
  async init(){await init();const r=await pool.query("SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id FROM jarvis.events WHERE aggregate_type='approval' ORDER BY aggregate_id,aggregate_version DESC) q");if(r.rows[0].n>MAX_APPROVALS)throw new Error("Approval store capacity reached");return{ok:true,count:r.rows[0].n};},
  async create({departmentId,actionClass,summary,details="",idempotencyKey="",resourceId="",operationPayload=null,expiresAt=null}={}){
   await init();
   if(!validText(departmentId,64,true)||!/^[a-z][a-z0-9_-]*$/.test(departmentId))throw new Error("Invalid department id");
   if(!ACTIONS.has(actionClass))throw new Error("Invalid approval action class");
   if(!validText(summary,300,true)||!validText(details,MAX_DETAILS)||!validText(idempotencyKey,128)||!validText(resourceId,256)||!(operationPayload===null||(operationPayload&&typeof operationPayload==="object"&&!Array.isArray(operationPayload)&&bytes(operationPayload)<=MAX_JOB_PAYLOAD))||!(expiresAt===null||(typeof expiresAt==="string"&&Number.isFinite(Date.parse(expiresAt))&&Date.parse(expiresAt)>Date.parse(clock()))))throw new Error("Invalid approval request fields");
   return tx(async c=>{
    if(idempotencyKey)await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["approval-idempotency:"+idempotencyKey]);
    if(idempotencyKey){const old=await c.query("SELECT payload FROM jarvis.events WHERE aggregate_type='approval' AND aggregate_id=(SELECT aggregate_id FROM jarvis.events WHERE aggregate_type='approval' AND payload->>'idempotencyKey'=$1 ORDER BY event_id ASC LIMIT 1) ORDER BY aggregate_version DESC LIMIT 1",[idempotencyKey]);if(old.rows[0]){const prior=old.rows[0].payload;const same=prior.departmentId===departmentId&&prior.actionClass===actionClass&&prior.summary===summary.trim()&&prior.details===details.trim()&&(prior.resourceId||null)===(resourceId||null)&&digest(prior.operationPayload??null)===digest(operationPayload===null?null:operationPayload)&&(prior.expiresAt||null)===(expiresAt||null);if(!same)throw new Error("Approval idempotency key conflict");return{created:false,approval:clone(prior)};}}
    const count=await c.query("SELECT count(DISTINCT aggregate_id)::int AS n FROM jarvis.events WHERE aggregate_type='approval'");if(count.rows[0].n>=MAX_APPROVALS)throw new Error("Approval store capacity reached");
    const now=clock(),approval={id:crypto.randomUUID(),departmentId,actionClass,summary:summary.trim(),details:details.trim(),resourceId:resourceId||null,operationPayload:operationPayload===null?null:clone(operationPayload),expiresAt:expiresAt||null,status:"pending",idempotencyKey,createdAt:now,updatedAt:now,decisionAt:null,decisionReason:"",executionStatus:"not_started",digestVersion:2};approval.requestDigest=approvalRequestDigest(approval);
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
    if(current.expiresAt&&Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
    const expected=approvalRequestDigest(current);
    if(current.requestDigest&&current.requestDigest!==expected)throw new Error("Approval request integrity check failed");
    const next={...current,status:decision,updatedAt:clock(),decisionAt:clock(),decisionReason:reason.trim(),decidedBy:actor.trim(),executionStatus:"not_started"};
    await append(c,"approval",id,"decided",next);return clone(next);
   });
  },
  async verifyExecutionRequest(id,{resourceId,operationPayload}={}){
   await init();const current=await approvals.get(id);if(!current)return null;
   if(current.status!=="approved"||current.executionStatus!=="not_started")throw new Error("Approval is not available for execution");
   if(!current.resourceId||!current.expiresAt||!current.operationPayload)throw new Error("Approval is not bound to an executable resource and payload");
   if(Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
   if(resourceId!==current.resourceId||digest(operationPayload)!==digest(current.operationPayload)||approvalRequestDigest({...current,resourceId,operationPayload})!==current.requestDigest)throw new Error("Approval request integrity check failed");
   return{ok:true,approval:current,requestDigest:current.requestDigest};
  },
  async validateExecutionClaim(id,{claimId,resourceId,operationPayload,actor}={}){
   await init();const current=await approvals.get(id);if(!current)return null;
   if(current.status!=="approved"||current.executionStatus!=="claimed"||!current.executionClaim)throw new Error("Approval execution claim is not active");
   if(!current.expiresAt||Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
   if(current.executionClaim.id!==claimId||current.executionClaim.actor!==actor||resourceId!==current.resourceId||digest(operationPayload)!==digest(current.operationPayload)||current.executionClaim.requestDigest!==current.requestDigest||approvalRequestDigest({...current,resourceId,operationPayload})!==current.requestDigest)throw new Error("Approval execution claim integrity check failed");
   return {ok:true,approval:current,requestDigest:current.requestDigest};
  },
  async claimExecution(id,{resourceId,operationPayload,actor}={}){
   await init();
   if(typeof authorizeActor!=="function"||!validText(actor,128,true)||!(await authorizeActor(actor)))throw new Error("Execution authorization is not configured or actor is not authorized");
   return tx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["approval:"+id]);
    const current=await latest(c,"approval",id);if(!current)return null;
    if(current.status!=="approved"||current.executionStatus!=="not_started")throw new Error("Approval execution has already been claimed or is not approved");
    if(!current.resourceId||!current.expiresAt||!current.operationPayload||Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval is not executable or has expired");
    if(resourceId!==current.resourceId||digest(operationPayload)!==digest(current.operationPayload)||approvalRequestDigest({...current,resourceId,operationPayload})!==current.requestDigest)throw new Error("Approval request integrity check failed");
    const next={...current,executionStatus:"claimed",executionClaim:{id:crypto.randomUUID(),actor:actor.trim(),claimedAt:clock(),requestDigest:current.requestDigest},updatedAt:clock()};
    await append(c,"approval",id,"execution_claimed",next);return clone(next);
   });
  },
  async finishExecution(id,{claimId,actor,outcome,reason=""}={}){
   await init();return tx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["approval:"+id]);
    const current=await latest(c,"approval",id);if(!current)return null;
    if(current.status!=="approved"||current.executionStatus!=="claimed"||!current.executionClaim)throw new Error("Approval execution claim is not active");
    if(current.executionClaim.id!==claimId||current.executionClaim.actor!==actor)throw new Error("Approval execution claim integrity check failed");
    if(!["succeeded","failed"].includes(outcome)||!validText(reason,1000))throw new Error("Invalid approval execution result");
    if(!current.expiresAt||Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
    const next={...current,executionStatus:outcome,executionFinishedAt:clock(),executionReason:reason.trim(),updatedAt:clock()};
    await append(c,"approval",id,"execution_"+outcome,next);return clone(next);
   });
  },
  async expireExecution(id){
   await init();return tx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["approval:"+id]);
    const current=await latest(c,"approval",id);if(!current)return null;
    if(current.status!=="approved"||!current.expiresAt||Date.parse(current.expiresAt)>Date.parse(clock()))throw new Error("Approval has not expired");
    if(!["not_started","claimed"].includes(current.executionStatus))throw new Error("Approval execution is already finalized");
    const next={...current,executionStatus:"expired",executionFinishedAt:clock(),updatedAt:clock()};
    await append(c,"approval",id,"execution_expired",next);return clone(next);
   });
  }
 };
 return {jobs:{...jobs,claimNext:claimNextJob,heartbeat:heartbeatJob},approvals,init,assertSchema,migrate,close:()=>pool.end()};
}
module.exports={createPostgresOperationalStores};
