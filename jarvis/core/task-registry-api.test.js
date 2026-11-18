"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("../server");
const {createInMemoryTaskRegistryRateLimiter}=require("./task-registry-api");

function fixture({configured=true,authorize=true,rateLimiter=null}={}){
  const tasks=new Map();let sequence=0;
  const registry={
    async listTasks({status=null,limit=50,offset=0,ownerAgent=null,ownerConversation=null,projectId=null}={}){return [...tasks.values()].filter(x=>(status===null||x.task.status===status)&&(ownerAgent===null||x.task.ownerAgent===ownerAgent)&&(ownerConversation===null||x.task.ownerConversation===ownerConversation)&&(projectId===null||x.task.projectId===projectId)).slice(offset,offset+limit);},
    async createTask(input){const id="task-"+(++sequence);const task={taskId:id,...input};const value={task,version:1};tasks.set(id,value);return{...value,created:true};},
    async getTask(id,{ownerAgent=null,ownerConversation=null}={}){const value=tasks.get(id);if(!value)return null;if(ownerAgent!==null&&value.task.ownerAgent!==ownerAgent)return null;if(ownerConversation!==null&&value.task.ownerConversation!==ownerConversation)return null;return value;},
    async claimTask({taskId,ownerId,leaseMs}){const current=tasks.get(taskId);if(!current||current.task.status!=="ready")return null;const lease={resourceKey:"task:"+taskId,ownerId,token:"opaque-token",fencingToken:1,expiresAt:new Date(Date.now()+leaseMs).toISOString()};const next={...current.task,status:"claimed",ownerAgent:ownerId};const value={task:next,version:current.version+1};tasks.set(taskId,value);return{...value,lease};},
    async heartbeatLease({lease,leaseMs}){return{...lease,expiresAt:new Date(Date.now()+leaseMs).toISOString()};},
    async releaseLease(){return true;},
    async transitionTask({taskId,expectedVersion,lease,status,patch}){const current=tasks.get(taskId);if(!current)return null;if(current.version!==expectedVersion)throw new Error("Stale task version");const value={task:{...current.task,...patch,status},version:current.version+1};tasks.set(taskId,value);return value;},
    async acquireLease({resourceKey,ownerId,leaseMs}){return{resourceKey,ownerId,token:"resource-token",fencingToken:2,expiresAt:new Date(Date.now()+leaseMs).toISOString()};}
  };
  const scopes=["tasks:read","tasks:write","tasks:dispatch","tasks:claim","tasks:lease","tasks:transition","resources:lease"];
  const server=createServer({
    taskRegistry:configured?registry:null,
    authorizeTaskRegistry:authorize?async(req)=>req.headers.authorization==="Bearer agent-a"?{agentId:"agent-a",conversationId:"opaque-conversation",scopes,projectIds:["one-jarvis"],resourcePrefixes:["path:one-jarvis:"]}:req.headers.authorization==="Bearer agent-b"?{agentId:"agent-b",scopes,projectIds:["other-project"],resourcePrefixes:["path:other-project:"]}:req.headers.authorization==="Bearer agent-a-other"?{agentId:"agent-a",conversationId:"other-conversation",scopes,projectIds:["one-jarvis"],resourcePrefixes:["path:one-jarvis:"]}:req.headers.authorization==="Bearer agent-a-unbound"?{agentId:"agent-a",scopes,projectIds:["one-jarvis"],resourcePrefixes:["path:one-jarvis:"]}:null:null,
    taskRegistryRateLimiter:rateLimiter||createInMemoryTaskRegistryRateLimiter()
  });
  return{server,registry,tasks};
}
async function listen(server){await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));return"http://127.0.0.1:"+server.address().port;}
async function post(root,path,body,token="agent-a"){return fetch(root+path,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)});}

test("Task Registry API fails closed when registry or agent authorization is not configured",async t=>{
  for(const options of [{configured:false,authorize:true},{configured:true,authorize:false}]){
    const {server}=fixture(options);t.after(()=>new Promise(resolve=>server.close(resolve)));
    const root=await listen(server);const response=await fetch(root+"/v1/tasks");
    assert.equal(response.status,503);
  }
});

test("Task Registry API enforces authentication and per-agent scopes",async t=>{
  const {server}=fixture();t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=await listen(server);
  assert.equal((await fetch(root+"/v1/tasks")).status,401);
  const denied=createServer({taskRegistry:{listTasks:async()=>[]},authorizeTaskRegistry:async()=>({agentId:"agent-readonly",scopes:[]}),taskRegistryRateLimiter:createInMemoryTaskRegistryRateLimiter()});
  t.after(()=>new Promise(resolve=>denied.close(resolve)));
  await new Promise(resolve=>denied.listen(0,"127.0.0.1",resolve));
  const response=await fetch("http://127.0.0.1:"+denied.address().port+"/v1/tasks");
  assert.equal(response.status,403);
});

