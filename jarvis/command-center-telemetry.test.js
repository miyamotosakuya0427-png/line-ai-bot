"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("./server");

const apiToken="a".repeat(40);
const registryToken="b".repeat(40);

async function withServer(options,fn){
 const server=createServer({token:apiToken,...options});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{return await fn("http://127.0.0.1:"+server.address().port);}
 finally{await new Promise(resolve=>server.close(resolve));}
}

function telemetryOptions({scopes=["tasks:read"]}={}){
 const calls=[];
 return {calls,options:{
  taskRegistry:{async listTasks(input){calls.push(input);return[{task:{taskId:"task-1",projectId:"project-1",ownerAgent:"agent-1",ownerConversation:"conversation-1",departmentId:"management",status:"running",state:"running",leaseOwner:"worker-1",fencingToken:7,leaseTokenHash:"task-hash-must-not-leak"}}]},async listTaskEvents({taskIds,limit}){assert.deepEqual(taskIds,["task-1"]);assert.equal(limit,1000);return[{eventId:12,taskId:"task-1",version:3,eventType:"department_handoff",createdAt:"2026-11-20T00:00:01.000Z",payload:{fromAgentId:"agent-1",toAgentId:"agent-2",fromDepartmentId:"management",toDepartmentId:"construction",tokenHash:"must-not-leak"}},{eventId:13,taskId:"task-1",version:4,eventType:"status_changed",createdAt:"2026-11-20T00:00:02.000Z",payload:{status:"running",ownerAgent:"agent-2",leaseOwner:"worker-2",departmentId:"construction",tokenHash:"must-not-leak"}}]}},
  authorizeTaskRegistry:async req=>req.headers.authorization==="Bearer "+registryToken?{agentId:"agent-1",conversationId:"conversation-1",projectIds:["project-1"],scopes}:null,
  taskRegistryRateLimiter:{async consume(){return{allowed:true,retryAfter:0}}},
  executionKernel:{async listWorkersForScope(input){assert.deepEqual(input,{projectId:"project-1",conversationId:"conversation-1"});return[{worker_id:"worker-1",agent_id:"agent-1",department_id:"management",status:"running",current_task_id:"task-1",heartbeat_at:"2026-11-20T00:00:00.000Z",lease_expires_at:"2026-11-20T00:01:00.000Z",fencing_token:7,version:3,grant_id:"grant-1",grant_created_at:"2026-11-20T00:00:00.000Z",token_hash:"must-not-leak"}]}}
 }};
}

test("command center telemetry requires both dashboard auth and scoped Task Registry auth",async()=>{
 const {options}=telemetryOptions();
 await withServer(options,async url=>{
  const missing=await fetch(url+"/v1/command-center/telemetry",{headers:{Authorization:"Bearer "+apiToken}});
  assert.equal(missing.status,401);
  const denied=await fetch(url+"/v1/command-center/telemetry",{headers:{Authorization:"Bearer "+apiToken,"X-Task-Registry-Authorization":"Bearer invalid"}});
  assert.equal(denied.status,401);
 });
});

test("command center telemetry enforces tasks:read scope",async()=>{
 const {options}=telemetryOptions({scopes:["tasks:write"]});
 await withServer(options,async url=>{
  const response=await fetch(url+"/v1/command-center/telemetry",{headers:{Authorization:"Bearer "+apiToken,"X-Task-Registry-Authorization":"Bearer "+registryToken}});
  assert.equal(response.status,403);
 });
});

test("command center telemetry returns only scoped Task and sanitized Worker fields",async()=>{
 const {options,calls}=telemetryOptions();
 await withServer(options,async url=>{
  const response=await fetch(url+"/v1/command-center/telemetry",{headers:{Authorization:"Bearer "+apiToken,"X-Task-Registry-Authorization":"Bearer "+registryToken}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.scope,{agentId:"agent-1",conversationId:"conversation-1",projectIds:["project-1"]});
  assert.equal(body.tasks[0].task.taskId,"task-1");
  assert.equal(body.workers[0].leaseExpiresAt,"2026-11-20T00:01:00.000Z");
  assert.equal(body.workers[0].fencingToken,7);
  assert.equal(body.events.length,2);
  assert.equal(body.handoffs.length,1);
  assert.equal(body.handoffs[0].fromAgentId,"agent-1");
  assert.equal(body.handoffs[0].toDepartmentId,"construction");
  assert.equal(JSON.stringify(body).includes("must-not-leak"),false);
  assert.equal(JSON.stringify(body).includes("task-hash-must-not-leak"),false);
  assert.deepEqual(calls[0],{limit:200,offset:0,projectId:"project-1",ownerAgent:"agent-1",ownerConversation:"conversation-1"});
 });
});

test("command center telemetry fails closed when shared rate limit is exhausted",async()=>{
 const {options}=telemetryOptions();
 options.taskRegistryRateLimiter={async consume(){return{allowed:false,retryAfter:17}}};
 await withServer(options,async url=>{
  const response=await fetch(url+"/v1/command-center/telemetry",{headers:{Authorization:"Bearer "+apiToken,"X-Task-Registry-Authorization":"Bearer "+registryToken}});
  assert.equal(response.status,429);
  assert.equal(response.headers.get("retry-after"),"17");
 });
});
