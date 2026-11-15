"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {DEPARTMENTS}=require("./department-agents");
const {INSTRUCTIONS,createDepartmentHandlers}=require("./department-agent-handlers");
test("every department has its own isolated AI handler and scoped instructions",()=>{
 const handlers=createDepartmentHandlers({apiKey:"test",fetchImpl:async()=>({ok:true,json:async()=>({output_text:"ok"})})});
 for(const d of DEPARTMENTS){assert.equal(typeof handlers["department."+d.id],"function");assert.ok(INSTRUCTIONS[d.id].length>40);}
 assert.match(INSTRUCTIONS.content,/音読み訓読み/);assert.match(INSTRUCTIONS.tax,/税理士/);assert.match(INSTRUCTIONS.office,/公式一次情報/);
});
test("department handler passes its own role prompt to the model",async()=>{
 let body;const handlers=createDepartmentHandlers({apiKey:"test-key",fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({output_text:"確認結果"})};}});
 const result=await handlers["department.content"]({request:"次の動画の企画を作成"});
 assert.equal(result.answer,"確認結果");assert.match(body.instructions,/ONE CONTENT/);assert.match(body.instructions,/Hinata/);assert.equal(body.max_output_tokens,7000);
});

test("content handler accepts a full-length script review request",async()=>{const handlers=createDepartmentHandlers({apiKey:"test-key",fetchImpl:async(url,options)=>({ok:true,json:async()=>({output_text:"確認項目"})})});const result=await handlers["department.content"]({request:"確認対象："+ "歴史台本".repeat(1800)});assert.equal(result.answer,"確認項目");});
