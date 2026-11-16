"use strict";
const {fetchHistorySourceSnapshots,normalizeAllowedHosts}=require("./history-source-research");
function createVideoBatchContentHandler({contentHandler,videoBatchStore,researchFetchImpl=fetch,allowedSourceHosts=process.env.JARVIS_HISTORY_SOURCE_HOSTS||""}={}){
 if(typeof contentHandler!=="function"||!videoBatchStore||typeof videoBatchStore.get!=="function"||typeof videoBatchStore.saveDraft!=="function")throw new Error("A content handler and video batch store are required");
 const allowedHosts=normalizeAllowedHosts(allowedSourceHosts);
 return async function handleVideoBatchContent(payload,context={}){
  if(payload?.taskKind!=="video-batch-plan")return contentHandler(payload,context);
  if(typeof payload.videoId!=="string"||!/^V[0-9]{2,8}$/.test(payload.videoId))throw new Error("Invalid video batch task ID");
  if(typeof context.jobId!=="string"||!context.jobId)throw new Error("A durable job ID is required for video draft persistence");
  const existing=await videoBatchStore.get(payload.videoId);
  if(!existing)throw new Error("Video batch item not found");
  if(existing.draftJobId===context.jobId&&typeof existing.script==="string"&&existing.script.trim())return {answer:existing.script,videoId:payload.videoId,draftPersisted:true,reused:true};
  if(existing.stage!=="research"||existing.status!=="planned")throw new Error("Video is not awaiting its first script draft");
  const sources=Array.isArray(payload.researchSources)?payload.researchSources:[];
  const sourceSnapshots=sources.length?await fetchHistorySourceSnapshots({sources:sources.slice(0,10),allowedHosts,fetchImpl:researchFetchImpl}):[];
  const result=await contentHandler({...payload,researchContext:{retrievalOnly:true,allowedHostsConfigured:allowedHosts.length>0,omittedSourceCount:Math.max(0,sources.length-10),sourceSnapshots,important:"Fetched means only that an HTTPS page was retrieved. It does not mean primary-source authenticity or factual claims were verified."}},context);
  if(!result||typeof result.answer!=="string"||!result.answer.trim())throw new Error("ONE CONTENT did not return a usable script draft");
  const saved=await videoBatchStore.saveDraft(payload.videoId,{script:result.answer,jobId:context.jobId});
  if(!saved||!saved.video)throw new Error("ONE CONTENT draft could not be saved to the video queue");
  return {...result,videoId:payload.videoId,draftPersisted:true,sourceSnapshots};
 };
}
module.exports={createVideoBatchContentHandler};
