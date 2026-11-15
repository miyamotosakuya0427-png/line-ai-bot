"use strict";

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
async function fetchOfficialSourceSnapshots({sources=SUBSIDY_SOURCES,fetchImpl=fetch,now=()=>new Date()}={}) {
 if(!Array.isArray(sources)||sources.length>20)throw new Error("Invalid official source list");
 return Promise.all(sources.map(async source=>{
  const fetchedAt=now().toISOString();
  try {
   const original=new URL(source.url);
   if(original.protocol!=="https:")throw new Error("HTTPS source required");
   const response=await fetchImpl(source.url,{headers:{Accept:"text/html,application/xhtml+xml"},redirect:"follow",signal:AbortSignal.timeout(10000)});
   const finalUrl=new URL(response.url||source.url);
   if(finalUrl.protocol!=="https:"||finalUrl.hostname!==original.hostname)throw new Error("Redirect outside approved official host");
   if(!response.ok)throw new Error("Official source returned HTTP "+response.status);
   const type=response.headers?.get?.("content-type")||"";
   if(type&&!/text\/html|application\/xhtml\+xml/i.test(type))throw new Error("Unexpected official source content type");
   const html=(await response.text()).slice(0,500000);
   const title=(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)||[])[1]||"";
   return {id:source.id,name:source.name,url:source.url,scope:source.scope,fetchedAt,status:"verified-page-fetched",httpStatus:response.status,title:stripHtml(title).slice(0,200),excerpt:stripHtml(html).slice(0,6500),note:"公式サイトの入口ページ取得結果。個別公募要領・最新受付状況はリンク先で追加確認が必要"};
  } catch(error) {
   return {id:source.id,name:source.name,url:source.url,scope:source.scope,fetchedAt,status:"unavailable",error:String(error.message||"fetch failed").slice(0,180),excerpt:""};
  }
 }));
}
function createSubsidyResearchHandler({apiKey,model,fetchImpl=fetch,researchFetchImpl=fetch}={}) {
 const summarize=createOpenAIHandler({apiKey,model,fetchImpl,instructions:"あなたはONE OFFICEの補助金・助成金調査担当です。提供された公式サイト取得結果を根拠として、制度名・実施主体・対象地域・対象事業者・対象経費・補助率・上限額・開始日・締切・必要書類・窓口・公式URL・確認日時・変更点・株式会社Oneとの適合度・不足情報を整理してください。入口ページしか取得できていない場合、募集状況・締切・金額・適格性を推測せず「個別公募要領未確認」と明記してください。404や取得失敗を制度終了と解釈しないでください。検索結果や古い記事を最新の公式要件と扱わないでください。申請提出・誓約・外部送信・契約・納税は行いません。"});
 return async payload=>{
  const request=typeof payload?.request==="string"?payload.request:"";
  if(!/補助金|助成金|支援制度|公募|雇用助成/i.test(request))return summarize(payload);
  const sources=await fetchOfficialSourceSnapshots({fetchImpl:researchFetchImpl});
  return summarize({...payload,companyContext:{researchTimestamp:new Date().toISOString(),sources}});
 };
}
module.exports={stripHtml,fetchOfficialSourceSnapshots,createSubsidyResearchHandler};
