"use strict";
const crypto=require("node:crypto");

const {SUBSIDY_SOURCES}=require("./subsidy-monitor");
const {createOpenAIHandler}=require("./openai-handler");

function stripHtml(value) {
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
function extractRelatedLinks(html,baseUrl) {
 const base=new URL(baseUrl),links=[];
 const anchors=String(html||"").match(/<a\b[^>]*>[\s\S]*?<\/a>/gi)||[];
 for(const anchor of anchors) {
  const href=(/\bhref\s*=\s*["']([^"']+)["']/i.exec(anchor)||[])[1];
  const label=stripHtml(anchor.replace(/<a\b[^>]*>/i,"").replace(/<\/a>/i,""));
  if(!href||!label||!/補助|助成|公募|募集|支援|要綱|要領|申請|制度|事業/.test(label))continue;
  try {
   const url=new URL(href,base);
   if(url.protocol!=="https:"||url.hostname!==base.hostname||url.pathname===base.pathname)continue;
   url.hash="";
   if(!links.some(item=>item.url===url.toString()))links.push({title:label.slice(0,120),url:url.toString()});
  } catch {}
 }
 return links.slice(0,1);
}
async function fetchOfficialPage(url,host,fetchImpl) {
 const response=await fetchImpl(url,{headers:{Accept:"text/html,application/xhtml+xml"},redirect:"follow",signal:AbortSignal.timeout(10000)});
 const finalUrl=new URL(response.url||url);
 if(finalUrl.protocol!=="https:"||finalUrl.hostname!==host)throw new Error("Redirect outside approved official host");
 if(!response.ok)throw new Error("Official source returned HTTP "+response.status);
 const type=response.headers?.get?.("content-type")||"";
 if(type&&!/text\/html|application\/xhtml\+xml/i.test(type))throw new Error("Unexpected official source content type");
 const html=(await response.text()).slice(0,500000);
 const title=(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)||[])[1]||"";
 return {html,title:stripHtml(title).slice(0,200),excerpt:stripHtml(html).slice(0,500),httpStatus:response.status};
}
async function fetchOfficialSourceSnapshots({sources=SUBSIDY_SOURCES,fetchImpl=fetch,now=()=>new Date()}={}) {
 if(!Array.isArray(sources)||sources.length>20)throw new Error("Invalid official source list");
 return Promise.all(sources.map(async source=>{
  const fetchedAt=now().toISOString();
  try {
   const original=new URL(source.url);
   if(original.protocol!=="https:")throw new Error("HTTPS source required");
   const main=await fetchOfficialPage(source.url,original.hostname,fetchImpl);
   const related=[];
   const link=extractRelatedLinks(main.html,source.url)[0];
   if(link) {
    try {
     const detail=await fetchOfficialPage(link.url,original.hostname,fetchImpl);
     related.push({title:link.title,url:link.url,status:"verified-page-fetched",pageTitle:detail.title,excerpt:detail.excerpt});
    } catch(error) {
     related.push({title:link.title,url:link.url,status:"unavailable",error:String(error.message||"fetch failed").slice(0,160)});
    }
   }
   return {id:source.id,name:source.name,url:source.url,scope:source.scope,fetchedAt,status:"verified-page-fetched",httpStatus:main.httpStatus,title:main.title,excerpt:main.excerpt,relatedPages:related,note:"公式ページを取得。個別公募要領の記載が確認できない項目は未確認とする"};
  } catch(error) {
   return {id:source.id,name:source.name,url:source.url,scope:source.scope,fetchedAt,status:"unavailable",error:String(error.message||"fetch failed").slice(0,180),excerpt:"",relatedPages:[]};
  }
 }));
}
function createSubsidyResearchHandler({apiKey,model,fetchImpl=fetch,researchFetchImpl=fetch,store=null}={}) {
 const summarize=createOpenAIHandler({apiKey,model,fetchImpl,instructions:"あなたはONE OFFICEの補助金・助成金調査担当です。提供された公式サイト取得結果を根拠として、制度名・実施主体・対象地域・対象事業者・対象経費・補助率・上限額・開始日・締切・必要書類・窓口・公式URL・確認日時・変更点・株式会社Oneとの適合度・不足情報を整理してください。個別公募要領や詳細ページを取得できていない場合、募集状況・締切・金額・適格性を推測せず「個別公募要領未確認」と明記してください。404や取得失敗を制度終了と解釈しないでください。検索結果や古い記事を最新の公式要件と扱わないでください。申請提出・誓約・外部送信・契約・納税は行いません。"});
 return async payload=>{
  const request=typeof payload?.request==="string"?payload.request:"";
  if(!/補助金|助成金|支援制度|公募|雇用助成/i.test(request))return summarize(payload);
  const sources=await fetchOfficialSourceSnapshots({fetchImpl:researchFetchImpl});
  let previous={};
  if(store&&typeof store.list==="function") {
   const jobs=await store.list({status:"succeeded",limit:200});
   const last=jobs.find(job=>job.type==="department.office"&&job.result&&job.result.sourceFingerprints);
   previous=last?.result?.sourceFingerprints||{};
  }
  const sourceFingerprints=Object.fromEntries(sources.filter(x=>x.status==="verified-page-fetched").map(x=>[x.id,crypto.createHash("sha256").update(JSON.stringify({title:x.title,excerpt:x.excerpt,relatedPages:x.relatedPages})).digest("hex")]));
  const changes=sources.map(source=>({id:source.id,status:source.status==="unavailable"?"unverified":!previous[source.id]?"new":previous[source.id]===sourceFingerprints[source.id]?"unchanged":"changed"}));
  const summary=await summarize({...payload,companyContext:{researchTimestamp:new Date().toISOString(),sources,changes}});
  return {...summary,sourceFingerprints,sourceStatuses:sources.map(x=>({id:x.id,status:x.status})),changes};
 };
}
module.exports={stripHtml,extractRelatedLinks,fetchOfficialSourceSnapshots,createSubsidyResearchHandler};
