"use strict";
const crypto=require("node:crypto");
const {canonicalJson}=require("./jsonl-migration-dry-run");

function sha(value){return crypto.createHash("sha256").update(value).digest("hex");}
function digestApproval(a){
 const body=a.digestVersion===2
  ?{departmentId:a.departmentId,actionClass:a.actionClass,summary:a.summary,details:a.details,resourceId:a.resourceId||null,operationPayload:a.operationPayload??null,expiresAt:a.expiresAt||null}
  :{departmentId:a.departmentId,actionClass:a.actionClass,summary:a.summary,details:a.details};
 return sha(canonicalJson(body));
}
function validateRecords(jobs,approvals){
 if(!Array.isArray(jobs)||!Array.isArray(approvals))throw new Error("Fixture jobs and approvals must be arrays");
 if(jobs.length>10000||approvals.length>5000)throw new Error("Fixture exceeds operational store capacity");
 const ids=new Set();
 for(const j of jobs){
  if(!j||typeof j!=="object"||typeof j.id!=="string"||!j.id||j.id.length>200||ids.has("job:"+j.id))throw new Error("Invalid or duplicate fixture job ID");
  ids.add("job:"+j.id);
  if(!["queued","running","succeeded","failed","cancelled"].includes(j.status)||!Number.isInteger(j.attempts)||j.attempts<0||!j.payload||typeof j.payload!=="object"||Array.isArray(j.payload)||!Number.isFinite(Date.parse(j.createdAt))||!Number.isFinite(Date.parse(j.updatedAt)))throw new Error("Invalid fixture job record");
  if(j.idempotencyKey&&jobs.some(other=>other!==j&&other.idempotencyKey===j.idempotencyKey))throw new Error("Duplicate fixture job idempotency key");
  if(j.lease&&(!j.lease.owner||!Number.isFinite(Date.parse(j.lease.heartbeatAt))||!Number.isFinite(Date.parse(j.lease.expiresAt))))throw new Error("Invalid fixture job lease");
 }
 for(const a of approvals){
  if(!a||typeof a!=="object"||typeof a.id!=="string"||!a.id||a.id.length>200||ids.has("approval:"+a.id))throw new Error("Invalid or duplicate fixture approval ID");
  ids.add("approval:"+a.id);
  if(!["pending","approved","rejected"].includes(a.status)||typeof a.departmentId!=="string"||typeof a.actionClass!=="string"||typeof a.summary!=="string"||!Number.isFinite(Date.parse(a.createdAt))||!Number.isFinite(Date.parse(a.updatedAt)))throw new Error("Invalid fixture approval record");
  if(a.expiresAt!==undefined&&a.expiresAt!==null&&!Number.isFinite(Date.parse(a.expiresAt)))throw new Error("Invalid fixture approval expiry");
  if(a.requestDigest&&a.requestDigest!==digestApproval(a))throw new Error("Fixture approval digest mismatch");
  if(a.idempotencyKey&&approvals.some(other=>other!==a&&other.idempotencyKey===a.idempotencyKey))throw new Error("Duplicate fixture approval idempotency key");
 }
}
function logicalChecksum(records){return sha(records.slice().sort((a,b)=>a.id.localeCompare(b.id)).map(canonicalJson).join("\n"));}
async function rehearseFixtureImport({pool,jobs,approvals,failAfter=null}={}){
 if(!pool||typeof pool.connect!=="function")throw new Error("A disposable PostgreSQL pool is required");
 if(!pool.options||!pool.options.connectionString)throw new Error("Refusing migration rehearsal: pool connection metadata unavailable");
 const url=new URL(pool.options.connectionString);
 const db=decodeURIComponent(url.pathname.replace(/^\//,""));
 if(!["localhost","127.0.0.1","::1"].includes(url.hostname)||!/(^|[_-])test([_-]|$)/i.test(db))throw new Error("Fixture import is restricted to a local disposable database whose name includes test");
 validateRecords(jobs,approvals);
 const before={jobs:logicalChecksum(jobs),approvals:logicalChecksum(approvals),jobCount:jobs.length,approvalCount:approvals.length};
 const client=await pool.connect();let committed=false;
 try{
  await client.query("BEGIN");
  let inserted=0,identical=0;
  const all=[...jobs.map(record=>({kind:"job",record})),...approvals.map(record=>({kind:"approval",record}))];
  for(const item of all){
   const {kind,record}=item;
   const prior=await client.query("SELECT payload FROM jarvis.events WHERE aggregate_type=$1 AND aggregate_id=$2 ORDER BY aggregate_version DESC LIMIT 1",[kind,record.id]);
   if(prior.rows[0]){
    if(canonicalJson(prior.rows[0].payload)!==canonicalJson(record))throw new Error("Fixture aggregate conflict; refusing overwrite");
    identical++;continue;
   }
   await client.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,idempotency_key,created_at) VALUES($1,$2,1,'fixture_migration_import',$3::jsonb,$4,$5)",[kind,record.id,JSON.stringify(record),record.idempotencyKey||null,record.createdAt]);
   inserted++;
   if(Number.isInteger(failAfter)&&inserted>=failAfter)throw new Error("Injected fixture failure for rollback verification");
  }
  const read=await client.query("SELECT aggregate_type,aggregate_id,payload FROM (SELECT DISTINCT ON (aggregate_type,aggregate_id) aggregate_type,aggregate_id,payload FROM jarvis.events WHERE aggregate_type IN ('job','approval') ORDER BY aggregate_type,aggregate_id,aggregate_version DESC) latest ORDER BY aggregate_type,aggregate_id");
  const dbJobs=read.rows.filter(r=>r.aggregate_type==="job").map(r=>r.payload);
  const dbApprovals=read.rows.filter(r=>r.aggregate_type==="approval").map(r=>r.payload);
  const after={jobs:logicalChecksum(dbJobs),approvals:logicalChecksum(dbApprovals),jobCount:dbJobs.length,approvalCount:dbApprovals.length};
  if(after.jobCount!==before.jobCount||after.approvalCount!==before.approvalCount||after.jobs!==before.jobs||after.approvals!==before.approvals)throw new Error("Fixture migration reconciliation failed");
  await client.query("COMMIT");committed=true;
  return{mode:"fixture-only-transactional-rehearsal",database:db,inserted,identical,source:before,target:after,checksumsMatch:true,rollbackTested:false};
 }catch(error){if(!committed)try{await client.query("ROLLBACK");}catch{}throw error;}
 finally{client.release();}
}
module.exports={rehearseFixtureImport,validateRecords,logicalChecksum};