test("Task Registry API creates, claims, heartbeats, transitions and releases under authenticated ownership",async t=>{
  const {server,tasks}=fixture();t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=await listen(server);
  const outOfProject=await post(root,"/v1/tasks",{title:"Forbidden project task",dedupeKey:"api-task-other",projectId:"other-project"});
  assert.equal(outOfProject.status,403);
  assert.equal((await fetch(root+"/v1/tasks?projectId=other-project",{headers:{Authorization:"Bearer agent-a"}})).status,403);
  const created=await post(root,"/v1/tasks",{title:"API task",dedupeKey:"api-task-1",status:"ready",departmentId:"finance",ownerAgent:"spoofed"});
  assert.equal(created.status,201);
  const body=await created.json();assert.equal(body.task.ownerAgent,"agent-a");assert.equal(body.task.status,"ready");assert.equal(body.task.state,"queued");assert.equal(body.task.departmentId,"finance");
  const id=body.task.taskId;
  assert.equal((await fetch(root+"/v1/tasks/"+id,{headers:{Authorization:"Bearer agent-a"}})).status,200);
  assert.equal((await fetch(root+"/v1/tasks/"+id,{headers:{Authorization:"Bearer agent-b"}})).status,404,"another agent cannot read this task");
  assert.equal((await fetch(root+"/v1/tasks/"+id,{headers:{Authorization:"Bearer agent-a-other"}})).status,404,"another conversation cannot read this task");
  const otherAgentList=await fetch(root+"/v1/tasks",{headers:{Authorization:"Bearer agent-b"}});
  assert.deepEqual((await otherAgentList.json()).tasks,[],"task listing is scoped to the authenticated agent");
  const otherConversationList=await fetch(root+"/v1/tasks",{headers:{Authorization:"Bearer agent-a-other"}});
  assert.deepEqual((await otherConversationList.json()).tasks,[],"task listing is scoped to the authenticated conversation");
  assert.equal((await fetch(root+"/v1/tasks/"+id,{headers:{Authorization:"Bearer agent-a-unbound"}})).status,404,"an agent token without a conversation binding cannot read another conversation's task");
  const claimed=await post(root,"/v1/tasks/"+id+"/claim",{leaseMs:10000});
  assert.equal(claimed.status,200);const claim=await claimed.json();
  assert.equal(claim.lease.ownerId,"agent-a");
  const wrongOwner=await post(root,"/v1/tasks/"+id+"/heartbeat",{lease:claim.lease},"agent-b");
  assert.equal(wrongOwner.status,403);
  const renewed=await post(root,"/v1/tasks/"+id+"/heartbeat",{lease:claim.lease,leaseMs:15000});
  assert.equal(renewed.status,200);const lease=(await renewed.json()).lease;
  const transitioned=await post(root,"/v1/tasks/"+id+"/transition",{expectedVersion:2,lease,status:"in_progress",patch:{nextAction:"API verified"}});
  assert.equal(transitioned.status,200);
  const stale=await post(root,"/v1/tasks/"+id+"/transition",{expectedVersion:2,lease,status:"review"});
  assert.equal(stale.status,409);
  const released=await post(root,"/v1/tasks/"+id+"/release",{lease});
  assert.equal(released.status,200);assert.equal((await released.json()).released,true);
  assert.equal(tasks.get(id).version,3);
});

test("resource leases are separate from task leases and require authenticated resource scope",async t=>{
  const {server}=fixture();t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=await listen(server);
  const acquired=await post(root,"/v1/resources/leases",{resourceKey:"path:one-jarvis:jarvis/server.js",leaseMs:10000});
  assert.equal(acquired.status,201);const {lease}=await acquired.json();
  assert.equal(lease.resourceKey,"path:one-jarvis:jarvis/server.js");
  assert.equal((await post(root,"/v1/resources/leases/release",{lease},"agent-b")).status,403);
  const released=await post(root,"/v1/resources/leases/release",{lease});
  assert.equal(released.status,200);assert.equal((await released.json()).released,true);
});

test("agent cannot acquire or release resources outside its explicit resource prefix",async t=>{
  const {server}=fixture();t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=await listen(server);
  assert.equal((await post(root,"/v1/resources/leases",{resourceKey:"path:other-project:secret.txt"})).status,403);
  assert.equal((await post(root,"/v1/resources/leases",{resourceKey:"path:one-jarvis:jarvis/server.js"})).status,201);
});

test("Task Registry API applies a per-agent rate limit and returns Retry-After",async t=>{
  let count=0;
  const rateLimiter={async consume(agentId,context){assert.equal(agentId,"agent-a");assert.deepEqual(context,{projectIds:["one-jarvis"],conversationId:"opaque-conversation",workerId:"agent-a",operation:"list"});count++;return count===1?{allowed:true}:{allowed:false,retryAfter:23};}};
  const {server}=fixture({rateLimiter});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=await listen(server);
  const first=await fetch(root+"/v1/tasks",{headers:{Authorization:"Bearer agent-a"}});
  assert.equal(first.status,200);
  const second=await fetch(root+"/v1/tasks",{headers:{Authorization:"Bearer agent-a"}});
  assert.equal(second.status,429);
  assert.equal(second.headers.get("retry-after"),"23");
  assert.equal((await second.json()).error,"Task Registry rate limit exceeded");
});
