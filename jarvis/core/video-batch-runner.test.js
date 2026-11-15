"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createVideoBatchContentHandler}=require("./video-batch-runner");
test("automatically persists ONE CONTENT script drafts and reuses them after worker recovery",async()=>{
 let calls=0;let video={id:"V01",stage:"research",status:"planned"};
 const store={get:async()=>video,saveDraft:async(id,{script,jobId})=>{video={...video,stage:"script",status:"in_progress",draftStatus:"needs_source_review",script,draftJobId:jobId};return{created:true,video};},saveSourceReview:async(id,{answer,jobId})=>{video={...video,sourceReview:{answer,jobId,verified:false}};return{created:true,video};}};
 const handler=createVideoBatchContentHandler({videoBatchStore:store,contentHandler:async()=>{calls++;return{answer:"江戸の大火の台本初稿",model:"test"};}});
 const payload={taskKind:"video-batch-plan",videoId:"V01"},context={jobId:"job-123"};
 const first=await handler(payload,context);
 assert.equal(first.draftPersisted,true);assert.equal(video.stage,"script");assert.equal(video.draftStatus,"needs_source_review");assert.equal(calls,1);
 const recovered=await handler(payload,context);
 assert.equal(recovered.reused,true);assert.equal(recovered.answer,"江戸の大火の台本初稿");assert.equal(calls,1);
});
test("ordinary department.content jobs pass through unchanged",async()=>{
 const payload={request:"通常の動画相談"};let received=null;
 const handler=createVideoBatchContentHandler({videoBatchStore:{get:async()=>null,saveDraft:async()=>null,saveSourceReview:async()=>null},contentHandler:async(p,c)=>{received={p,c};return{answer:"ok"};}});
 const context={jobId:"ordinary-1"};
 assert.deepEqual(await handler(payload,context),{answer:"ok"});assert.deepEqual(received,{p:payload,c:context});
});

test("creates an evidence checklist but never claims source verification",async()=>{let calls=0;let video={id:"V01",stage:"script",script:"台本初稿"};const store={get:async()=>video,saveDraft:async()=>null,saveSourceReview:async(id,{answer,jobId})=>{video={...video,sourceReview:{answer,jobId,verified:false}};return{created:true,video};}};const handler=createVideoBatchContentHandler({videoBatchStore:store,contentHandler:async()=>{calls++;return{answer:"確認すべき主張一覧"};}});const result=await handler({taskKind:"video-batch-source-review",videoId:"V01",request:"台本の主張を抽出"},{jobId:"qa-1"});assert.equal(result.sourceReviewSaved,true);assert.equal(result.verified,false);assert.equal(video.sourceReview.verified,false);assert.equal(calls,1);});

test("source review fetches registered official sources and passes bounded evidence to ONE CONTENT without marking it verified",async()=>{
 let received=null,saved=null,fetchCalls=[];
 const video={id:"V02",stage:"script",script:"明暦三年に江戸で大火が起きた。",sources:["https://www.bousai.go.jp/report","https://www.city.okayama.lg.jp/history","https://attacker.example/blocked"]};
 const store={get:async()=>video,saveDraft:async()=>null,saveSourceReview:async(id,values)=>{saved=values;return{created:true,video:{...video,sourceReview:values}};}};
 const handler=createVideoBatchContentHandler({videoBatchStore:store,sourceFetcher:async(url,options)=>{fetchCalls.push({url,options});return{requestedUrl:url,finalUrl:url,fetchedAt:"2026-11-16T00:00:00.000Z",httpStatus:200,title:"公的資料",contentSha256:"a".repeat(64),text:"明暦三年に江戸で大火が起きた。本文抜粋。",verification:"source_page_fetched_not_claim_verified"};},contentHandler:async(payload)=>{received=payload;return{answer:"資料本文に該当する記述あり。ただし真偽は未検証。"};}});
 const result=await handler({taskKind:"video-batch-source-review",videoId:"V02",request:"台本の主張を確認する"},{jobId:"source-job-2"});
 assert.equal(fetchCalls.length,2);
 assert.equal(fetchCalls[0].options.allowedHosts.length,0);
 assert.match(received.request,/明暦三年に江戸で大火が起きた。本文抜粋。/);
 assert.match(received.request,/主張の正しさを保証しません/);
 assert.equal(saved.sourceSnapshots.length,2);
 assert.equal(result.verified,false);
 assert.equal(result.sourceCount,2);
});
