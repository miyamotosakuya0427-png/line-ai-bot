"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const JOB_STATES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const APPROVAL_STATES = new Set(["pending", "approved", "rejected"]);
const APPROVAL_ACTIONS = new Set(["external_submit", "financial", "contract", "publish", "delete", "permission_change", "unknown"]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function issue(list, line, code, detail) { list.push({ line, code, detail }); }

function validateJob(job, line, issues) {
  if (!validObject(job)) { issue(issues,line,"invalid_job","job must be an object"); return false; }
  let ok = true;
  const required = ["id","type","payload","status","attempts","createdAt","updatedAt"];
  for (const key of required) if (!(key in job)) { issue(issues,line,"missing_job_field",key); ok=false; }
  if (typeof job.id !== "string" || !job.id.trim() || job.id.length>128) { issue(issues,line,"invalid_job_id","id must be a non-empty string up to 128 characters"); ok=false; }
  if (typeof job.type !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(job.type)) { issue(issues,line,"invalid_job_type","type does not match the job store contract"); ok=false; }
  if (!validObject(job.payload) || Buffer.byteLength(JSON.stringify(job.payload)||"","utf8")>16384) { issue(issues,line,"invalid_job_payload","payload must be an object no larger than 16 KB"); ok=false; }
  if (!JOB_STATES.has(job.status)) { issue(issues,line,"invalid_job_status",String(job.status)); ok=false; }
  if (!Number.isInteger(job.attempts) || job.attempts<0) { issue(issues,line,"invalid_job_attempts","attempts must be a non-negative integer"); ok=false; }
  if (!validDate(job.createdAt) || !validDate(job.updatedAt)) { issue(issues,line,"invalid_job_timestamp","createdAt and updatedAt must be parseable timestamps"); ok=false; }
  if (job.idempotencyKey !== undefined && (typeof job.idempotencyKey!=="string" || job.idempotencyKey.length>128)) { issue(issues,line,"invalid_job_idempotency_key","idempotencyKey must be a string up to 128 characters"); ok=false; }
  if (job.error !== undefined && job.error !== null && (typeof job.error!=="string" || job.error.length>500)) { issue(issues,line,"invalid_job_error","error must be null or a string up to 500 characters"); ok=false; }
  if (job.result !== undefined && job.result !== null && !validObject(job.result)) { issue(issues,line,"invalid_job_result","result must be null or an object"); ok=false; }
  if (job.lease !== undefined && job.lease !== null) {
    if (!validObject(job.lease) || typeof job.lease.owner!=="string" || !validDate(job.lease.heartbeatAt) || !validDate(job.lease.expiresAt)) { issue(issues,line,"invalid_job_lease","lease owner and timestamps are invalid"); ok=false; }
  }
  return ok;
}

function validateApproval(a,line,issues) {
  if (!validObject(a)) { issue(issues,line,"invalid_approval","approval must be an object"); return false; }
  let ok=true;
  for (const key of ["id","departmentId","actionClass","summary","status","createdAt","updatedAt"]) {
    if (!(key in a)) { issue(issues,line,"missing_approval_field",key); ok=false; }
  }
  if (typeof a.id!=="string" || !a.id.trim() || a.id.length>128) { issue(issues,line,"invalid_approval_id","id must be a non-empty string up to 128 characters"); ok=false; }
  if (typeof a.departmentId!=="string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(a.departmentId)) { issue(issues,line,"invalid_department_id","departmentId is invalid"); ok=false; }
  if (!APPROVAL_ACTIONS.has(a.actionClass)) { issue(issues,line,"invalid_approval_action",String(a.actionClass)); ok=false; }
  if (typeof a.summary!=="string" || !a.summary.trim() || a.summary.length>300) { issue(issues,line,"invalid_approval_summary","summary must be a non-empty string up to 300 characters"); ok=false; }
  if (a.details!==undefined && (typeof a.details!=="string" || a.details.length>8000)) { issue(issues,line,"invalid_approval_details","details must be a string up to 8000 characters"); ok=false; }
  if (!APPROVAL_STATES.has(a.status)) { issue(issues,line,"invalid_approval_status",String(a.status)); ok=false; }
  if (!validDate(a.createdAt) || !validDate(a.updatedAt)) { issue(issues,line,"invalid_approval_timestamp","createdAt and updatedAt must be parseable timestamps"); ok=false; }
  if (a.idempotencyKey!==undefined && (typeof a.idempotencyKey!=="string" || a.idempotencyKey.length>128)) { issue(issues,line,"invalid_approval_idempotency_key","idempotencyKey must be a string up to 128 characters"); ok=false; }
  if (a.resourceId!==undefined && a.resourceId!==null && (typeof a.resourceId!=="string" || a.resourceId.length>256)) { issue(issues,line,"invalid_resource_id","resourceId must be null or a string up to 256 characters"); ok=false; }
  if (a.operationPayload!==undefined && a.operationPayload!==null && (!validObject(a.operationPayload) || Buffer.byteLength(JSON.stringify(a.operationPayload)||"","utf8")>16384)) { issue(issues,line,"invalid_operation_payload","operationPayload must be null or an object no larger than 16 KB"); ok=false; }
  if (a.expiresAt!==undefined && a.expiresAt!==null && !validDate(a.expiresAt)) { issue(issues,line,"invalid_approval_expiry","expiresAt must be null or a parseable timestamp"); ok=false; }
  if (a.decisionAt!==undefined && a.decisionAt!==null && !validDate(a.decisionAt)) { issue(issues,line,"invalid_decision_timestamp","decisionAt must be null or a parseable timestamp"); ok=false; }
  if (a.requestDigest!==undefined && a.requestDigest!==null && (typeof a.requestDigest!=="string" || !/^[a-f0-9]{64}$/i.test(a.requestDigest))) { issue(issues,line,"invalid_request_digest","requestDigest must be a SHA-256 hex digest"); ok=false; }
  if (a.executionStatus!==undefined && !["not_started","claimed","succeeded","failed","expired"].includes(a.executionStatus)) { issue(issues,line,"invalid_execution_status",String(a.executionStatus)); ok=false; }
  return ok;
}

async function inspectFile(filePath, kind) {
  const report={kind,path:path.resolve(filePath),exists:false,bytes:0,rawSha256:null,canonicalLatestSha256:null,lines:0,validEvents:0,latestRecords:0,invalidLines:[],records:[],duplicateIds:[],duplicateIdempotencyKeys:[],issues:[]};
  let handle;
  try { handle=await fs.open(filePath,"r"); }
  catch(error) {
    if(error.code==="ENOENT") { report.issues.push({line:0,code:"file_missing",detail:"Source file does not exist"}); return report; }
    report.issues.push({line:0,code:"file_read_error",detail:error.code||"Unable to open source"}); return report;
  }
  try {
    const before=await handle.stat();
    if(!before.isFile()) { report.issues.push({line:0,code:"not_regular_file",detail:"Source must be a regular file"}); return report; }
    const raw=await handle.readFile();
    const after=await handle.stat();
    report.exists=true; report.bytes=raw.length; report.rawSha256=sha256(raw);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ino!==after.ino) report.issues.push({line:0,code:"source_changed_during_read",detail:"File metadata changed while being read"});
    const text=raw.toString("utf8");
    if(text.includes("\u0000")) report.issues.push({line:0,code:"nul_byte",detail:"Source contains NUL bytes"});
    const latest=new Map(), idempotency=new Map(), firstSeen=new Map();
    const lines=text.split("\n");
    for(let i=0;i<lines.length;i++) {
      const rawLine=lines[i]; if(rawLine==="") continue;
      report.lines++;
      let event;
      try { event=JSON.parse(rawLine); }
      catch { report.invalidLines.push(i+1); issue(report.issues,i+1,"invalid_json","Line is not valid JSON"); continue; }
      const expected=kind==="job"?"job":"approval";
      if(!validObject(event)||event.type!==expected||!validObject(event[kind])) {
        issue(report.issues,i+1,"invalid_event_envelope","Expected event.type="+expected+" and an object "+kind); continue;
      }
      const record=event[kind];
      const valid=kind==="job"?validateJob(record,i+1,report.issues):validateApproval(record,i+1,report.issues);
      if(!valid) continue;
      report.validEvents++;
      const id=record.id;
      if(!firstSeen.has(id)) firstSeen.set(id,i+1);
      else if((kind==="job" && record.status==="queued" && record.attempts===0 && latest.get(id)?.status==="queued" && latest.get(id)?.attempts===0) ||
              (kind==="approval" && record.status==="pending" && latest.get(id)?.status==="pending")) {
        report.duplicateIds.push({id,firstLine:firstSeen.get(id),duplicateLine:i+1,detail:"Repeated initial snapshot for the same aggregate"});
      }
      latest.set(id,record);
      const key=record.idempotencyKey;
      if(key) {
        if(!idempotency.has(key)) idempotency.set(key,{id,line:i+1});
        else if(idempotency.get(key).id!==id) report.duplicateIdempotencyKeys.push({key,firstId:idempotency.get(key).id,duplicateId:id,line:i+1});
      }
    }
    const latestRecords=[...latest.values()].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    report.latestRecords=latestRecords.length;
    report.canonicalLatestSha256=sha256(latestRecords.map(canonicalJson).join("\n"));
    if(kind==="job" && report.latestRecords>10000) issue(report.issues,0,"capacity_exceeded","Job store supports at most 10000 jobs");
    if(kind==="approval" && report.latestRecords>5000) issue(report.issues,0,"capacity_exceeded","Approval store supports at most 5000 approvals");
  } catch(error) {
    report.issues.push({line:0,code:"read_error",detail:error.code||"Unable to read source"});
  } finally { await handle.close(); }
  return report;
}

async function runDryRun({jobsPath,approvalsPath}={}) {
  if(typeof jobsPath!=="string" || !path.isAbsolute(jobsPath) || typeof approvalsPath!=="string" || !path.isAbsolute(approvalsPath)) {
    throw new Error("Provide absolute --jobs and --approvals paths. This tool only performs a dry-run.");
  }
  const jobs=await inspectFile(jobsPath,"job");
  const approvals=await inspectFile(approvalsPath,"approval");
  const errors=[...jobs.issues,...approvals.issues].length;
  const duplicates=jobs.duplicateIds.length+jobs.duplicateIdempotencyKeys.length+approvals.duplicateIds.length+approvals.duplicateIdempotencyKeys.length;
  return {
    mode:"dry-run-only",
    databaseConnected:false,
    databaseWrites:0,
    sourceWrites:0,
    sourceFilesChanged:false,
    pass:errors===0 && duplicates===0 && jobs.exists && approvals.exists,
    summary:{jobEvents:jobs.validEvents,latestJobs:jobs.latestRecords,approvalEvents:approvals.validEvents,latestApprovals:approvals.latestRecords,errors,duplicates},
    jobs,approvals
  };
}

async function main(argv) {
  const args={};
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if(flag==="--dry-run") continue;
    if(flag==="--jobs" || flag==="--approvals") {
      if(!argv[i+1] || argv[i+1].startsWith("--")) throw new Error("Missing path after "+flag);
      args[flag.slice(2)+"Path"]=path.resolve(argv[++i]);
      continue;
    }
    throw new Error("Unsupported argument: "+flag+". Only --dry-run, --jobs, and --approvals are supported.");
  }
  const report=await runDryRun(args);
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  if(!report.pass) process.exitCode=2;
}
if(require.main===module) main(process.argv.slice(2)).catch(error=>{process.stderr.write("Dry-run refused: "+error.message+"\n");process.exitCode=2;});
module.exports={runDryRun,inspectFile,canonicalJson};
