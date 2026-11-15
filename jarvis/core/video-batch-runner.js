"use strict";
function createVideoBatchContentHandler({contentHandler,videoBatchStore}={}){
 if(typeof contentHandler!=="function"||!videoBatchStore||typeof videoBatchStore.get!=="function"||typeof videoBatchStore.saveDraft!=="function")throw new Error("A content handler and video batch store are required");
 return async function handleVideoBatchContent(payload,context={}){
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
