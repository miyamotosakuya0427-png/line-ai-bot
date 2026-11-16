"use strict";

const crypto=require("node:crypto");

function stripHtml(value){
 return String(value||"")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi," ")
  .replace(/<[^>]+>/g," ")
  .replace(/&nbsp;|&#160;/gi," ")
  .replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
  .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
  .replace(/\s+/g," ").trim();
}
function normalizeAllowedHosts(value){
 const entries=Array.isArray(value)?value:String(value||"").split(",");
 return [...new Set(entries.map(x=>String(x).trim().toLowerCase()).filter(x=>/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(x)))];
}
async function readBoundedText(response,maxBytes=500000){
 const declared=Number(response.headers?.get?.("content-length")||0);
 if(declared>maxBytes)throw new Error("Source page exceeds 500 KB limit");
 if(response.body&&typeof response.body.getReader==="function"){
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
   while(true){
    const part=await reader.read();if(part.done)break;
    size+=part.value.byteLength;
    if(size>maxBytes){await reader.cancel();throw new Error("Source page exceeds 500 KB limit");}
    chunks.push(part.value);
   }
  }finally{reader.releaseLock?.();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder("utf-8",{fatal:false}).decode(bytes);
 }
 const text=await response.text();
 if(Buffer.byteLength(text,"utf8")>maxBytes)throw new Error("Source page exceeds 500 KB limit");
 return text;
}
async function fetchHistorySourceSnapshots({sources=[],allowedHosts=[],fetchImpl=fetch,now=()=>new Date()}={}){
 if(!Array.isArray(sources)||sources.length>20)throw new Error("Invalid history source list");
 const allowed=new Set(normalizeAllowedHosts(allowedHosts));
 return Promise.all(sources.map(async(raw,index)=>{
  const fetchedAt=now().toISOString();
  let url;
  try{
   url=new URL(typeof raw==="string"?raw:raw?.url);
   if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443"||!allowed.has(url.hostname.toLowerCase()))throw new Error("Source host is not in the HTTPS allowlist");
   url.hash="";
   const response=await fetchImpl(url.toString(),{method:"GET",headers:{Accept:"text/html,application/xhtml+xml"},redirect:"manual",signal:AbortSignal.timeout(10000)});
   if(response.status>=300&&response.status<400)throw new Error("Redirects are not followed for source safety");
   if(!response.ok)throw new Error("Source returned HTTP "+response.status);
   const type=response.headers?.get?.("content-type")||"";
   if(!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type))throw new Error("Only HTML source pages are supported");
   const html=await response.text();
   if(Buffer.byteLength(html,"utf8")>500000)throw new Error("Source page exceeds 500 KB limit");
   const title=stripHtml((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)||[])[1]||"").slice(0,200);
   const text=stripHtml(html);
   if(text.length<40)throw new Error("Source page contains too little readable text");
   const excerpt=text.slice(0,1200);
   const contentHash=crypto.createHash("sha256").update(text).digest("hex");
   return {id:"history-source-"+(index+1),url:url.toString(),host:url.hostname,title,fetchStatus:"fetched",httpStatus:response.status,contentType:type.slice(0,100),fetchedAt,characterCount:text.length,contentHash,excerpt,verification:"retrieval-only; factual claims remain unverified"};
  }catch(error){
   return {id:"history-source-"+(index+1),url:typeof raw==="string"?raw:raw?.url||"",fetchStatus:"unavailable",fetchedAt,error:String(error.message||"source fetch failed").slice(0,180),verification:"unverified"};
  }
 }));
}
module.exports={stripHtml,normalizeAllowedHosts,readBoundedText,fetchHistorySourceSnapshots};
