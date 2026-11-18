"use strict";

const {ALL_TASK_STATES}=require("./task-state-machine");
const TASK_STATES=ALL_TASK_STATES;
const ACTIONS=Object.freeze({
  list:"tasks:read",get:"tasks:read",create:"tasks:write",claim:"tasks:claim",
  heartbeat:"tasks:lease",release:"tasks:lease",transition:"tasks:transition",resourceLease:"resources:lease"
});
function createInMemoryTaskRegistryRateLimiter({limit=120,windowMs=60000,clock=()=>Date.now()}={}){
  if(!Number.isInteger(limit)||limit<1||limit>10000||!Number.isInteger(windowMs)||windowMs<1000||windowMs>3600000||typeof clock!=="function")throw new Error("Invalid Task Registry rate limit configuration");
  const buckets=new Map();
  return {async consume(agentId){
    const now=clock();
    if(!Number.isFinite(now))throw new Error("Rate limiter clock is invalid");
    if(buckets.size>10000){
      for(const [key,bucket] of buckets)if(bucket.startedAt+windowMs<=now)buckets.delete(key);
    }
    let bucket=buckets.get(agentId);
    if(!bucket||bucket.startedAt+windowMs<=now){bucket={startedAt:now,count:0};buckets.set(agentId,bucket);}
    if(bucket.count>=limit)return{allowed:false,retryAfter:Math.max(1,Math.ceil((bucket.startedAt+windowMs-now)/1000))};
    bucket.count+=1;
    return{allowed:true,retryAfter:0};
  }};
}

