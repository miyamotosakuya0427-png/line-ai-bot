"use strict";
const { fetchOfficialSource } = require("./video-source-fetcher");

function createVideoBatchContentHandler({contentHandler,videoBatchStore,sourceFetcher=fetchOfficialSource,allowedSourceHosts=[]}={}){
 if(typeof contentHandler!=="function"||!videoBatchStore||typeof videoBatchStore.get!=="function"||typeof videoBatchStore.saveDraft!=="function"||typeof videoBatchStore.saveSourceReview!=="function"||typeof sourceFetcher!=="function")throw new Error("A content handler, source fetcher, and video batch store are required");
 return async function handleVideoBatchContent(payload,context={}){
  if(payload?.taskKind==="video-batch-source-review"){
   if(typeof payload.videoId!=="string"||!/^V[0-9]{2,8}$/.test(payload.videoId)||typeof context.jobId!=="string"||!context.jobId)throw new Error("Invalid source-review task");
   const existing=await videoBatchStore.get(payload.videoId);
   if(!existing||!existing.script||existing.stage!=="script")throw new Error("A saved script at the script stage is required");
   if(existing.sourceReview?.jobId===context.jobId)return {answer:existing.sourceReview.answer,videoId:payload.videoId,reused:true,sourceReviewSaved:true,verified:false,sourceCount:existing.sourceReview.sourceSnapshots?.length||0};
   const sourceSnapshots=[];
   const candidates=[...new Set((existing.sources||[]).filter(x=>typeof x==="string"&&/^https:\/\//i.test(x)).slice(0,10))];
   for(const sourceUrl of candidates){
    try{
     const snapshot=await sourceFetcher(sourceUrl,{allowedHosts:allowedSourceHosts});
     sourceSnapshots.push({...snapshot,text:String(snapshot.text||"").slice(0,40000),error:""});
    }catch(error){
     sourceSnapshots.push({requestedUrl:sourceUrl,finalUrl:"",fetchedAt:new Date().toISOString(),httpStatus:0,title:"",contentSha256:"",text:"",error:String(error?.message||"Source fetch failed").slice(0,500),verification:"source_fetch_failed"});
    }
   }
   const sourceContext=sourceSnapshots.map((s,i)=>[
    "資料"+(i+1),
    "URL："+(s.finalUrl||s.requestedUrl),
    "タイトル："+(s.title||"取得不可"),
    "取得日時："+(s.fetchedAt||"不明"),
    "SHA256："+(s.contentSha256||"なし"),
    "取得状態："+(s.error?"取得失敗："+s.error:"HTML本文取得済み・主張の真偽は未検証"),
    "本文抜粋：\n"+(s.text||"本文なし")
   ].join("\n")).join("\n\n");
   const enrichedPayload={...payload,request:[
    String(payload.request||""),
    "以下は登録済みURLから取得した資料本文です。取得しただけで主張の正しさを保証しません。",
    sourceSnapshots.length?"取得資料：\n"+sourceContext:"登録済みの取得可能なHTTPS出典URLはありません。資料取得済みと表現しないでください。",
    "各主張について資料本文に直接記載があるか、引用箇所を原文どおり抜き出せるか、資料と主張の対象・時代・定義が一致するかを評価してください。",
    "本文にない情報を引用・補完してはいけません。引用は資料本文の完全一致箇所のみ。判断できない主張は未検証のままにしてください。"
   ].join("\n\n")};
   const result=await contentHandler(enrichedPayload,context);
   if(!result||typeof result.answer!=="string"||!result.answer.trim())throw new Error("ONE CONTENT did not return a source-review checklist");
   const saved=await videoBatchStore.saveSourceReview(payload.videoId,{answer:result.answer,jobId:context.jobId,sourceSnapshots});
   if(!saved||!saved.video)throw new Error("Source-review checklist could not be saved");
   return {...result,videoId:payload.videoId,sourceReviewSaved:true,verified:false,sourceCount:sourceSnapshots.filter(s=>!s.error).length,sourceFetchFailures:sourceSnapshots.filter(s=>s.error).length};
  }
  if(payload?.taskKind!=="video-batch-plan")return contentHandler(payload,context);
  if(typeof payload.videoId!=="string"||!/^V[0-9]{2,8}$/.test(payload.videoId))throw new Error("Invalid video batch task ID");
  if(typeof context.jobId!=="string"||!context.jobId)throw new Error("A durable job ID is required for video draft persistence");
  const existing=await videoBatchStore.get(payload.videoId);
  if(!existing)throw new Error("Video batch item not found");
  if(existing.draftJobId===context.jobId&&typeof existing.script==="string"&&existing.script.trim())return {answer:existing.script,videoId:payload.videoId,draftPersisted:true,reused:true};
  const result=await contentHandler(payload,context);
  if(!result||typeof result.answer!=="string"||!result.answer.trim())throw new Error("ONE CONTENT did not return a usable script draft");
  const saved=await videoBatchStore.saveDraft(payload.videoId,{script:result.answer,jobId:context.jobId});
  if(!saved||!saved.video)throw new Error("ONE CONTENT draft could not be saved to the video queue");
  return {...result,videoId:payload.videoId,draftPersisted:true};
 };
}
module.exports={createVideoBatchContentHandler};
