"use strict";

const TASK_STATES=new Set(["proposed","ready","claimed","in_progress","blocked","review","verified","completed","cancelled"]);
const SAFE_ID=/^[A-Za-z0-9._:-]{1,80}$/;
const ACTIONS=Object.freeze({
  list:"tasks:read",get:"tasks:read",create:"tasks:write",claim:"tasks:claim",
  heartbeat:"tasks:lease",release:"tasks:lease",transition:"tasks:transition"
});

function createTaskRegistryApi({registry=null,authorize=null,json,readJson}={}){
  if(typeof json!=="function"||typeof readJson!=="function")throw new Error("JSON response and request readers are required");
  async function principalFor(req,action,taskId){
    if(!registry||typeof authorize!=="function")return {error:"unavailable"};
    let principal;
    try{principal=await authorize(req,{action,taskId});}catch{return {error:"unavailable"};}
    if(!principal)return {error:"unauthorized"};
    if(typeof principal.agentId!=="string"||!principal.agentId.trim()||principal.agentId.length>128||!Array.isArray(principal.scopes)||!principal.scopes.includes(ACTIONS[action]))return {error:"forbidden"};
    return {principal};
  }
  function authResponse(res,result){
    if(result.error==="unavailable")return json(res,503,{ok:false,error:"Task Registry API is not configured"});
    if(result.error==="unauthorized")return json(res,401,{ok:false,error:"Unauthorized"},{"WWW-Authenticate":"Bearer"});
    if(result.error==="forbidden")return json(res,403,{ok:false,error:"Insufficient task registry scope"});
    return null;
  }
  function validLease(lease,taskId,agentId){
    return !!lease&&lease.resourceKey==="task:"+taskId&&lease.ownerId===agentId&&typeof lease.token==="string"&&Number.isSafeInteger(lease.fencingToken);
  }
  function errorResponse(res,error){
    const message=typeof error?.message==="string"?error.message:"";
    if(/Invalid task|Invalid lease|Invalid task patch|Invalid task dependencies|Dependency task does not exist/.test(message))return json(res,400,{ok:false,error:message});
    if(/Stale task version|expired, stale|not owned|not claimable|dependency cycle|already|Lease heartbeat rejected/.test(message))return json(res,409,{ok:false,error:message});
    return json(res,503,{ok:false,error:"Task Registry operation failed"});
  }
  return async function handleTaskRegistryRequest(req,res,url){
    if(!url||!url.pathname.startsWith("/v1/tasks"))return false;
    const path=url.pathname;
    try{
      if(req.method==="GET"&&path==="/v1/tasks"){
        const auth=await principalFor(req,"list");
        if(authResponse(res,auth))return true;
        const status=url.searchParams.get("status")||null;
        const limit=Number(url.searchParams.get("limit")||50);
        const offset=Number(url.searchParams.get("offset")||0);
        if((status!==null&&!TASK_STATES.has(status))||!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0||offset>1000000)return json(res,400,{ok:false,error:"Invalid task list parameters"});
        const tasks=await registry.listTasks({status,limit,offset});
        json(res,200,{ok:true,tasks});return true;
      }
      if(req.method==="POST"&&path==="/v1/tasks"){
        const auth=await principalFor(req,"create");
        if(authResponse(res,auth))return true;
        if(!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req),agentId=auth.principal.agentId;
        const result=await registry.createTask({
          title:d.title,scope:d.scope||"",acceptanceCriteria:d.acceptanceCriteria||[],dedupeKey:d.dedupeKey,
          projectId:d.projectId||"one-jarvis",priority:d.priority||"P2",status:"proposed",
          dependencyTaskIds:d.dependencyTaskIds||[],ownerConversation:auth.principal.conversationId||"agent:"+agentId,ownerAgent:agentId
        });
        json(res,result.created?201:200,{ok:true,...result});return true;
      }
      const match=/^\/v1\/tasks\/([A-Za-z0-9._:-]{1,80})(?:\/(claim|heartbeat|release|transition))?$/.exec(path);
      if(!match)return json(res,404,{ok:false,error:"Not Found"});
      const taskId=match[1],operation=match[2]||"get";
      if(operation==="get"&&req.method==="GET"){
        const auth=await principalFor(req,"get",taskId);
        if(authResponse(res,auth))return true;
        const result=await registry.getTask(taskId);
        if(!result)return json(res,404,{ok:false,error:"Task not found"});
        json(res,200,{ok:true,...result});return true;
      }
      if(operation==="claim"&&req.method==="POST"){
        const auth=await principalFor(req,"claim",taskId);
        if(authResponse(res,auth))return true;
        if(!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req);
        const result=await registry.claimTask({taskId,ownerId:auth.principal.agentId,leaseMs:d.leaseMs===undefined?60000:d.leaseMs});
        if(!result)return json(res,409,{ok:false,error:"Task is leased or not claimable"});
        json(res,200,{ok:true,...result});return true;
      }
      if(["heartbeat","release","transition"].includes(operation)&&req.method==="POST"){
        const auth=await principalFor(req,operation,taskId);
        if(authResponse(res,auth))return true;
        if(!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req),agentId=auth.principal.agentId;
        if(!validLease(d.lease,taskId,agentId))return json(res,403,{ok:false,error:"Lease owner does not match authenticated agent"});
        if(operation==="heartbeat"){
          const lease=await registry.heartbeatLease({lease:d.lease,leaseMs:d.leaseMs===undefined?60000:d.leaseMs});
          json(res,200,{ok:true,lease});return true;
        }
        if(operation==="release"){
          const released=await registry.releaseLease({lease:d.lease});
          json(res,200,{ok:true,released});return true;
        }
        if(!Number.isSafeInteger(d.expectedVersion)||!TASK_STATES.has(d.status))return json(res,400,{ok:false,error:"Invalid task transition"});
        const result=await registry.transitionTask({taskId,expectedVersion:d.expectedVersion,lease:d.lease,status:d.status,patch:d.patch||{}});
        if(!result)return json(res,404,{ok:false,error:"Task not found"});
        json(res,200,{ok:true,...result});return true;
      }
      return json(res,405,{ok:false,error:"Method not allowed"});
    }catch(error){errorResponse(res,error);return true;}
  };
}
module.exports={createTaskRegistryApi};
