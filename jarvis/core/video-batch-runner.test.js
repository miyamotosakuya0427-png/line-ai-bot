"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createVideoBatchContentHandler}=require("./video-batch-runner");
test("persists a video-batch content result and does not call the AI handler twice after recovery",async()=>{
 let calls=0;let draft=null;
 const store={get:async()=>draft,saveDraft:async(id,value)=>{draft={id,draft:value};return draft;}};
 const handler=createVideoBatchContentHandler({videoBatchStore:store,contentHandler:async()=>{calls++;return{answer:"台本下書き",model:"test",responseId:"resp_1"};}});
 const payload={taskKind:"video-batch-plan",videoId:"V01"};
 const first=await handler(payload,{jobId:"job-1"});
 assert.equal(first.draftPersisted,true);assert.equal(calls,1);assert.equal(draft.draft.answer,"台本下書き");
 const recovered=await handler(payload,{jobId:"job-1-recovered"});
 assert.equal(recovered.reused,true);assert.equal(recovered.answer,"台本下書き");assert.equal(calls,1);
});
test("passes ordinary department content tasks through unchanged",async()=>{
 const payload={request:"通常の動画相談"};let received=null;
 const handler=createVideoBatchContentHandler({videoBatchStore:{get:async()=>null,saveDraft:async()=>null},contentHandler:async p=>{received=p;return{answer:"ok"};}});
 assert.deepEqual(await handler(payload),{answer:"ok"});assert.equal(received,payload);
});
