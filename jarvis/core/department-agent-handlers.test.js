"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {DEPARTMENTS}=require("./department-agents");
const {HANDOFF_PROTOCOL,INSTRUCTIONS,parseStructuredHandoff,createDepartmentHandlers}=require("./department-agent-handlers");
test("every department has its own isolated AI handler and scoped instructions",()=>{
 const handlers=createDepartmentHandlers({apiKey:"test",fetchImpl:async()=>({ok:true,json:async()=>({output_text:"ok"})})});
 for(const d of DEPARTMENTS){assert.equal(typeof handlers["department."+d.id],"function");assert.ok(INSTRUCTIONS[d.id].length>40);}
 assert.match(INSTRUCTIONS.content,/音読み訓読み/);assert.match(INSTRUCTIONS.tax,/税理士/);assert.match(INSTRUCTIONS.office,/公式一次情報/);
});
test("department handler passes its own role prompt to the model",async()=>{
 let body;const handlers=createDepartmentHandlers({apiKey:"test-key",fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({output_text:"確認結果"})};}});
 const result=await handlers["department.content"]({request:"次の動画の企画を作成"});
 assert.equal(result.answer,"確認結果");assert.match(body.instructions,/ONE CONTENT/);assert.match(body.instructions,/Hinata/);
});

test("department handler attaches only the scoped context returned by its loader",async()=>{
 let body;
 const contextLoader={load:async id=>({status:"available",department:id,employeeCount:4})};
 const handlers=createDepartmentHandlers({apiKey:"test-key",contextLoader,fetchImpl:async(url,options)=>{
  body=JSON.parse(options.body);return {ok:true,json:async()=>({output_text:"ok"})};
 }});
 await handlers["department.hr"]({request:"従業員の状況を分析"});
 const input=body.input;
 assert.match(input,/employeeCount/);
 assert.match(input,/"department":"hr"/);
});

test("all 13 formal Department Handlers expose the structured Handoff protocol",()=>{
 const handlers=createDepartmentHandlers({apiKey:"test",fetchImpl:async()=>({ok:true,json:async()=>({output_text:"通常回答"})})});
 assert.equal(DEPARTMENTS.length,13);
 for(const d of DEPARTMENTS){assert.equal(typeof handlers["department."+d.id],"function");assert.ok(HANDOFF_PROTOCOL.includes("ONE_JARVIS_HANDOFF"));}
});
test("structured Handoff is parsed without changing the legacy answer shape",async()=>{
 const marker='<!-- ONE_JARVIS_HANDOFF: {"departmentId":"management","reason":"経営数値の専門的な確認が必要です","deliverables":["KPI比較表"],"acceptanceCriteria":["数値の出典が明記されている"],"actionClass":"analyze"} -->';
 const handlers=createDepartmentHandlers({apiKey:"test",fetchImpl:async()=>({ok:true,json:async()=>({output_text:"通常の回答本文\n"+marker})})});
 const result=await handlers["department.construction"]({request:"分析"});
 assert.equal(result.answer,"通常の回答本文");
 assert.deepEqual(result.handoffRequest,{departmentId:"management",reason:"経営数値の専門的な確認が必要です",deliverables:["KPI比較表"],acceptanceCriteria:["数値の出典が明記されている"],actionClass:"analyze"});
 assert.equal(typeof result.model,"string");
});
test("unregistered, self-targeted, incomplete and external-action Handoffs fail closed",()=>{
 const valid={departmentId:"management",reason:"専門確認のため移管します",deliverables:["資料"],acceptanceCriteria:["根拠を確認"],actionClass:"analyze"};
 for(const request of [{...valid,departmentId:"not-registered"},{...valid,departmentId:"construction"},{...valid,deliverables:[]},{...valid,actionClass:"publish"}]){
  const answer='本文\n<!-- ONE_JARVIS_HANDOFF: '+JSON.stringify(request)+' -->';
  assert.throws(()=>parseStructuredHandoff(answer,"construction"),/failed validation/);
 }
});

test("each of the 13 Department Handlers can emit a validated structured Handoff while preserving its answer",async()=>{
 let output="";
 const handlers=createDepartmentHandlers({apiKey:"test-key",fetchImpl:async()=>({ok:true,json:async()=>({output_text:output})})});
 for(const source of DEPARTMENTS){
  const target=DEPARTMENTS.find(item=>item.id!==source.id);
  const request={departmentId:target.id,reason:"別部門の専門判断を依頼します",deliverables:["分析メモ"],acceptanceCriteria:["根拠を明記"],actionClass:"analyze"};
  output="通常回答："+source.id+"\n<!-- ONE_JARVIS_HANDOFF: "+JSON.stringify(request)+" -->";
  const result=await handlers["department."+source.id]({request:"部門横断の確認"});
  assert.equal(result.answer,"通常回答："+source.id);
  assert.equal(result.handoffRequest.departmentId,target.id);
  assert.equal("task" in result,false);
  assert.equal("worker" in result,false);
 }
});
