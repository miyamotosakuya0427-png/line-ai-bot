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
  async function selectWorker({task,principal,targetAgentId=null}={}){
    const agentId=targetAgentId||principal?.agentId;
    const rows=await executionKernel.listWorkersForScope({projectId:task.projectId,conversationId:principal.conversationId});
    const now=Date.now();
    const eligible=rows.filter(row=>row.agent_id===agentId&&row.department_id===task.departmentId&&
      row.status==="idle"&&!row.current_task_id&&!!row.grant_id&&
      (!!row.heartbeat_at&&Number.isFinite(Date.parse(row.heartbeat_at))&&now-Date.parse(row.heartbeat_at)<=120000));
    if(eligible.length!==1)return null;
    const row=eligible[0];
    return {workerId:row.worker_id,agentId:row.agent_id,departmentId:row.department_id};
  }
  async function resultWriter({task,version,worker,lease,result}={}){
    const resourceId=("task-result-"+task.taskId).slice(0,160);
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
      return {fenced:true,summary:"Task result persisted with Worker and Task Lease fencing",version:saved.version,replayed:saved.replayed===true};
    }finally{await registry.releaseLease({lease:resourceLease}).catch(()=>{});}
  }
  return createTaskDispatcher({registry,executionKernel,authorizeTask,isAgentEligible,selectWorker,handlers,resultWriter,rateLimiter,leaseMs,heartbeatMs});
}
module.exports={createPostgresTaskDispatchRuntime};
