"use strict";
const {DEPARTMENTS,getFunctionalDepartment}=require("./functional-departments");
const {getDepartmentContract,authorizeDepartmentAction}=require("./department-contracts");

const ID_MAP=Object.freeze({
  management:"management",
  "finance-accounting":"finance",finance:"finance",
  sales:"sales",
  construction:"construction",
  estimating:"estimating",
  "hr-labor":"hr",hr:"hr",
  "legal-contracts":"legal",legal:"legal",
  procurement:"procurement",
  safety:"safety",
  quality:"quality",
  marketing:"marketing",
  video:"video",
  sns:"sns",
  "data-analysis":"analytics",analytics:"analytics",
  "system-development":"engineering",engineering:"engineering",
  "audit-security":"audit",audit:"audit"
});
const CANONICAL_IDS=Object.freeze(DEPARTMENTS.map(x=>x.id));
function resolveDepartmentId(id){return Object.prototype.hasOwnProperty.call(ID_MAP,id)?(ID_MAP[id]==="management"?"management":Object.keys(ID_MAP).find(k=>ID_MAP[k]===ID_MAP[id]&&CANONICAL_IDS.includes(k))||({
  finance:"finance-accounting",hr:"hr-labor",legal:"legal-contracts",analytics:"data-analysis",engineering:"system-development",audit:"audit-security"
}[ID_MAP[id]]||id)):null;}
function getUnifiedDepartment(id){
  const canonicalId=resolveDepartmentId(id);
  if(!canonicalId)return null;
  const functional=getFunctionalDepartment(canonicalId);
  const contractId=ID_MAP[canonicalId];
  const contract=getDepartmentContract(contractId);
  return functional&&contract?{id:canonicalId,functional,contract}:null;
}
function createDepartmentDispatcher({registry,handlers={}}={}){
  for(const method of ["createTask","claimTask","transitionTask","releaseLease"]){
    if(typeof registry?.[method]!=="function")throw new Error("Task Registry method is required: "+method);
  }
  if(!handlers||typeof handlers!=="object"||Array.isArray(handlers))throw new Error("Department handlers must be an object");
  const handlerMap=new Map(Object.entries(handlers));
  for(const [id,handler] of handlerMap)if(!CANONICAL_IDS.includes(id)||typeof handler!=="function")throw new Error("Invalid department handler: "+id);
  return async function dispatch({
    departmentId,title,scope="",dedupeKey,projectId="one-jarvis",
    ownerConversation,workerId,priority="P2",payload={},actionClass="internal_task"
  }={}){
    const department=getUnifiedDepartment(departmentId);
    if(!department)throw new Error("Unknown department; use a canonical or documented contract ID");
    const handler=handlerMap.get(department.id);
    if(!handler)throw new Error("Department handler is not configured: "+department.id);
    const authorization=authorizeDepartmentAction({departmentId:department.contract.id,actionClass});
    if(!authorization.allowed)throw new Error("Department action requires owner approval or is not allowed");
    for(const [key,value,max] of [["title",title,240],["dedupeKey",dedupeKey,240],["projectId",projectId,128],["ownerConversation",ownerConversation,128],["workerId",workerId,128]]){
      if(typeof value!=="string"||!value.trim()||value.length>max)throw new Error("Invalid department task "+key);
    }
    const created=await registry.createTask({
      title,scope,dedupeKey,projectId,ownerConversation,ownerAgent:workerId,
      priority,status:"ready",acceptanceCriteria:[department.functional.mission]
    });
    if(!created?.created)return {created:false,duplicate:true,task:created?.task||null,version:created?.version||null};
    const claim=await registry.claimTask({taskId:created.task.taskId,ownerId:workerId,leaseMs:60000});
    if(!claim)return {created:true,dispatched:false,reason:"TASK_CLAIM_CONFLICT",task:created.task};
    let active={task:claim.task,version:claim.version};
    try{
      active=await registry.transitionTask({
        taskId:created.task.taskId,expectedVersion:active.version,lease:claim.lease,
        status:"in_progress",patch:{nextAction:"Department handler executing"}
      });
      let result;
      try{
        result=await handler(payload,{
          department:department.functional,contract:department.contract,
          task:active.task,lease:claim.lease,workerId,
          permittedTools:department.contract.tools,
          allowedActions:["read","analyze","draft","internal_task","request_approval"]
        });
      }catch(error){
        const blocked=await registry.transitionTask({
          taskId:created.task.taskId,expectedVersion:active.version,lease:claim.lease,
          status:"blocked",patch:{nextAction:error?.outcomeUnknown===true?"Handler outcome unknown; reconcile before retry":"Handler failed; inspect audit evidence before retry"}
        });
        active=blocked;
        return {created:true,dispatched:true,status:"blocked",task:blocked.task};
      }
      const serialized=JSON.stringify(result===undefined?null:result);
      if(typeof serialized!=="string"||serialized.length>12000)throw new Error("Department result exceeds the persistence limit");
      const reviewed=await registry.transitionTask({
        taskId:created.task.taskId,expectedVersion:active.version,lease:claim.lease,
        status:"review",patch:{verificationSummary:serialized,nextAction:"Owner review required"}
      });
      active=reviewed;
      return {created:true,dispatched:true,status:"review",task:reviewed.task,result:result===undefined?null:result};
    }finally{
      await registry.releaseLease({lease:claim.lease});
    }
  };
}
module.exports={CANONICAL_IDS,resolveDepartmentId,getUnifiedDepartment,createDepartmentDispatcher};
