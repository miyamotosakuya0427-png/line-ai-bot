"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {CONTRACTS,SAFE_ACTIONS,HIGH_IMPACT_ACTIONS,getDepartmentContract,authorizeDepartmentAction}=require("./department-contracts");

test("ONE JARVIS exposes exactly the sixteen requested core department contracts",()=>{
  assert.equal(CONTRACTS.length,16);
  assert.equal(new Set(CONTRACTS.map(x=>x.id)).size,16);
  for(const id of ["management","finance","sales","construction","estimating","hr","legal","procurement","safety","quality","marketing","video","sns","analytics","engineering","audit"])assert.ok(getDepartmentContract(id),id);
});
test("every department defines purpose, inputs, outputs, scopes, tools and audit evidence",()=>{
  for(const department of CONTRACTS){
    assert.ok(department.mission.length>10);
    for(const field of ["inputs","outputs","scopes","tools","audit"])assert.ok(Array.isArray(department[field])&&department[field].length>0,department.id+":"+field);
  }
});
test("existing department handlers are mapped explicitly and missing handlers are not claimed as implemented",()=>{
  assert.equal(getDepartmentContract("finance").handlerId,"tax");
  assert.equal(getDepartmentContract("video").handlerId,"content");
  assert.equal(getDepartmentContract("sales").handlerId,null);
  assert.equal(getDepartmentContract("audit").handlerId,null);
});
test("routine research and drafting are allowed while high-impact actions require owner approval",()=>{
  for(const department of CONTRACTS){
    for(const actionClass of SAFE_ACTIONS)assert.equal(authorizeDepartmentAction({departmentId:department.id,actionClass}).allowed,true);
    for(const actionClass of HIGH_IMPACT_ACTIONS){const result=authorizeDepartmentAction({departmentId:department.id,actionClass});assert.equal(result.allowed,false);assert.equal(result.approvalRequired,true);}
  }
});
test("unknown departments and action classes fail closed",()=>{
  assert.equal(authorizeDepartmentAction({departmentId:"unknown",actionClass:"read"}).allowed,false);
  assert.equal(authorizeDepartmentAction({departmentId:"sales",actionClass:"run_anything"}).reason,"UNKNOWN_ACTION_FAILS_CLOSED");
});
