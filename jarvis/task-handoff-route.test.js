"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {validateHandoffRoute}=require("./core/task-registry-store");

test("handoff route rejects same-department transfer",()=>{
  assert.throws(()=>validateHandoffRoute([],"engineering","engineering"),/different department/);
});
test("handoff route rejects a cycle back to a visited department",()=>{
  const history=[{payload:{fromDepartmentId:"engineering",toDepartmentId:"management"}},{payload:{fromDepartmentId:"management",toDepartmentId:"finance"}}];
  assert.throws(()=>validateHandoffRoute(history,"finance","engineering"),/cycle detected/);
});
test("handoff route rejects an additional transfer after the bounded maximum",()=>{
  const history=Array.from({length:8},(_,i)=>({payload:{fromDepartmentId:"dept-"+i,toDepartmentId:"dept-"+(i+1)}}));
  assert.throws(()=>validateHandoffRoute(history,"dept-8","dept-9",8),/limit exceeded/);
});
test("handoff route permits a new department not visited earlier",()=>{
  const history=[{payload:{fromDepartmentId:"engineering",toDepartmentId:"management"}}];
  assert.equal(validateHandoffRoute(history,"management","finance"),true);
});
