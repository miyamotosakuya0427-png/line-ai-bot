"use strict";
const { fetchOfficialSource } = require("./video-source-fetcher");

function buildSourceReviewRequest(video){
 return [
  "ONE CONTENT 一次資料確認タスクです。ワーカーが登録済みHTTPS出典候補を安全な許可ドメイン制限付きで取得し、その本文抜粋を後続指示に添付します。取得済み資料と主張を照合し、事実を検証済みと誤認してはいけません。",
  "動画ID："+video.id,
  "タイトル："+video.title,
  "テーマ："+video.topic,
  "台本全文：\n"+video.script,
  "登録済み出典候補（取得前）：\n"+JSON.stringify(video.sources||[]),
  "台本から検証が必要な個別主張を漏れなく抽出し、年号・人名・地名・官職・制度・金額・因果関係に分けて整理してください。",
  "各主張について、資料本文に直接記載があるか、引用箇所を原文どおり抜き出せるか、資料と主張の対象・時代・定義が一致するかを評価してください。",
  "出典候補のURLを新規に創作してはいけません。本文にない情報を引用・補完してはいけません。主張ごとに「未検証」「要資料取得」「資料と照合済み」を区別し、実際に資料を読んでいない以上「検証済み」は使用禁止です。",
  "成果物は日本語の確認表と、修正が必要な台本箇所の指摘です。公開・外部送信・有料生成はしません。"
 ].join("\n");
}


function extractPronunciationCandidates(script){
 const text=String(script||"");
 const kanji=[...new Set(text.match(/[一-龯々〆ヵヶ]{2,10}/g)||[])];
 const numerals=[...new Set(text.match(/[0-9０-９一二三四五六七八九十百千万億兆]+(?:年|月|日|人|円|石|万石|丁目|番地|世紀|回|件|％|%)/g)||[])];
 return [...kanji.map(term=>({term,proposedReading:"",kind:"kanji_candidate"})),...numerals.map(term=>({term,proposedReading:"",kind:"number_or_unit_candidate"}))].slice(0,100);
}
function buildPronunciationReviewRequest(video){
 const terms=extractPronunciationCandidates(video.script);
 return ["ONE CONTENT 読み・発音の事前確認タスクです。台本全文から漢字の音読み/訓読み、人名・地名・官職・制度名、数字・年号・単位、読みが複数ある語を洗い出してください。","台本：\\n"+video.script,"機械抽出候補：\\n"+terms.map(t=>t.term+" ["+t.kind+"]").join("\\n"),"各候補について、文脈上の読み候補と根拠・不確実性を示してください。根拠のない読みを断定せず、読みが確定できないものは要確認としてください。音声ファイルを実際に再生・聴取していないので、発音済み・音声確認済みとは表現禁止です。","出力は日本語の表形式で、表記／読み候補／音読み・訓読み等の区分／確認根拠／要確認事項を含めてください。これは読み候補チェックリストであり、人による確認が終わるまで未承認です。"].join("\\n\\n");
}

