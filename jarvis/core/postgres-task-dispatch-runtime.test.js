"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPostgresTaskDispatchRuntime}=require("./postgres-task-dispatch-runtime");
const {DEPARTMENTS}=require("./department-agents");

function fixture(handler,authorizeAgentImpl=null,{departmentHandlers={}}={}){
 const calls=[];
 const task={taskId:"task-1",title:"Runtime Task",scope:"Runtime scope",acceptanceCriteria:["Runtime acceptance"],status:"queued",state:"queued",ownerAgent:"agent-a",ownerConversation:"conversation-a",projectId:"project-a",departmentId:"construction"};
 let current={task,version:1};
 const rows=[
  {worker_id:"worker-a",agent_id:"agent-a",department_id:"construction",status:"idle",current_task_id:null,grant_id:"grant-a",heartbeat_at:new Date().toISOString()},
  {worker_id:"worker-b",agent_id:"agent-b",department_id:"management",status:"idle",current_task_id:null,grant_id:"grant-b",heartbeat_at:new Date().toISOString()}
 ];
 const registry={
  async getTask(){calls.push("get-task");return current;},
  async listTasks(){return[{task:current.task,version:current.version}];},
  async claimTaskForWorker({taskId,workerId}){calls.push("claim-task:"+workerId);const row=rows.find(item=>item.worker_id===workerId);if(!row||row.status!=="idle")return null;const lease={resourceKey:"task:"+taskId,ownerId:workerId,token:"opaque-task-lease-"+workerId,fencingToken:4+current.version};row.status="running";row.current_task_id=taskId;current={task:{...current.task,status:"claimed",state:"claimed",leaseOwner:workerId,fencingToken:lease.fencingToken},version:current.version+1};return{...current,lease};},
  async transitionTask(input){calls.push("transition:"+input.status);current={task:{...current.task,...input.patch,status:input.status,state:input.status},version:input.expectedVersion+1};return current;},
  async heartbeatLease({lease}){return lease;},
  async releaseLease({lease}){calls.push("release:"+lease.resourceKey);return true;},
  async acquireLease({resourceKey,ownerId}){calls.push("acquire:"+resourceKey);return{resourceKey,ownerId,token:"opaque-resource-lease",fencingToken:1};},
  async recordTaskHandoff(input){calls.push("record-handoff");assert.equal(input.handoffRequest.reason,"経営判断の専門確認が必要です");const source=rows.find(item=>item.agent_id===input.fromAgentId);source.status="idle";source.current_task_id=null;current={task:{...current.task,ownerAgent:input.toAgentId,departmentId:input.toDepartmentId,resultResourceId:input.resultResourceId,leaseOwner:null,status:"queued",state:"queued"},version:current.version+1};return{created:true,task:current.task,version:current.version};}
 };
 const executionKernel={
  async listWorkersForScope(){return rows;},
  async heartbeatWorker(){},
  async completeWorkerTask({workerId}){calls.push("complete-worker:"+workerId);const row=rows.find(item=>item.worker_id===workerId);if(row){row.status="idle";row.current_task_id=null;}},
  async writeResource(input){calls.push("fenced-write:"+input.resourceId);assert.equal(input.operationScope,"task.result.persist");assert.equal(input.taskLease.ownerId,input.workerId);return{version:1,replayed:false};}
 };
 const authorizeAgent=authorizeAgentImpl||(async(agentId)=>{calls.push("authorize:"+agentId);return{agentId,conversationId:"conversation-a",scopes:["tasks:dispatch","tasks:claim"],projectIds:["project-a"]};});
 const handlerMap=Object.fromEntries(DEPARTMENTS.map(department=>["department."+department.id,departmentHandlers[department.id]||(department.id==="construction"?handler:async()=>({answer:"unused"}))]));
 const runtime=createPostgresTaskDispatchRuntime({registry,executionKernel,authorizeAgent,handlers:handlerMap,rateLimiter:{async consume(){return{allowed:true};}},leaseMs:5000,heartbeatMs:1000});
 return{runtime,calls,registry};
}

test("PostgreSQL dispatch runtime connects authorized Handler execution to fenced result persistence and completion",async()=>{
 const {runtime,calls}=fixture(async payload=>{assert.match(payload.request,/依頼：Runtime Task/);return{answer:"施工部門の分析結果",model:"test-model"};});
 const result=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(result.outcome,"completed");
 assert.equal(result.task.resultResourceId,"task-result-task-1-v3");
 assert.ok(calls.indexOf("fenced-write:task-result-task-1-v3")<calls.indexOf("transition:completed"));
 assert.ok(calls.includes("complete-worker:worker-a"));
 assert.ok(calls.includes("release:resource:task-result-task-1-v3"));
});

test("PostgreSQL dispatch runtime verifies the target Agent and persists structured Handoff details before atomic transfer",async()=>{
 const request={departmentId:"management",reason:"経営判断の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"};
 const {runtime,calls}=fixture(async payload=>{assert.match(payload.request,/受入条件：/);return{answer:"経営部門で追加確認します",handoffRequest:request};});
 const result=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(result.outcome,"handed_off");
 assert.equal(result.task.resultResourceId,"task-result-task-1-v3");
 assert.ok(calls.includes("authorize:agent-b"));
 assert.ok(calls.indexOf("fenced-write:task-result-task-1-v3")<calls.indexOf("record-handoff"));
 assert.equal(calls.includes("complete-worker:worker-a"),false);
});

