"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createVideoBatchContentHandler}=require("./video-batch-runner");
test("automatically persists ONE CONTENT script drafts and reuses them after worker recovery",async()=>{
 let calls=0;let video={id:"V01",stage:"research",status:"planned"};
 const store={get:async()=>video,saveDraft:async(id,{script,jobId})=>{video={...video,stage:"script",status:"in_progress",draftStatus:"needs_source_review",script,draftJobId:jobId};return{created:true,video};}};
 const handler=createVideoBatchContentHandler({videoBatchStore:store,contentHandler:async()=>{calls++;return{answer:"江戸の大火の台本初稿",model:"test"};}});
 const payload={taskKind:"video-batch-plan",videoId:"V01"},context={jobId:"job-123"};
 const first=await handler(payload,context);
 assert.equal(first.draftPersisted,true);assert.equal(video.stage,"script");assert.equal(video.draftStatus,"needs_source_review");assert.equal(calls,1);
 const recovered=await handler(payload,context);
 assert.equal(recovered.reused,true);assert.equal(recovered.answer,"江戸の大火の台本初稿");assert.equal(calls,1);
});
test("ordinary department.content jobs pass through unchanged",async()=>{
 const payload={request:"通常の動画相談"};let received=null;
 const handler=createVideoBatchContentHandler({videoBatchStore:{get:async()=>null,saveDraft:async()=>null},contentHandler:async(p,c)=>{received={p,c};return{answer:"ok"};}});
 const context={jobId:"ordinary-1"};
 assert.deepEqual(await handler(payload,context),{answer:"ok"});assert.deepEqual(received,{p:payload,c:context});
});

test("retrieves provided source pages before drafting and labels retrieval as unverified",async()=>{
 let received=null,fetchCount=0,video={id:"V02",stage:"research",status:"planned"};
 const store={get:async()=>video,saveDraft:async(id,{script,jobId})=>{video={...video,stage:"script",status:"in_progress",script,draftJobId:jobId};return{created:true,video};}};
 const handler=createVideoBatchContentHandler({videoBatchStore:store,allowedSourceHosts:["www.example.jp"],researchFetchImpl:async url=>{fetchCount++;return{status:200,ok:true,headers:{get:()=>"text/html"},text:async()=>"<title>史料ページ</title><p>取得できた史料ページの本文です。史実の真正性や個別の主張は未検証です。</p>"};},contentHandler:async payload=>{received=payload;return{answer:"出典候補を確認した台本案"};}});
 const result=await handler({taskKind:"video-batch-plan",videoId:"V02",researchSources:["https://www.example.jp/source"]},{jobId:"job-202"});
 assert.equal(fetchCount,1);assert.equal(received.researchContext.sourceSnapshots[0].fetchStatus,"fetched");assert.match(received.researchContext.important,/does not mean|does not/);assert.equal(result.sourceSnapshots[0].verification,"retrieval-only; factual claims remain unverified");
});
test("source URLs outside the configured allowlist are not fetched",async()=>{
 let fetchCount=0,video={id:"V03",stage:"research",status:"planned"};
 const store={get:async()=>video,saveDraft:async(id,{script,jobId})=>{video={...video,stage:"script",status:"in_progress",script,draftJobId:jobId};return{created:true,video};}};
 let received;
 const handler=createVideoBatchContentHandler({videoBatchStore:store,allowedSourceHosts:["www.example.jp"],researchFetchImpl:async()=>{fetchCount++;throw Error("must not fetch");},contentHandler:async payload=>{received=payload;return{answer:"要確認の台本"};}});
 await handler({taskKind:"video-batch-plan",videoId:"V03",researchSources:["https://evil.example/source"]},{jobId:"job-303"});
 assert.equal(fetchCount,0);assert.equal(received.researchContext.sourceSnapshots[0].fetchStatus,"unavailable");
});

test("limits retrieval to ten source pages and reports omitted candidates",async()=>{
 let calls=0,received,video={id:"V04",stage:"research",status:"planned"};
 const store={get:async()=>video,saveDraft:async(id,{script,jobId})=>{video={...video,stage:"script",status:"in_progress",script,draftJobId:jobId};return{created:true,video};}};
 const handler=createVideoBatchContentHandler({videoBatchStore:store,allowedSourceHosts:["www.example.jp"],researchFetchImpl:async url=>{calls++;return{status:200,ok:true,headers:{get:()=>"text/html"},text:async()=>"<title>史料</title><p>十分な長さを持つテスト用の資料本文です。追加の記述も含めて長さを確保しています。</p>"};},contentHandler:async payload=>{received=payload;return{answer:"台本"};}});
 const sources=Array.from({length:12},(_,i)=>"https://www.example.jp/source-"+i);
 await handler({taskKind:"video-batch-plan",videoId:"V04",researchSources:sources},{jobId:"job-404"});
 assert.equal(calls,10);assert.equal(received.researchContext.sourceSnapshots.length,10);assert.equal(received.researchContext.omittedSourceCount,2);
});