function createVideoBatchContentHandler({contentHandler,videoBatchStore,jobStore=null,sourceFetcher=fetchOfficialSource,allowedSourceHosts=[]}={}){
 if(typeof contentHandler!=="function"||!videoBatchStore||typeof videoBatchStore.get!=="function"||typeof videoBatchStore.saveDraft!=="function"||typeof videoBatchStore.saveSourceReview!=="function"||typeof sourceFetcher!=="function")throw new Error("A content handler, source fetcher, and video batch store are required");
 async function enqueueSourceReview(video){
  if(!jobStore||typeof jobStore.create!=="function")return null;
  const request=buildSourceReviewRequest(video);
  return jobStore.create({type:"department.content",payload:{request,departmentId:"content",videoId:video.id,taskKind:"video-batch-source-review"},idempotencyKey:"video-batch-source-review-"+video.id});
 }
 return async function enqueuePronunciationReview(video){if(!jobStore||typeof jobStore.create!=="function")return null;return jobStore.create({type:"department.content",payload:{request:buildPronunciationReviewRequest(video),departmentId:"content",videoId:video.id,taskKind:"video-batch-pronunciation-review"},idempotencyKey:"video-batch-pronunciation-review-"+video.id});}
 async function handleVideoBatchContent(payload,context={}){
  if(payload?.taskKind==="video-batch-pronunciation-review"){
   if(typeof payload.videoId!=="string"||!/^V[0-9]{2,8}$/.test(payload.videoId)||typeof context.jobId!=="string"||!context.jobId)throw new Error("Invalid pronunciation-review task");
   const video=await videoBatchStore.get(payload.videoId);if(!video||!video.script||!video.sourceReview)throw new Error("A saved script and source review are required");
   if(video.pronunciationReview?.jobId===context.jobId)return {answer:video.pronunciationReview.answer,videoId:video.id,reused:true,pronunciationReviewSaved:true,verified:false};
   const terms=extractPronunciationCandidates(video.script);const result=await contentHandler({...payload,request:buildPronunciationReviewRequest(video)},context);
   if(!result||typeof result.answer!=="string"||!result.answer.trim())throw new Error("ONE CONTENT did not return a pronunciation checklist");
   const saved=await videoBatchStore.savePronunciationChecklist(video.id,{answer:result.answer,jobId:context.jobId,terms});if(!saved||!saved.video)throw new Error("Pronunciation checklist could not be saved");
   return {...result,videoId:video.id,pronunciationReviewSaved:true,verified:false,candidateCount:terms.length};
  }
  if(payload?.taskKind==="video-batch-source-review"){
   if(typeof payload.videoId!=="string"||!/^V[0-9]{2,8}$/.test(payload.videoId)||typeof context.jobId!=="string"||!context.jobId)throw new Error("Invalid source-review task");
   const existing=await videoBatchStore.get(payload.videoId);
   if(!existing||!existing.script||existing.stage!=="script")throw new Error("A saved script at the script stage is required");
   if(existing.sourceReview?.jobId===context.jobId){await enqueuePronunciationReview(existing);return {answer:existing.sourceReview.answer,videoId:payload.videoId,reused:true,sourceReviewSaved:true,pronunciationReviewEnqueued:Boolean(jobStore),verified:false,sourceCount:existing.sourceReview.sourceSnapshots?.length||0};}
   const sourceSnapshots=[];
   const candidates=[...new Set((existing.sources||[]).filter(x=>typeof x==="string"&&/^https:\/\//i.test(x)).slice(0,2))];
   for(const sourceUrl of candidates){
    try{
     const snapshot=await sourceFetcher(sourceUrl,{allowedHosts:allowedSourceHosts});
     sourceSnapshots.push({...snapshot,text:String(snapshot.text||"").slice(0,1200),error:""});
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
   await enqueuePronunciationReview(saved.video);
   return {...result,videoId:payload.videoId,sourceReviewSaved:true,pronunciationReviewEnqueued:Boolean(jobStore),verified:false,sourceCount:sourceSnapshots.filter(s=>!s.error).length,sourceFetchFailures:sourceSnapshots.filter(s=>s.error).length};
  }
  if(payload?.taskKind!=="video-batch-plan")return contentHandler(payload,context);
  if(typeof payload.videoId!=="string"||!/^V[0-9]{2,8}$/.test(payload.videoId))throw new Error("Invalid video batch task ID");
  if(typeof context.jobId!=="string"||!context.jobId)throw new Error("A durable job ID is required for video draft persistence");
  const existing=await videoBatchStore.get(payload.videoId);
  if(!existing)throw new Error("Video batch item not found");
  if(existing.draftJobId===context.jobId&&typeof existing.script==="string"&&existing.script.trim()){
   await enqueueSourceReview(existing);
   return {answer:existing.script,videoId:payload.videoId,draftPersisted:true,reused:true,sourceReviewEnqueued:Boolean(jobStore)};
  }
  const result=await contentHandler(payload,context);
  if(!result||typeof result.answer!=="string"||!result.answer.trim())throw new Error("ONE CONTENT did not return a usable script draft");
  const saved=await videoBatchStore.saveDraft(payload.videoId,{script:result.answer,jobId:context.jobId});
  if(!saved||!saved.video)throw new Error("ONE CONTENT draft could not be saved to the video queue");
  await enqueueSourceReview(saved.video);
  return {...result,videoId:payload.videoId,draftPersisted:true,sourceReviewEnqueued:Boolean(jobStore)};
 };
}
module.exports={buildSourceReviewRequest,buildPronunciationReviewRequest,extractPronunciationCandidates,createVideoBatchContentHandler};
