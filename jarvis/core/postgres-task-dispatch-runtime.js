"use strict";

const {createTaskDispatcher}=require("./task-dispatcher");

function createPostgresTaskDispatchRuntime({registry,executionKernel,authorizeAgent,handlers,rateLimiter,leaseMs=60000,heartbeatMs=20000}={}){
  if(!registry||!executionKernel||typeof authorizeAgent!=="function"||!handlers||!rateLimiter)throw new Error("PostgreSQL Task Dispatch dependencies are required");
  async function authorizeTask({requesterAgentId,conversationId,projectId,task}={}){
    const principal=await authorizeAgent(requesterAgentId,{projectId,conversationId,requiredScopes:["tasks:dispatch","tasks:claim"]});
    if(!principal)return null;
    if(task&&(task.projectId!==projectId||task.ownerConversation!==conversationId))return null;
    return {...principal,allowed:true};
  }
  async function isAgentEligible({task,principal,targetAgentId=null}={}){
    const expectedAgent=targetAgentId||principal?.agentId;
    return !!principal&&principal.allowed===true&&principal.agentId===expectedAgent&&
      principal.scopes.includes("tasks:dispatch")&&principal.scopes.includes("tasks:claim")&&
      principal.projectIds.includes(task.projectId)&&task.ownerConversation===principal.conversationId;
  }
  async function selectWorker({task,principal,targetAgentId=null,sourceWorker=null,excludeAgentIds=[],excludeWorkerIds=[]}={}){
    const agentId=targetAgentId||(sourceWorker?null:principal?.agentId);
    const rows=await executionKernel.listWorkersForScope({projectId:task.projectId,conversationId:principal.conversationId});
    const now=Date.now();
    const excludedAgents=new Set(excludeAgentIds),excludedWorkers=new Set(excludeWorkerIds);
    const eligible=rows.filter(row=>(agentId===null||row.agent_id===agentId)&&(!sourceWorker||row.agent_id!==sourceWorker.agentId)&&!excludedAgents.has(row.agent_id)&&!excludedWorkers.has(row.worker_id)&&row.department_id===task.departmentId&&
      row.status==="idle"&&!row.current_task_id&&!!row.grant_id&&
      (!!row.heartbeat_at&&Number.isFinite(Date.parse(row.heartbeat_at))&&now-Date.parse(row.heartbeat_at)<=120000));
    if(!eligible.length)return null;
    eligible.sort((a,b)=>String(a.worker_id).localeCompare(String(b.worker_id)));
    for(const row of eligible){
      const targetPrincipal=await authorizeAgent(row.agent_id,{projectId:task.projectId,conversationId:principal.conversationId,requiredScopes:["tasks:dispatch","tasks:claim"]});
      if(targetPrincipal)return {workerId:row.worker_id,agentId:row.agent_id,departmentId:row.department_id};
    }
    return null;
  }
  async function resultWriter({task,version,worker,lease,result}={}){
    const resourceId=("task-result-"+task.taskId+"-v"+version).slice(0,160);
    const resourceLease=await registry.acquireLease({resourceKey:"resource:"+resourceId,ownerId:worker.workerId,leaseMs});
    if(!resourceLease)throw new Error("Task result resource is currently leased");
    try{
      const operationId=("task-result-"+task.taskId+"-"+version).slice(0,160);
      const saved=await executionKernel.writeResource({
        resourceId,projectId:task.projectId,workerId:worker.workerId,taskId:task.taskId,
        lease:resourceLease,taskLease:lease,operationId,idempotencyKey:operationId,
        operationScope:"task.result.persist",
        payload:{taskId:task.taskId,departmentId:task.departmentId,answer:String(result.answer||"").slice(0,12000),
          handoffRequest:result.handoffRequest||null,model:typeof result.model==="string"?result.model.slice(0,120):null},
        expectedVersion:0
      });
      return {fenced:true,resourceId,summary:"Task result persisted with Worker and Task Lease fencing",version:saved.version,replayed:saved.replayed===true};
    }finally{await registry.releaseLease({lease:resourceLease}).catch(()=>{});}
  }
  const departmentHandlers=Object.fromEntries(Object.entries(handlers).filter(([key,value])=>key.startsWith("department.")&&typeof value==="function").map(([key,value])=>[key.slice("department.".length),value]));
  if(Object.keys(departmentHandlers).length!==13)throw new Error("All 13 formal Department Handlers must be registered");
  let recoveryBusy=false;
  async function recoverPostCommitHandoffs({limit=50}={}) {
    if(recoveryBusy||typeof registry.recoverPostCommitHandoff!=="function"||typeof registry.listTaskEvents!=="function")return {scanned:0,recovered:0,waiting:0,skipped:true};
    recoveryBusy=true;
    let scanned=0,recovered=0,waiting=0;
    try{
      for(const status of ["queued","waiting"]){
        const tasks=await registry.listTasks({status,limit});
        for(const item of tasks){
          const task=item.task;
          if(!task?.taskId||!task.projectId||!task.ownerConversation||!task.ownerAgent)continue;
          const events=await registry.listTaskEvents({taskIds:[task.taskId],limit:100});
          const ordered=[...events].sort((a,b)=>Number(a.version)-Number(b.version));
          const latest=ordered[ordered.length-1];
          if(!latest||!["agent_handoff","handoff_reselected","handoff_recovery_waiting","handoff_recovery_exhausted"].includes(latest.eventType))continue;
          scanned++;
          const visitedAgents=ordered.filter(row=>["agent_handoff","handoff_reselected"].includes(row.eventType)).map(row=>row.payload?.toAgentId).filter(Boolean);
          const visitedWorkers=ordered.filter(row=>["agent_handoff","handoff_reselected"].includes(row.eventType)).map(row=>row.payload?.toWorkerId).filter(Boolean);
          const principal={agentId:"system-handoff-recovery",projectIds:[task.projectId],conversationId:task.ownerConversation,scopes:["tasks:dispatch","tasks:claim"],allowed:true};
          const candidate=await selectWorker({task,principal,sourceWorker:{agentId:task.ownerAgent},excludeAgentIds:visitedAgents,excludeWorkerIds:visitedWorkers});
          const result=await registry.recoverPostCommitHandoff({taskId:task.taskId,expectedVersion:item.version,candidateWorkerId:candidate?.workerId||null,maxAttempts:3});
          if(result?.created&&result.waiting)waiting++;
          else if(result?.created&&result.selectedWorker)recovered++;
        }
      }
      return {scanned,recovered,waiting,skipped:false};
    }finally{recoveryBusy=false;}
  }
  const recoveryTimer=setInterval(()=>{recoverPostCommitHandoffs().catch(()=>{});},15000);
  recoveryTimer.unref?.();
  recoverPostCommitHandoffs().catch(()=>{});
  const dispatcher=createTaskDispatcher({registry,executionKernel,authorizeTask,isAgentEligible,selectWorker,handlers:departmentHandlers,resultWriter,rateLimiter,leaseMs,heartbeatMs});
  return {...dispatcher,recoverPostCommitHandoffs,stopHandoffRecovery(){clearInterval(recoveryTimer);}};
}
module.exports={createPostgresTaskDispatchRuntime};