test("a second Department Handler can execute after Handoff with a distinct fenced result resource",async()=>{
 const handoffRequest={departmentId:"management",reason:"経営判断の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"};
 const {runtime,calls,registry}=fixture(
  async()=>({answer:"施工部門の一次分析",handoffRequest}),
  null,
  {departmentHandlers:{management:async()=>({answer:"経営部門の二次分析",model:"test-model"})}}
 );
 const first=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(first.outcome,"handed_off");
 const second=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-b",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(second.outcome,"completed");
 assert.equal(second.task.ownerAgent,"agent-b");
 assert.equal(second.task.departmentId,"management");
 assert.notEqual(first.task.resultResourceId,second.task.resultResourceId);
 assert.equal(second.task.resultResourceId,"task-result-task-1-v6");
 assert.ok(calls.includes("fenced-write:task-result-task-1-v3"));
 assert.ok(calls.includes("fenced-write:task-result-task-1-v6"));
 assert.ok(calls.includes("complete-worker:worker-b"));
 assert.equal((await registry.getTask("task-1")).task.status,"completed");
});

test("PostgreSQL dispatch runtime fails closed when live Agent authorization is unavailable",async()=>{
 const {runtime,calls}=fixture(async()=>({answer:"must not run"}),async()=>null);
 await assert.rejects(()=>runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"}),/authorization failed/);
 assert.equal(calls.some(value=>value.startsWith("claim-task:")),false);
});

test("revoked target Agent is excluded and the Task waits without committing a Handoff",async()=>{
 const request={departmentId:"management",reason:"経営判断の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"};
 const authorize=async(agentId)=>agentId==="agent-b"?null:{agentId,conversationId:"conversation-a",scopes:["tasks:dispatch","tasks:claim"],projectIds:["project-a"]};
 const {runtime,calls}=fixture(async()=>({answer:"移管候補",handoffRequest:request}),authorize);
 const result=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(result.outcome,"waiting_for_handoff_target");
 assert.equal(result.task.status,"waiting");
 assert.equal(result.task.resultResourceId,"task-result-task-1-v3");
 assert.equal(calls.includes("record-handoff"),false);
});


function recoveryFixture({candidateRows=[]}={}){
 const calls=[];
 const task={taskId:"task-recovery",projectId:"project-a",ownerConversation:"conversation-a",ownerAgent:"agent-old",departmentId:"management",status:"queued",state:"queued"};
 const events=[{eventType:"agent_handoff",version:7,payload:{fromAgentId:"agent-source",toAgentId:"agent-old",toWorkerId:"worker-old",fromDepartmentId:"engineering",toDepartmentId:"management"}}];
 const registry={
  async listTasks({status}){return status==="queued"?[{task,version:7}]:[];},
  async listTaskEvents(){return events;},
  async recoverPostCommitHandoff(input){calls.push(input);return input.candidateWorkerId?{created:true,selectedWorker:{workerId:input.candidateWorkerId}}:{created:true,waiting:true};},
  async getTask(){return null;},async claimTaskForWorker(){return null;},async transitionTask(){},async heartbeatLease(){},async releaseLease(){}
 };
 const executionKernel={async listWorkersForScope(){return candidateRows;},async heartbeatWorker(){},async completeWorkerTask(){}};
 const handlers=Object.fromEntries(DEPARTMENTS.map(department=>["department."+department.id,async()=>({answer:"unused"})]));
 const runtime=createPostgresTaskDispatchRuntime({registry,executionKernel,authorizeAgent:async agentId=>({agentId,conversationId:"conversation-a",projectIds:["project-a"],scopes:["tasks:dispatch","tasks:claim"]}),handlers,rateLimiter:{async consume(){return{allowed:true};}}});
 return{runtime,calls};
}

test("post-commit Handoff recovery selects a different authorized Worker with the same scope",async()=>{
 const {runtime,calls}=recoveryFixture({candidateRows:[{worker_id:"worker-new",agent_id:"agent-new",department_id:"management",status:"idle",current_task_id:null,grant_id:"grant-new",heartbeat_at:new Date().toISOString()}]});
 try{
  const result=await runtime.recoverPostCommitHandoffs();
  assert.deepEqual(result,{scanned:1,recovered:1,waiting:0,skipped:false});
  assert.equal(calls.length,1);
  assert.equal(calls[0].taskId,"task-recovery");
  assert.equal(calls[0].expectedVersion,7);
  assert.equal(calls[0].candidateWorkerId,"worker-new");
  assert.equal(calls[0].maxAttempts,3);
 }finally{runtime.stopHandoffRecovery();}
});

test("post-commit Handoff recovery parks Task when no replacement Worker is eligible",async()=>{
 const {runtime,calls}=recoveryFixture();
 try{
  const result=await runtime.recoverPostCommitHandoffs();
  assert.deepEqual(result,{scanned:1,recovered:0,waiting:1,skipped:false});
  assert.equal(calls[0].candidateWorkerId,null);
 }finally{runtime.stopHandoffRecovery();}
});
