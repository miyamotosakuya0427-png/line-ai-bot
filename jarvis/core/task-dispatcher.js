"use strict";
const crypto=require("node:crypto");
const {getDepartment}=require("./department-agents");

function createTaskDispatcher({registry,executionKernel,authorizeTask,isAgentEligible,selectWorker,handlers,resultWriter,rateLimiter,leaseMs=60000,heartbeatMs=20000}={}){
  for(const [name,value] of Object.entries({registry,executionKernel,authorizeTask,isAgentEligible,selectWorker,handlers,resultWriter,rateLimiter})){
    if(!value)throw new Error("Dispatcher dependency is required: "+name);
  }
  for(const method of ["listTasks","getTask","claimTaskForWorker","transitionTask","heartbeatLease","releaseLease"])if(typeof registry[method]!=="function")throw new Error("Task Registry method is required: "+method);
  for(const method of ["heartbeatWorker","completeWorkerTask"])if(typeof executionKernel[method]!=="function")throw new Error("Execution kernel method is required: "+method);
  if(typeof authorizeTask!=="function"||typeof isAgentEligible!=="function"||typeof selectWorker!=="function"||typeof resultWriter!=="function"||typeof rateLimiter.consume!=="function"||!handlers||typeof handlers!=="object"||Array.isArray(handlers))throw new Error("Dispatcher callbacks are invalid");
  if(!Number.isInteger(leaseMs)||leaseMs<5000||leaseMs>3600000||!Number.isInteger(heartbeatMs)||heartbeatMs<1000||heartbeatMs>=leaseMs)throw new Error("Invalid dispatcher lease configuration");
  const handlerMap=new Map(Object.entries(handlers));
  for(const [department,handler] of handlerMap)if(typeof handler!=="function")throw new Error("Invalid task handler: "+department);

  async function dispatchTask({taskId,requesterAgentId,conversationId,projectId}={}){
    if(typeof taskId!=="string"||!taskId.trim())throw new Error("Task ID is required");
    const snapshot=await registry.getTask(taskId,{ownerAgent:requesterAgentId,ownerConversation:conversationId,projectId});
    if(!snapshot) return {dispatched:false,reason:"TASK_NOT_FOUND"};
    const task=snapshot.task;
    const principal=await authorizeTask({requesterAgentId,conversationId,projectId:task.projectId,task});
    if(!principal||principal.allowed!==true||principal.agentId!==requesterAgentId||!principal.projectIds?.includes(task.projectId)||principal.conversationId!==conversationId)throw new Error("Task authorization failed");
    const eligible=await isAgentEligible({task,principal});
    if(eligible!==true)throw new Error("No eligible agent for task");
    const worker=await selectWorker({task,principal});
    if(!worker||typeof worker.workerId!=="string"||(worker.agentId!==principal.agentId&&!principal.workerAgentIds?.includes(worker.agentId))||worker.departmentId!==task.departmentId)throw new Error("Worker selection is not authorized for this task");
    const handler=handlerMap.get(task.departmentId);
    if(!handler)throw new Error("No handler is registered for task department");
    const quota=await rateLimiter.consume(principal.agentId,{projectIds:[task.projectId],conversationId,workerId:worker.workerId,operation:"dispatch"});
    if(!quota||quota.allowed!==true)throw new Error("Shared PostgreSQL dispatch rate limit unavailable or exceeded");
    const revalidated=await authorizeTask({requesterAgentId,conversationId,projectId:task.projectId,task,workerId:worker.workerId});
    if(!revalidated||revalidated.allowed!==true||revalidated.agentId!==requesterAgentId||!revalidated.projectIds?.includes(task.projectId)||revalidated.conversationId!==conversationId)throw new Error("Task authorization expired before claim");
    const claim=await registry.claimTaskForWorker({taskId,workerId:worker.workerId,leaseMs});
    if(!claim)return {dispatched:false,reason:"ATOMIC_CLAIM_CONFLICT",taskId};
    let lease=claim.lease,active=claim,leaseLost=false,taskFinalized=false,handoffCommitted=false,heartbeatBusy=false,heartbeatPromise=Promise.resolve();
    const controller=new AbortController();
    const heartbeat=setInterval(()=>{
      if(heartbeatBusy||leaseLost)return;
      heartbeatBusy=true;
      heartbeatPromise=(async()=>{
        try{
          lease=await registry.heartbeatLease({lease,leaseMs});
          await executionKernel.heartbeatWorker({workerId:worker.workerId,lease});
        }catch(error){
          leaseLost=true;
          controller.abort(new Error("Task lease lost; worker must stop external writes"));
        }finally{heartbeatBusy=false;}
      })();
    },heartbeatMs);
    heartbeat.unref?.();
    try{
      active=await registry.transitionTask({taskId,expectedVersion:claim.version,lease,status:"running",patch:{nextAction:"Dispatcher worker executing"}});
      const handlerRequest=[
        "依頼："+String(active.task.title||""),
        active.task.scope?"対象範囲："+String(active.task.scope):"",
        Array.isArray(active.task.acceptanceCriteria)&&active.task.acceptanceCriteria.length?"受入条件：\n"+active.task.acceptanceCriteria.map(item=>"- "+String(item)).join("\n"):""
      ].filter(Boolean).join("\n\n");
      const result=await handler({request:handlerRequest,task:active.task,worker,signal:controller.signal,lease,principal});
      if(leaseLost)throw new Error("Worker lost its lease before result persistence");
      if(result?.outcomeUnknown===true){
        active=await registry.transitionTask({taskId,expectedVersion:active.version,lease,status:"outcome_unknown",patch:{outcomeUnknownReason:String(result.reason||"External outcome requires reconciliation").slice(0,500)}});
        taskFinalized=true;
        return {dispatched:true,outcome:"outcome_unknown",task:active.task};
      }
      if(result?.success!==true&&typeof result?.answer!=="string"){
        active=await registry.transitionTask({taskId,expectedVersion:active.version,lease,status:"failed",patch:{nextAction:String(result?.reason||"Worker reported failure").slice(0,500)}});
        taskFinalized=true;
        return {dispatched:true,outcome:"failed",task:active.task};
      }
      const saved=await resultWriter({task:active.task,version:active.version,worker,lease,principal,result});
      if(!saved||saved.fenced!==true)throw new Error("Fenced result writer did not confirm a durable write");
      if(result?.handoffRequest!==undefined){
        const request=result.handoffRequest;
        const targetDepartment=getDepartment(request?.departmentId);
        const validText=(value,min,max)=>typeof value==="string"&&value.trim().length>=min&&value.length<=max;
        const validList=value=>Array.isArray(value)&&value.length>=1&&value.length<=20&&value.every(item=>validText(item,1,500));
        if(!request||typeof request!=="object"||Array.isArray(request)||!targetDepartment||targetDepartment.id===active.task.departmentId||!validText(request.reason,10,500)||!validList(request.deliverables)||!validList(request.acceptanceCriteria)||!["read","analyze","draft","internal_task"].includes(request.actionClass))throw new Error("Handler returned an invalid or unregistered structured Handoff request");
        if(typeof registry.recordTaskHandoff!=="function")throw new Error("Atomic Task Handoff is unavailable");
        const targetTask={...active.task,departmentId:request.departmentId,ownerAgent:"pending-target"};
        const targetWorker=await selectWorker({task:targetTask,principal,targetAgentId:request.agentId||null,sourceWorker:worker});
        if(!targetWorker){
          active=await registry.transitionTask({taskId,expectedVersion:active.version,lease,status:"waiting",patch:{nextAction:"No eligible Handoff Worker; awaiting Dispatcher capacity"}});
          taskFinalized=true;
          return {dispatched:true,outcome:"waiting_for_handoff_target",task:active.task};
        }
        if(typeof targetWorker.workerId!=="string"||typeof targetWorker.agentId!=="string"||targetWorker.agentId===worker.agentId||targetWorker.departmentId!==request.departmentId)throw new Error("Handoff target Worker is not eligible");
        const targetPrincipal=await authorizeTask({requesterAgentId:targetWorker.agentId,conversationId,projectId:active.task.projectId,task:targetTask,workerId:targetWorker.workerId});
        if(!targetPrincipal||targetPrincipal.allowed!==true||targetPrincipal.agentId!==targetWorker.agentId||targetPrincipal.conversationId!==conversationId||!targetPrincipal.projectIds?.includes(active.task.projectId))throw new Error("Handoff target Agent authorization failed");
        if(await isAgentEligible({task:targetTask,principal:targetPrincipal,targetAgentId:targetWorker.agentId})!==true)throw new Error("Handoff target Agent is not eligible");
        const idempotencyKey=crypto.createHash("sha256").update(["handler-handoff",taskId,String(active.version),worker.agentId,targetWorker.agentId,request.departmentId].join(":")).digest("hex");
        const handoff=await registry.recordTaskHandoff({taskId,expectedVersion:active.version,lease,fromAgentId:worker.agentId,toAgentId:targetWorker.agentId,fromDepartmentId:active.task.departmentId,toDepartmentId:request.departmentId,idempotencyKey,handoffRequest:{reason:request.reason,deliverables:request.deliverables,acceptanceCriteria:request.acceptanceCriteria,actionClass:request.actionClass}});
        if(!handoff||handoff.created!==true)return {dispatched:true,outcome:"handoff_replayed",task:handoff?.task||active.task};
        active={task:handoff.task,version:handoff.version};
        taskFinalized=true;handoffCommitted=true;
        return {dispatched:true,outcome:"handed_off",task:active.task,handoff:{fromAgentId:worker.agentId,toAgentId:targetWorker.agentId,toDepartmentId:request.departmentId}};
      }
      active=await registry.transitionTask({taskId,expectedVersion:active.version,lease,status:"completed",patch:{verificationSummary:String(saved.summary||"Fenced result persisted").slice(0,1000)}});
      taskFinalized=true;
      return {dispatched:true,outcome:"completed",task:active.task,result:saved};
    }catch(error){
      if(!leaseLost&&active?.version&&active.task?.status==="running"){
        try{active=await registry.transitionTask({taskId,expectedVersion:active.version,lease,status:"outcome_unknown",patch:{outcomeUnknownReason:"Execution or fenced persistence failed; explicit reconciliation required"}});taskFinalized=true;}catch{}
      }
      throw error;
    }finally{
      clearInterval(heartbeat);
      await heartbeatPromise.catch(()=>{});
      if(!leaseLost&&taskFinalized&&!handoffCommitted){
        let workerReleased=false;
        try{
          await executionKernel.completeWorkerTask({workerId:worker.workerId,taskId,lease,finalState:active.task.status==="running"?"outcome_unknown":active.task.status});
          workerReleased=true;
        }catch{}
        if(workerReleased){try{await registry.releaseLease({lease});}catch{}}
      }
    }
  }
  async function handoffTask({taskId,requesterAgentId,conversationId,projectId,toAgentId,toDepartmentId,workerId,lease,expectedVersion,idempotencyKey}={}){
    if(typeof registry.recordTaskHandoff!=="function")throw new Error("Task Registry handoff event support is unavailable");
    const snapshot=await registry.getTask(taskId,{ownerConversation:conversationId,projectId});
    if(!snapshot||snapshot.version!==expectedVersion)return {handedOff:false,reason:"TASK_NOT_FOUND_OR_STALE"};
    const task=snapshot.task;
    const principal=await authorizeTask({requesterAgentId,conversationId,projectId,task,workerId});
    if(!principal||principal.allowed!==true||principal.agentId!==requesterAgentId||principal.conversationId!==conversationId||!principal.projectIds?.includes(task.projectId))throw new Error("Task handoff authorization failed");
    const targetEligible=await isAgentEligible({task:{...task,ownerAgent:toAgentId,departmentId:toDepartmentId},principal,targetAgentId:toAgentId});
    if(targetEligible!==true||typeof toAgentId!=="string"||typeof toDepartmentId!=="string")throw new Error("Handoff target Agent is not eligible");
    if(!lease||lease.ownerId!==workerId||task.leaseOwner!==workerId)throw new Error("Current Worker Lease is required for handoff");
    if(typeof executionKernel.getWorker!=="function")throw new Error("Worker identity lookup is unavailable");
    const sourceWorker=await executionKernel.getWorker(workerId);
    if(!sourceWorker||sourceWorker.agent_id!==requesterAgentId)throw new Error("Requester does not own the source Worker");
    const result=await registry.recordTaskHandoff({taskId,expectedVersion,lease,fromAgentId:sourceWorker.agent_id,toAgentId,fromDepartmentId:task.departmentId,toDepartmentId,idempotencyKey});
    return {handedOff:result.created,task:result.task,version:result.version,event:result.event||null};
  }
  async function dispatchNext({requesterAgentId,conversationId,projectId,limit=20}={}){
    const tasks=await registry.listTasks({status:"queued",limit,ownerAgent:requesterAgentId,ownerConversation:conversationId,projectId});
    const results=[];
    for(const item of tasks)results.push(await dispatchTask({taskId:item.task.taskId,requesterAgentId,conversationId,projectId}));
    return results;
  }
  return {dispatchTask,dispatchNext,handoffTask};
}
module.exports={createTaskDispatcher};