function createTaskRegistryApi({registry=null,authorize=null,json,readJson,rateLimiter=null}={}){
  if(typeof json!=="function"||typeof readJson!=="function")throw new Error("JSON response and request readers are required");
  if(registry&&typeof authorize==="function"&&(!rateLimiter||typeof rateLimiter.consume!=="function"))throw new Error("A shared Task Registry rate limiter must be explicitly configured");
  if(!rateLimiter)rateLimiter={async consume(){throw new Error("Rate limiter is not configured");}};
  async function principalFor(req,action,taskId){
    if(!registry||typeof authorize!=="function")return {error:"unavailable"};
    let principal;
    try{principal=await authorize(req,{action,taskId});}catch{return {error:"unavailable"};}
    if(!principal)return {error:"unauthorized"};
    if(typeof principal.agentId!=="string"||!principal.agentId.trim()||principal.agentId.length>128||!Array.isArray(principal.scopes)||!principal.scopes.includes(ACTIONS[action]))return {error:"forbidden"};
    const projectIds=principal.projectIds===undefined?["one-jarvis"]:principal.projectIds;
    const resourcePrefixes=principal.resourcePrefixes===undefined?[]:principal.resourcePrefixes;
    if(!Array.isArray(projectIds)||projectIds.length<1||projectIds.length>50||projectIds.some(x=>typeof x!=="string"||!/^[A-Za-z0-9._:-]{1,128}$/.test(x))||new Set(projectIds).size!==projectIds.length)return {error:"forbidden"};
    if(!Array.isArray(resourcePrefixes)||resourcePrefixes.length>100||resourcePrefixes.some(x=>typeof x!=="string"||! /^(branch|path|database|migration|deployment|external|media|publication):[A-Za-z0-9._-]{1,128}:$/.test(x)))return {error:"forbidden"};
    let quota;
    try{quota=await rateLimiter.consume(principal.agentId,{projectIds,conversationId:principal.conversationId||"agent:"+principal.agentId,workerId:principal.workerId||principal.agentId,operation:action});}catch{return {error:"unavailable"};}
    if(!quota||quota.allowed!==true)return {error:"rate_limited",retryAfter:Number.isInteger(quota?.retryAfter)?Math.max(1,quota.retryAfter):60};
    return {principal:{...principal,projectIds,resourcePrefixes}};
  }
  function authResponse(res,result){
    if(result.error==="unavailable"){json(res,503,{ok:false,error:"Task Registry API is not configured"});return true;}
    if(result.error==="unauthorized"){json(res,401,{ok:false,error:"Unauthorized"},{"WWW-Authenticate":"Bearer"});return true;}
    if(result.error==="forbidden"){json(res,403,{ok:false,error:"Insufficient task registry scope"});return true;}
    if(result.error==="rate_limited"){json(res,429,{ok:false,error:"Task Registry rate limit exceeded"},{"Retry-After":String(result.retryAfter)});return true;}
    return false;
  }
  function validLease(lease,taskId,agentId){
    return !!lease&&lease.resourceKey==="task:"+taskId&&lease.ownerId===agentId&&typeof lease.token==="string"&&Number.isSafeInteger(lease.fencingToken);
  }
  function errorResponse(res,error){
    if(Number.isInteger(error?.statusCode)&&error.statusCode>=400&&error.statusCode<=499)return json(res,error.statusCode,{ok:false,error:error.statusCode===413?"Request body too large":"Invalid request"});
    const message=typeof error?.message==="string"?error.message:"";
    if(/Invalid task|Invalid lease|Invalid task patch|Invalid task dependencies|Dependency task does not exist/.test(message))return json(res,400,{ok:false,error:message});
    if(/Stale task version|expired, stale|not owned|not claimable|dependency cycle|already|Lease heartbeat rejected|Expired running Task requires|every child task is completed|reconciliation ID and human\/operator identity/.test(message))return json(res,409,{ok:false,error:message});
    return json(res,503,{ok:false,error:"Task Registry operation failed"});
  }
  return async function handleTaskRegistryRequest(req,res,url){
    if(!url||(!url.pathname.startsWith("/v1/tasks")&&!url.pathname.startsWith("/v1/resources/leases")))return false;
    const path=url.pathname;
    try{
      const resourceMatch=/^\/v1\/resources\/leases(?:\/(heartbeat|release))?$/.exec(path);
      if(resourceMatch){
        if(req.method!=="POST")return json(res,405,{ok:false,error:"Method not allowed"});
        const auth=await principalFor(req,"resourceLease");
        if(authResponse(res,auth))return true;
        if(!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req),agentId=auth.principal.agentId,operation=resourceMatch[1]||"acquire";
        if(operation==="acquire"){
          if(typeof d.resourceKey!=="string"||! /^(branch|path|database|migration|deployment|external|media|publication):[A-Za-z0-9._:/-]{1,220}$/.test(d.resourceKey))return json(res,400,{ok:false,error:"Invalid resource key"});
          if(!auth.principal.resourcePrefixes.some(prefix=>d.resourceKey.startsWith(prefix)))return json(res,403,{ok:false,error:"Resource is outside the authenticated agent scope"});
          const lease=await registry.acquireLease({resourceKey:d.resourceKey,ownerId:agentId,leaseMs:d.leaseMs===undefined?60000:d.leaseMs});
          if(!lease)return json(res,409,{ok:false,error:"Resource is already leased"});
          json(res,201,{ok:true,lease});return true;
        }
        if(!d.lease||! /^(branch|path|database|migration|deployment|external|media|publication):/.test(d.lease.resourceKey||"")||d.lease.ownerId!==agentId||typeof d.lease.token!=="string"||!Number.isSafeInteger(d.lease.fencingToken)||!auth.principal.resourcePrefixes.some(prefix=>d.lease.resourceKey.startsWith(prefix)))return json(res,403,{ok:false,error:"Lease owner or resource scope does not match authenticated agent"});
        if(operation==="heartbeat"){
          const lease=await registry.heartbeatLease({lease:d.lease,leaseMs:d.leaseMs===undefined?60000:d.leaseMs});
          json(res,200,{ok:true,lease});return true;
        }
        const released=await registry.releaseLease({lease:d.lease});
        json(res,200,{ok:true,released});return true;
      }
      if(req.method==="GET"&&path==="/v1/tasks"){
        const auth=await principalFor(req,"list");
        if(authResponse(res,auth))return true;
        const status=url.searchParams.get("status")||null;
        const requestedProject=url.searchParams.get("projectId");
        const projectId=requestedProject|| (auth.principal.projectIds.length===1?auth.principal.projectIds[0]:null);
        const limit=Number(url.searchParams.get("limit")||50);
        const offset=Number(url.searchParams.get("offset")||0);
        if(!projectId)return json(res,400,{ok:false,error:"projectId is required for multi-project agents"});
        if(!auth.principal.projectIds.includes(projectId))return json(res,403,{ok:false,error:"Project is outside the authenticated agent scope"});
        if((status!==null&&!TASK_STATES.has(status))||!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0||offset>1000000)return json(res,400,{ok:false,error:"Invalid task list parameters"});
        const tasks=await registry.listTasks({status,limit,offset,projectId,ownerAgent:auth.principal.agentId,ownerConversation:(auth.principal.conversationId||"agent:"+auth.principal.agentId)});
        json(res,200,{ok:true,tasks});return true;
      }
      if(req.method==="POST"&&path==="/v1/tasks"){
        const auth=await principalFor(req,"create");
        if(authResponse(res,auth))return true;
        if(!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req),agentId=auth.principal.agentId;
        const projectId=d.projectId||auth.principal.projectIds[0];
        if(!auth.principal.projectIds.includes(projectId))return json(res,403,{ok:false,error:"Project is outside the authenticated agent scope"});
        const result=await registry.createTask({
          title:d.title,scope:d.scope||"",acceptanceCriteria:d.acceptanceCriteria||[],dedupeKey:d.dedupeKey,departmentId:d.departmentId||"general",
          projectId,priority:d.priority||"P2",
          dependencyTaskIds:d.dependencyTaskIds||[],parentTaskId:d.parentTaskId||null,ownerConversation:auth.principal.conversationId||"agent:"+agentId,ownerAgent:agentId,
          ...(d.status==="ready"&&auth.principal.scopes.includes("tasks:dispatch")?{status:"ready"}:{status:"proposed"})
        });
        json(res,result.created?201:200,{ok:true,...result});return true;
      }
      const match=/^\/v1\/tasks\/([A-Za-z0-9._:-]{1,80})(?:\/(claim|heartbeat|release|transition))?$/.exec(path);
      if(!match)return json(res,404,{ok:false,error:"Not Found"});
      const taskId=match[1],operation=match[2]||"get";
      if(operation==="get"&&req.method==="GET"){
        const auth=await principalFor(req,"get",taskId);
        if(authResponse(res,auth))return true;
        const result=await registry.getTask(taskId,{ownerAgent:auth.principal.agentId,ownerConversation:(auth.principal.conversationId||"agent:"+auth.principal.agentId)});
        if(!result||!auth.principal.projectIds.includes(result.task.projectId))return json(res,404,{ok:false,error:"Task not found"});
        json(res,200,{ok:true,...result});return true;
      }
      if(operation==="claim"&&req.method==="POST"){
        const auth=await principalFor(req,"claim",taskId);
        if(authResponse(res,auth))return true;
        if(!req.headers?.["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req);
        const owned=await registry.getTask(taskId,{ownerAgent:auth.principal.agentId,ownerConversation:(auth.principal.conversationId||"agent:"+auth.principal.agentId)});
        if(!owned||!auth.principal.projectIds.includes(owned.task.projectId))return json(res,404,{ok:false,error:"Task not found"});
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
        const owned=await registry.getTask(taskId,{ownerAgent:agentId,ownerConversation:(auth.principal.conversationId||"agent:"+auth.principal.agentId)});
        if(!owned||!auth.principal.projectIds.includes(owned.task.projectId))return json(res,404,{ok:false,error:"Task not found"});
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
module.exports={createTaskRegistryApi,createInMemoryTaskRegistryRateLimiter};
