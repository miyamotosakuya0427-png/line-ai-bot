"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPostgresTaskDispatchRuntime}=require("./postgres-task-dispatch-runtime");
const {DEPARTMENTS}=require("./department-agents");

function fixture(handler,authorizeAgentImpl=null){
 const calls=[];
 const task={taskId:"task-1",title:"Runtime Task",scope:"Runtime scope",acceptanceCriteria:["Runtime acceptance"],status:"queued",state:"queued",ownerAgent:"agent-a",ownerConversation:"conversation-a",projectId:"project-a",departmentId:"construction"};
 let current={task,version:1};
 const registry={
  async getTask(){calls.push("get-task");return current;},
  async listTasks(){return[{task:current.task,version:current.version}];},
  async claimTaskForWorker(){calls.push("claim-task");const lease={resourceKey:"task:task-1",ownerId:"worker-a",token:"opaque-task-lease",fencingToken:4};current={task:{...current.task,status:"claimed",state:"claimed",leaseOwner:"worker-a",fencingToken:4},version:2};return{...current,lease};},
  async transitionTask(input){calls.push("transition:"+input.status);current={task:{...current.task,...input.patch,status:input.status,state:input.status},version:input.expectedVersion+1};return current;},
  async heartbeatLease({lease}){return lease;},
  async releaseLease({lease}){calls.push("release:"+lease.resourceKey);return true;},
  async acquireLease({resourceKey,ownerId}){calls.push("acquire:"+resourceKey);return{resourceKey,ownerId,token:"opaque-resource-lease",fencingToken:1};},
  async recordTaskHandoff(input){calls.push("record-handoff");assert.equal(input.handoffRequest.reason,"経営判断の専門確認が必要です");return{created:true,task:{...current.task,ownerAgent:input.toAgentId,departmentId:input.toDepartmentId,resultResourceId:input.resultResourceId,status:"queued",state:"queued"},version:current.version+1};}
 };
 const rows=[
  {worker_id:"worker-a",agent_id:"agent-a",department_id:"construction",status:"idle",current_task_id:null,grant_id:"grant-a",heartbeat_at:new Date().toISOString()},
  {worker_id:"worker-b",agent_id:"agent-b",department_id:"management",status:"idle",current_task_id:null,grant_id:"grant-b",heartbeat_at:new Date().toISOString()}
 ];
 const executionKernel={
  async listWorkersForScope(){return rows;},
  async heartbeatWorker(){},
  async completeWorkerTask(){calls.push("complete-worker");},
  async writeResource(input){calls.push("fenced-write");assert.equal(input.operationScope,"task.result.persist");assert.equal(input.taskLease.ownerId,"worker-a");return{version:1,replayed:false};}
 };
 const authorizeAgent=authorizeAgentImpl||(async(agentId,scope)=>{calls.push("authorize:"+agentId);return{agentId,conversationId:"conversation-a",scopes:["tasks:dispatch","tasks:claim"],projectIds:["project-a"]};});
 const runtime=createPostgresTaskDispatchRuntime({
  registry,executionKernel,authorizeAgent,handlers:Object.fromEntries(DEPARTMENTS.map(department=>["department."+department.id,department.id==="construction"?handler:async()=>({answer:"unused"})])),
  rateLimiter:{async consume(){return{allowed:true};}},leaseMs:5000,heartbeatMs:1000
 });
 return{runtime,calls,registry};
}

test("PostgreSQL dispatch runtime connects authorized Handler execution to fenced result persistence and completion",async()=>{
 const {runtime,calls}=fixture(async payload=>{assert.match(payload.request,/依頼：Runtime Task/);return{answer:"施工部門の分析結果",model:"test-model"};});
 const result=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(result.outcome,"completed");
 assert.equal(result.task.resultResourceId,"task-result-task-1");
 assert.ok(calls.indexOf("fenced-write")<calls.indexOf("transition:completed"));
 assert.ok(calls.includes("complete-worker"));
 assert.ok(calls.includes("release:resource:task-result-task-1"));
});

test("PostgreSQL dispatch runtime verifies the target Agent and persists structured Handoff details before atomic transfer",async()=>{
 const request={departmentId:"management",reason:"経営判断の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"};
 const {runtime,calls}=fixture(async payload=>{assert.match(payload.request,/受入条件：/);return{answer:"経営部門で追加確認します",handoffRequest:request};});
 const result=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(result.outcome,"handed_off");
 assert.equal(result.task.resultResourceId,"task-result-task-1");
 assert.ok(calls.includes("authorize:agent-b"));
 assert.ok(calls.indexOf("fenced-write")<calls.indexOf("record-handoff"));
 assert.equal(calls.includes("complete-worker"),false);
});

test("PostgreSQL dispatch runtime fails closed when live Agent authorization is unavailable",async()=>{
 const {runtime,calls}=fixture(async()=>({answer:"must not run"}),async()=>null);
 await assert.rejects(()=>runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"}),/authorization failed/);
 assert.equal(calls.includes("claim-task"),false);
});

test("revoked target Agent is excluded and the Task waits without committing a Handoff",async()=>{
 const request={departmentId:"management",reason:"経営判断の専門確認が必要です",deliverables:["KPI分析"],acceptanceCriteria:["根拠資料を明記"],actionClass:"analyze"};
 const authorize=async(agentId)=>agentId==="agent-b"?null:{agentId,conversationId:"conversation-a",scopes:["tasks:dispatch","tasks:claim"],projectIds:["project-a"]};
 const {runtime,calls}=fixture(async()=>({answer:"移管候補",handoffRequest:request}),authorize);
 const result=await runtime.dispatchTask({taskId:"task-1",requesterAgentId:"agent-a",conversationId:"conversation-a",projectId:"project-a"});
 assert.equal(result.outcome,"waiting_for_handoff_target");
 assert.equal(result.task.status,"waiting");
 assert.equal(result.task.resultResourceId,"task-result-task-1");
 assert.equal(calls.includes("record-handoff"),false);
});
