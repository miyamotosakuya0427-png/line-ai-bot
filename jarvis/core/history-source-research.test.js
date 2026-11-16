"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {stripHtml,normalizeAllowedHosts,fetchHistorySourceSnapshots}=require("./history-source-research");
test("retrieves only allowlisted HTTPS HTML and stores a bounded, hashed snapshot",async()=>{
 let requested="";
 const snapshots=await fetchHistorySourceSnapshots({sources:["https://www.example.jp/history"],allowedHosts:["www.example.jp"],now:()=>new Date("2026-11-16T00:00:00.000Z"),fetchImpl:async(url,options)=>{requested=url;assert.equal(options.redirect,"manual");return{status:200,ok:true,headers:{get:()=>"text/html; charset=utf-8"},text:async()=>"<html><title>史料ページ</title><script>secret()</script><p>これは公開史料に関する十分な長さの説明本文です。江戸時代の記録がここに詳しく記載されています。</p></html>"};}});
 assert.equal(requested,"https://www.example.jp/history");
 assert.equal(snapshots[0].fetchStatus,"fetched");
 assert.equal(snapshots[0].title,"史料ページ");
 assert.doesNotMatch(snapshots[0].excerpt,/secret/);
 assert.match(snapshots[0].contentHash,/^[a-f0-9]{64}$/);
 assert.match(snapshots[0].verification,/retrieval-only/);
});
test("rejects non-HTTPS, unlisted hosts and redirects without making a request",async()=>{
 let calls=0;
 const snapshots=await fetchHistorySourceSnapshots({sources:["http://www.example.jp/","https://evil.example/"],allowedHosts:["www.example.jp"],fetchImpl:async()=>{calls++;throw Error("must not fetch");}});
 assert.equal(calls,0);assert.ok(snapshots.every(x=>x.fetchStatus==="unavailable"));
});
test("redirects, non-HTML and failed HTTP responses remain unavailable",async()=>{
 const cases=[{status:302,ok:false,type:"text/html"},{status:200,ok:true,type:"application/pdf"},{status:503,ok:false,type:"text/html"}];
 for(const item of cases){const [snapshot]=await fetchHistorySourceSnapshots({sources:["https://www.example.jp/"],allowedHosts:["www.example.jp"],fetchImpl:async()=>({status:item.status,ok:item.ok,headers:{get:() => item.type},text:async()=>"<title>source</title><p>long enough source text for this test</p>"})});assert.equal(snapshot.fetchStatus,"unavailable");}
});
test("normalizes host allowlists and strips active HTML",()=>{assert.deepEqual(normalizeAllowedHosts("www.example.jp, bad host,ndl.go.jp"),["www.example.jp","ndl.go.jp"]);assert.equal(stripHtml("<script>x</script><p>A&amp;B</p>"),"A&B");});
