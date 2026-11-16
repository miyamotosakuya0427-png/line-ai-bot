"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createCommandPlanner,validatePlan}=require("./command-center-planner");

test("validates only known departments and supported action classes",()=>{
 const p=validatePlan({departmentIds:["management","tax"],actionClass:"analyze",rationale:"経営数値と会計の照合"});
 assert.deepEqual(p.departmentIds,["management","tax"]);
 assert.throws(()=>validatePlan({departmentIds:["shell"],actionClass:"analyze",rationale:"bad"}),/unknown/);
 assert.throws(()=>validatePlan({departmentIds:["tax","tax"],actionClass:"analyze",rationale:"bad"}),/duplicate/);
 assert.throws(()=>validatePlan({departmentIds:["office"],actionClass:"execute_shell",rationale:"bad"}),/unsupported/);
});
test("planner parses a structured response and preserves model metadata",async()=>{
 const planner=createCommandPlanner({apiKey:"test-key",model:"test-model",fetchImpl:async(url,options)=>{
  assert.equal(url,"https://api.openai.com/v1/responses");
  assert.match(options.headers.Authorization,/Bearer test-key/);
  return {ok:true,json:async()=>({id:"resp_test",output_text:JSON.stringify({departmentIds:["office"],actionClass:"external_submit",rationale:"申請提出は承認が必要"})})};
 }});
 const result=await planner.plan({request:"補助金を提出して"});
 assert.equal(result.actionClass,"external_submit");assert.equal(result.responseId,"resp_test");
});
test("planner fails closed on malformed responses and missing credentials",async()=>{
 const noKey=createCommandPlanner({apiKey:""});
 await assert.rejects(noKey.plan({request:"test"}),/not configured/);
 const malformed=createCommandPlanner({apiKey:"test",fetchImpl:async()=>({ok:true,json:async()=>({output_text:"not json"})})});
 await assert.rejects(malformed.plan({request:"test"}),/valid JSON/);
});
