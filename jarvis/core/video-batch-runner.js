"use strict";
function createVideoBatchContentHandler({contentHandler,videoBatchStore}={}){
 if(typeof contentHandler!=="function"||!videoBatchStore||typeof videoBatchStore.get!=="function"||typeof videoBatchStore.saveDraft!=="function")throw new Error("A content handler and video batch store are required");
 return async function handleVideoBatchContent(payload,context){
  if(payload?.taskKind!=="video-batch-plan")return contentHandler(payload,context);
  if(typeof payload.videoId!=="string"||!/^V[0-9]{2,8}$/.test(payload.videoId))throw new Error("Invalid video batch task ID");
  const existing=await videoBatchStore.get(payload.videoId);
  if(!existing)throw new Error("Video batch item not found");
  if(existing.draft)return {answer:existing.draft.answer,model:existing.draft.model,responseId:existing.draft.responseId,reused:true,draftPersisted:true,videoId:payload.videoId};
  const result=await contentHandler(payload,context);
  if(!result||typeof result.answer!=="string"||!result.answer.trim())throw new Error("ONE CONTENT did not return a usable draft answer");
  const saved=await videoBatchStore.saveDraft(payload.videoId,{answer:result.answer,model:result.model||"",responseId:result.responseId||null});
  if(!saved||!saved.draft)throw new Error("Video draft could not be persisted");
  return {...result,videoId:payload.videoId,draftPersisted:true};
 };
}
module.exports={createVideoBatchContentHandler};
