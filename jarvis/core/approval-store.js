"use strict";
const fs=require("node:fs/promises");
const path=require("node:path");
const crypto=require("node:crypto");

const STATES=new Set(["pending","approved","rejected"]);
const ACTIONS=new Set(["external_submit","financial","contract","publish","delete","permission_change","unknown"]);
const MAX_APPROVALS=5000;
const MAX_DETAILS=8000;
function clone(value){return JSON.parse(JSON.stringify(value));}
function validText(value,max,required=false){return typeof value==="string"&&value.length<=max&&(!required||Boolean(value.trim()));}
function publicApproval(item){return clone(item);}

function createApprovalStore({filePath,pool,clock=()=>new Date().toISOString()}={}){
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
  async create({departmentId,actionClass,summary,details="",idempotencyKey=""}={}){
   await ready();return serialize(async()=>{
    if(!validText(departmentId,64,true)||!/^[a-z][a-z0-9_-]*$/.test(departmentId))throw new Error("Invalid department id");
    if(!ACTIONS.has(actionClass))throw new Error("Invalid approval action class");
    if(!validText(summary,300,true)||!validText(details,MAX_DETAILS)||!validText(idempotencyKey,128))throw new Error("Invalid approval request fields");
    if(idempotencyKey){const existing=[...items.values()].find(x=>x.idempotencyKey===idempotencyKey);if(existing)return{created:false,approval:publicApproval(existing)};}
    if(items.size>=MAX_APPROVALS)throw new Error("Approval store capacity reached");
    const now=clock(),approval={id:crypto.randomUUID(),departmentId,actionClass,summary:summary.trim(),details:details.trim(),status:"pending",idempotencyKey,createdAt:now,updatedAt:now,decisionAt:null,decisionReason:"",executionStatus:"not_started"};
    await append({type:"approval",approval});items.set(approval.id,approval);return{created:true,approval:publicApproval(approval)};
   });
  },
  async get(id){await ready();const item=items.get(id);return item?publicApproval(item):null;},
  async list({status,limit=50}={}){await ready();if(status&&!STATES.has(status))throw new Error("Invalid approval status");if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid approval list limit");return[...items.values()].filter(x=>!status||x.status===status).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit).map(publicApproval);},
  async decide(id,decision,{reason=""}={}){
   await ready();return serialize(async()=>{
    const current=items.get(id);if(!current)return null;
    if(!["approved","rejected"].includes(decision))throw new Error("Invalid approval decision");
    if(current.status!=="pending")throw new Error("Approval has already been decided");
    if(!validText(reason,1000))throw new Error("Invalid approval decision reason");
    const next={...current,status:decision,updatedAt:clock(),decisionAt:clock(),decisionReason:reason.trim(),executionStatus:"not_started"};
    await append({type:"approval",approval:next});items.set(id,next);return publicApproval(next);
   });
  }
 };
}
module.exports={createApprovalStore,STATES,ACTIONS};
