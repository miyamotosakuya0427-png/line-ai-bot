"use strict";
const fs=require("node:fs/promises");
const path=require("node:path");
const crypto=require("node:crypto");

const STATES=new Set(["pending","approved","rejected"]);
const ACTIONS=new Set(["external_submit","financial","contract","publish","delete","permission_change","unknown"]);
const MAX_APPROVALS=5000;
const MAX_DETAILS=8000;
const MAX_APPROVAL_PAYLOAD=16*1024;
function clone(value){return JSON.parse(JSON.stringify(value));}
function bytes(value){try{return Buffer.byteLength(JSON.stringify(value),"utf8");}catch{return Infinity;}}
function validText(value,max,required=false){return typeof value==="string"&&value.length<=max&&(!required||Boolean(value.trim()));}
function publicApproval(item){return clone(item);}
function canonicalJson(value){const normalized=JSON.parse(JSON.stringify(value));function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==="object"){const out={};for(const key of Object.keys(v).sort())out[key]=sort(v[key]);return out;}return v;}return JSON.stringify(sort(normalized));}
function digest(value){return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");}
function approvalRequestDigest(a){if(a.digestVersion!==2)return digest({departmentId:a.departmentId,actionClass:a.actionClass,summary:a.summary,details:a.details});return digest({departmentId:a.departmentId,actionClass:a.actionClass,summary:a.summary,details:a.details,resourceId:a.resourceId||null,operationPayload:a.operationPayload??null,expiresAt:a.expiresAt||null});}

function createApprovalStore({filePath,pool,clock=()=>new Date().toISOString(),authorizeActor=null}={}){
 if(pool)return require("./postgres-operational-stores").createPostgresOperationalStores({pool,clock}).approvals;
 if(typeof filePath!=="string"||!path.isAbsolute(filePath))throw new Error("Approval store requires an absolute persistent file path");
 let items=new Map(),initialized=false,queue=Promise.resolve();
 async function serialize(operation){const result=queue.then(operation);queue=result.catch(()=>{});return result;}
 async function append(event){const handle=await fs.open(filePath,"a",0o600);try{await handle.writeFile(JSON.stringify(event)+"\n","utf8");await handle.sync();}finally{await handle.close();}await fs.chmod(filePath,0o600);}
 async function ready(){if(initialized)return;await serialize(async()=>{
  if(initialized)return;
  await fs.mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
  let raw="";try{raw=await fs.readFile(filePath,"utf8");}catch(error){if(error.code!=="ENOENT")throw error;}
  const recovered=new Map();
  for(const [index,line] of raw.split("\n").entries()){
   if(!line)continue;let event;try{event=JSON.parse(line);}catch{throw new Error("Approval journal is corrupt at line "+(index+1));}
   if(!event||event.type!=="approval"||!event.approval||typeof event.approval.id!=="string"||!STATES.has(event.approval.status))throw new Error("Approval journal contains an invalid event at line "+(index+1));
   recovered.set(event.approval.id,event.approval);
  }
  if(recovered.size>MAX_APPROVALS)throw new Error("Approval journal exceeds configured limit");
  items=recovered;initialized=true;
 });}
 return {
  async init(){await ready();return{ok:true,count:items.size};},
  async create({departmentId,actionClass,summary,details="",idempotencyKey="",resourceId="",operationPayload=null,expiresAt=null}={}){
   await ready();return serialize(async()=>{
    if(!validText(departmentId,64,true)||!/^[a-z][a-z0-9_-]*$/.test(departmentId))throw new Error("Invalid department id");
    if(!ACTIONS.has(actionClass))throw new Error("Invalid approval action class");
    if(!validText(summary,300,true)||!validText(details,MAX_DETAILS)||!validText(idempotencyKey,128)||!validText(resourceId,256)||!(operationPayload===null||(operationPayload&&typeof operationPayload==="object"&&!Array.isArray(operationPayload)&&bytes(operationPayload)<=MAX_APPROVAL_PAYLOAD))||!(expiresAt===null||(typeof expiresAt==="string"&&Number.isFinite(Date.parse(expiresAt))&&Date.parse(expiresAt)>Date.parse(clock()))))throw new Error("Invalid approval request fields");
    if(idempotencyKey){const existing=[...items.values()].find(x=>x.idempotencyKey===idempotencyKey);if(existing){const same=existing.departmentId===departmentId&&existing.actionClass===actionClass&&existing.summary===summary.trim()&&existing.details===details.trim()&&(existing.resourceId||null)===(resourceId||null)&&digest(existing.operationPayload??null)===digest(operationPayload===null?null:operationPayload)&&(existing.expiresAt||null)===(expiresAt||null);if(!same)throw new Error("Approval idempotency key conflict");return{created:false,approval:publicApproval(existing)};}}
    if(items.size>=MAX_APPROVALS)throw new Error("Approval store capacity reached");
    const now=clock(),approval={id:crypto.randomUUID(),departmentId,actionClass,summary:summary.trim(),details:details.trim(),resourceId:resourceId||null,operationPayload:operationPayload===null?null:clone(operationPayload),expiresAt:expiresAt||null,status:"pending",idempotencyKey,createdAt:now,updatedAt:now,decisionAt:null,decisionReason:"",executionStatus:"not_started",digestVersion:2};approval.requestDigest=approvalRequestDigest(approval);
    await append({type:"approval",approval});items.set(approval.id,approval);return{created:true,approval:publicApproval(approval)};
   });
  },
  async get(id){await ready();const item=items.get(id);return item?publicApproval(item):null;},
  async list({status,limit=50}={}){await ready();if(status&&!STATES.has(status))throw new Error("Invalid approval status");if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid approval list limit");return[...items.values()].filter(x=>!status||x.status===status).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit).map(publicApproval);},
  async decide(id,decision,{reason="",actor="system"}={}){
   await ready();return serialize(async()=>{
    const current=items.get(id);if(!current)return null;
    if(!["approved","rejected"].includes(decision))throw new Error("Invalid approval decision");
    if(current.status!=="pending")throw new Error("Approval has already been decided");
    if(!validText(reason,1000)||!validText(actor,128,true))throw new Error("Invalid approval decision metadata");
    if(current.expiresAt&&Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
    if(current.requestDigest&&current.requestDigest!==approvalRequestDigest(current))throw new Error("Approval request integrity check failed");
    const next={...current,status:decision,updatedAt:clock(),decisionAt:clock(),decisionReason:reason.trim(),decidedBy:actor.trim(),executionStatus:"not_started"};
    await append({type:"approval",approval:next});items.set(id,next);return publicApproval(next);
   });
  },
  async verifyExecutionRequest(id,{resourceId,operationPayload}={}){
   await ready();const current=items.get(id);if(!current)return null;
   if(current.status!=="approved"||current.executionStatus!=="not_started")throw new Error("Approval is not available for execution");
   if(!current.resourceId||!current.expiresAt||!current.operationPayload)throw new Error("Approval is not bound to an executable resource and payload");
   if(Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
   const supplied={...current,resourceId,operationPayload};
   if(resourceId!==current.resourceId||digest(operationPayload)!==digest(current.operationPayload)||approvalRequestDigest(supplied)!==current.requestDigest)throw new Error("Approval request integrity check failed");
   return {ok:true,approval:publicApproval(current),requestDigest:current.requestDigest};
  },
  async validateExecutionClaim(id,{claimId,resourceId,operationPayload,actor}={}){
   await ready();const current=items.get(id);if(!current)return null;
   if(current.status!=="approved"||current.executionStatus!=="claimed"||!current.executionClaim)throw new Error("Approval execution claim is not active");
   if(!current.expiresAt||Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
   if(current.executionClaim.id!==claimId||current.executionClaim.actor!==actor||resourceId!==current.resourceId||digest(operationPayload)!==digest(current.operationPayload)||current.executionClaim.requestDigest!==current.requestDigest||approvalRequestDigest({...current,resourceId,operationPayload})!==current.requestDigest)throw new Error("Approval execution claim integrity check failed");
   return {ok:true,approval:publicApproval(current),requestDigest:current.requestDigest};
  },
  async claimExecution(id,{resourceId,operationPayload,actor}={}){
   await ready();return serialize(async()=>{
    if(typeof authorizeActor!=="function"||!validText(actor,128,true)||!(await authorizeActor(actor)))throw new Error("Execution authorization is not configured or actor is not authorized");
    const current=items.get(id);if(!current)return null;
    if(current.status!=="approved"||current.executionStatus!=="not_started")throw new Error("Approval execution has already been claimed or is not approved");
    if(!current.resourceId||!current.expiresAt||!current.operationPayload||Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval is not executable or has expired");
    if(resourceId!==current.resourceId||digest(operationPayload)!==digest(current.operationPayload)||approvalRequestDigest({...current,resourceId,operationPayload})!==current.requestDigest)throw new Error("Approval request integrity check failed");
    const next={...current,executionStatus:"claimed",executionClaim:{id:crypto.randomUUID(),actor:actor.trim(),claimedAt:clock(),requestDigest:current.requestDigest},updatedAt:clock()};
    await append({type:"approval",approval:next});items.set(id,next);return publicApproval(next);
   });
  },
  async finishExecution(id,{claimId,actor,outcome,reason=""}={}){
   await ready();return serialize(async()=>{
    const current=items.get(id);if(!current)return null;
    if(current.status!=="approved"||current.executionStatus!=="claimed"||!current.executionClaim)throw new Error("Approval execution claim is not active");
    if(current.executionClaim.id!==claimId||current.executionClaim.actor!==actor)throw new Error("Approval execution claim integrity check failed");
    if(!["succeeded","failed"].includes(outcome)||!validText(reason,1000))throw new Error("Invalid approval execution result");
    if(!current.expiresAt||Date.parse(current.expiresAt)<=Date.parse(clock()))throw new Error("Approval has expired");
    const next={...current,executionStatus:outcome,executionFinishedAt:clock(),executionReason:reason.trim(),updatedAt:clock()};
    await append({type:"approval",approval:next});items.set(id,next);return publicApproval(next);
   });
  },
  async expireExecution(id){
   await ready();return serialize(async()=>{
    const current=items.get(id);if(!current)return null;
    if(current.status!=="approved"||!current.expiresAt||Date.parse(current.expiresAt)>Date.parse(clock()))throw new Error("Approval has not expired");
    if(!["not_started","claimed"].includes(current.executionStatus))throw new Error("Approval execution is already finalized");
    const next={...current,executionStatus:"expired",executionFinishedAt:clock(),updatedAt:clock()};
    await append({type:"approval",approval:next});items.set(id,next);return publicApproval(next);
   });
  }
 };
}
module.exports={createApprovalStore,STATES,ACTIONS};
