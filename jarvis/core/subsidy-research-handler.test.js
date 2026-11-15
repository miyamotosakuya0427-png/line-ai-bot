"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {SUBSIDY_SOURCES}=require("./subsidy-monitor");
const {stripHtml,fetchOfficialSourceSnapshots,createSubsidyResearchHandler}=require("./subsidy-research-handler");
test("official subsidy page extraction strips active content and records source verification",async()=>{
 const sources=SUBSIDY_SOURCES.slice(0,2);
 const snapshots=await fetchOfficialSourceSnapshots({sources,now:()=>new Date("2026-11-16T00:00:00Z"),fetchImpl:async url=>({url,status:200,ok:true,headers:{get:()=>"text/html"},text:async()=>"<html><title>公募情報</title><script>alert(1)</script><body>受付期間 11月30日</body></html>"})});
 assert.equal(snapshots.length,2);assert.equal(snapshots[0].status,"verified-page-fetched");assert.match(snapshots[0].excerpt,/受付期間/);assert.doesNotMatch(snapshots[0].excerpt,/alert/);assert.equal(snapshots[0].fetchedAt,"2026-11-16T00:00:00.000Z");
});
test("unavailable official pages are never interpreted as closed programs",async()=>{
 const snapshots=await fetchOfficialSourceSnapshots({sources:SUBSIDY_SOURCES.slice(0,1),fetchImpl:async()=>({ok:false,status:503})});
 assert.equal(snapshots[0].status,"unavailable");assert.equal(snapshots[0].excerpt,"");
});
test("subsidy agent sends official page snapshots to the model and labels unverified criteria",async()=>{
 let modelBody;
 const handler=createSubsidyResearchHandler({apiKey:"test",fetchImpl:async(url,options)=>{modelBody=JSON.parse(options.body);return {ok:true,json:async()=>({output_text:"個別公募要領未確認"})};},researchFetchImpl:async url=>({url,status:200,ok:true,headers:{get:()=>"text/html"},text:async()=>"<title>公式情報</title><p>制度案内</p>"})});
 const result=await handler({request:"最新の補助金と助成金を調べて"});
 assert.match(result.answer,/個別公募要領未確認/);assert.match(modelBody.instructions,/募集状況・締切/);assert.match(modelBody.input,/verified-page-fetched/);
});
test("HTML cleaner decodes entities and removes scripts/styles",()=>{assert.equal(stripHtml("<style>x</style><p>A&amp;B&nbsp;C</p><script>bad</script>"),"A&B C");});
