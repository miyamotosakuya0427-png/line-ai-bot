"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {CANONICAL_IDS,resolveDepartmentId,getUnifiedDepartment,createDepartmentDispatcher}=require("./department-registry");

function fakeRegistry(){
  const tasks=new Map();let sequence=0;const releases=[];
  return {
    tasks,releases,
    async createTask(input){const task={...input,taskId:"task-"+(++sequence),status:input.status};tasks.set(task.taskId,task);return{created:true,task,version:1};},
    async claimTask({taskId,ownerId}){const task=tasks.get(taskId);task.status="claimed";task.leaseOwner=ownerId;return{task:{...task},version:2,lease:{resourceKey:"task:"+taskId,ownerId,token:"opaque",fencingToken:1,expiresAt:new Date(Date.now()+60000).toISOString()}};},
    async transitionTask({taskId,expectedVersion,status,patch}){assert.ok(expectedVersion>=2);const task={...tasks.get(taskId),...patch,status};tasks.set(taskId,task);return{task,version:expectedVersion+1};},
    async releaseLease({lease}){releases.push(lease);return true;}
  };
}

test("canonical and alternate contract IDs resolve without ambiguous legacy-agent aliases",()=>{
  assert.equal(CANONICAL_IDS.length,16);
  assert.equal(resolveDepartmentId("finance"),"finance-accounting");
  assert.equal(resolveDepartmentId("analytics"),"data-analysis");
  assert.equal(resolveDepartmentId("engineering"),"system-development");
  assert.equal(resolveDepartmentId("audit"),"audit-security");
  assert.equal(resolveDepartmentId("jarvis"),null,"legacy agent IDs are ambiguous and are not auto-routed");
  assert.equal(getUnifiedDepartment("unknown"),null);
});

test("all sixteen departments dispatch through Task Registry claim, handler, review and release",async()=>{
  const registry=fakeRegistry();const calls=[];
  const handlers=Object.fromEntries(CANONICAL_IDS.map(id=>[id,async(payload,context)=>{calls.push({id,payload,context});return{department:id,ok:true};}]));
  const dispatch=createDepartmentDispatcher({registry,handlers});
  for(const id of CANONICAL_IDS){
    const result=await dispatch({departmentId:id,title:"Run "+id,dedupeKey:"dispatch-"+id,ownerConversation:"conversation-1",workerId:"worker-1",payload:{input:id}});
    assert.equal(result.status,"review",id);
    assert.equal(result.task.status,"review",id);
    assert.equal(JSON.parse(result.task.verificationSummary).department,id);
  }
  assert.equal(calls.length,16);
  assert.equal(registry.releases.length,16);
  assert.ok(calls.every(x=>x.context.lease&&x.context.permittedTools.length>0));
});

test("high-impact actions and missing handlers fail closed before task creation",async()=>{
  const registry=fakeRegistry();
  const dispatch=createDepartmentDispatcher({registry,handlers:{"video":async()=>({ok:true})}});
  const input={departmentId:"video",title:"Publish video",dedupeKey:"publish-1",ownerConversation:"conversation-1",workerId:"worker-1"};
  await assert.rejects(dispatch({...input,actionClass:"publish"}),/requires owner approval/);
  assert.equal(registry.tasks.size,0);
  await assert.rejects(dispatch({...input,departmentId:"sales"}),/handler is not configured/);
  assert.equal(registry.tasks.size,0);
});

test("handler outcomes marked unknown are blocked for manual reconciliation and never retried",async()=>{
  const registry=fakeRegistry();let calls=0;
  const dispatch=createDepartmentDispatcher({registry,handlers:{sales:async()=>{calls++;const error=new Error("remote outcome uncertain");error.outcomeUnknown=true;throw error;}}});
  const result=await dispatch({departmentId:"sales",title:"Sales analysis",dedupeKey:"sales-unknown",ownerConversation:"conversation-1",workerId:"worker-1"});
  assert.equal(result.status,"blocked");
  assert.match(result.task.nextAction,/outcome unknown/i);
  assert.equal(calls,1);
  assert.equal(registry.releases.length,1);
});
