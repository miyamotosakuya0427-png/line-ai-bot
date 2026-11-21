"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createTaskDispatcher}=require("./task-dispatcher");
function fixture({authorized=true,handlerResult={success:true},targetWorker=null}={}){
 const calls=[];
 const task={taskId:"task-1",status:"queued",state:"queued",ownerAgent:"agent-1",ownerConversation:"conversation-1",projectId:"project-1",departmentId:"finance"};
 const registry={
  async getTask(){calls.push("get");return{task,version:1};},
  async listTasks(){calls.push("list");return[{task,version:1}];},
  async claimTaskForWorker(){calls.push("atomic-claim");return{task:{...task,status:"claimed",state:"claimed"},version:2,lease:{resourceKey:"task:task-1",ownerId:"worker-1",token:"opaque",fencingToken:1},worker:{version:1}};},
  async transitionTask(input){calls.push("transition:"+input.status);return{task:{...task,status:input.status,state:input.status},version:input.expectedVersion+1};},
  async heartbeatLease({lease}){return lease;},
  async releaseLease(){calls.push("release");return true;},
  async recordTaskHandoff(input){calls.push("record-handoff");assert.equal(input.fromAgentId,"agent-1");assert.equal(input.toAgentId,"agent-2");assert.equal(input.toDepartmentId,"management");assert.ok(input.idempotencyKey);return{created:true,task:{...task,ownerAgent:input.toAgentId,departmentId:input.toDepartmentId,status:"queued",state:"queued"},version:4};}
 };
 const executionKernel={async heartbeatWorker(){},async completeWorkerTask(){calls.push("worker-release");}};
 const dispatcher=createTaskDispatcher({
  registry,executionKernel,
  async authorizeTask({requesterAgentId="agent-1"}){calls.push("authorize:"+requesterAgentId);return authorized?{allowed:true,agentId:requesterAgentId,conversationId:"conversation-1",projectIds:["project-1"]}:null;},
  async isAgentEligible(){calls.push("eligible");return true;},
  async selectWorker({task:targetTask}){calls.push("select-worker:"+targetTask.departmentId);return targetTask.departmentId==="finance"?{workerId:"worker-1",agentId:"agent-1",departmentId:"finance"}:targetWorker;},
  handlers:{finance:async()=>{calls.push("execute");return handlerResult;}},
  rateLimiter:{async consume(agentId,context){calls.push("rate-limit");assert.equal(agentId,"agent-1");assert.equal(context.operation,"dispatch");return{allowed:true};}},
  async resultWriter(){calls.push("fenced-write");return{fenced:true,summary:"saved"};},
  heartbeatMs:1000,leaseMs:5000
 });
 return{dispatcher,calls};
}
test("Dispatcher uses Task Registry as source and orders auth eligibility selection claim execute fenced save completion",async()=>{
 const {dispatcher,calls}=fixture();
 const result=await dispatcher.dispatchTask({taskId:"task-1",requesterAgentId:"agent-1",conversationId:"conversation-1",projectId:"project-1"});
 assert.equal(result.outcome,"completed");
 assert.deepEqual(calls,["get","authorize:agent-1","eligible","select-worker:finance","rate-limit","authorize:agent-1","atomic-claim","transition:running","execute","fenced-write","transition:completed","worker-release","release"]);
});
test("Dispatcher fails closed before claim when authorization is denied",async()=>{
 const {dispatcher,calls}=fixture({authorized:false});
 await assert.rejects(()=>dispatcher.dispatchTask({taskId:"task-1",requesterAgentId:"agent-1",conversationId:"conversation-1",projectId:"project-1"}),/authorization failed/);
 assert.equal(calls.includes("atomic-claim"),false);
});
test("ambiguous external outcome is quarantined as outcome_unknown without retry",async()=>{
 const {dispatcher,calls}=fixture({handlerResult:{outcomeUnknown:true,reason:"provider timeout"}});
 const result=await dispatcher.dispatchTask({taskId:"task-1",requesterAgentId:"agent-1",conversationId:"conversation-1",projectId:"project-1"});
 assert.equal(result.outcome,"outcome_unknown");
 assert.equal(calls.includes("fenced-write"),false);
 assert.equal(calls.includes("transition:outcome_unknown"),true);
});
test("Dispatcher requires an explicit fenced result writer",()=>{
 assert.throws(()=>createTaskDispatcher({}),/dependency is required/);
});

test("structured Department Handler Handoff is authorized and committed through the common Dispatcher",async()=>{
 const target={workerId:"worker-2",agentId:"agent-2",departmentId:"management"};
 const {dispatcher,calls}=fixture({handlerResult:{handoffRequest:{departmentId:"management",reason:"needs management review"}},targetWorker:target});
 const result=await dispatcher.dispatchTask({taskId:"task-1",requesterAgentId:"agent-1",conversationId:"conversation-1",projectId:"project-1"});
 assert.equal(result.outcome,"handed_off");
 assert.equal(result.task.ownerAgent,"agent-2");
 assert.ok(calls.includes("authorize:agent-2"));
 assert.ok(calls.includes("record-handoff"));
 assert.equal(calls.includes("worker-release"),false,"atomic handoff already releases the source Worker");
});
test("structured Handoff with no eligible destination moves Task to waiting and safely releases source Lease",async()=>{
 const {dispatcher,calls}=fixture({handlerResult:{handoffRequest:{departmentId:"management"}},targetWorker:null});
 const result=await dispatcher.dispatchTask({taskId:"task-1",requesterAgentId:"agent-1",conversationId:"conversation-1",projectId:"project-1"});
 assert.equal(result.outcome,"waiting_for_handoff_target");
 assert.equal(result.task.status,"waiting");
 assert.ok(calls.includes("transition:waiting"));
 assert.ok(calls.includes("worker-release"));
 assert.ok(calls.includes("release"));
});
