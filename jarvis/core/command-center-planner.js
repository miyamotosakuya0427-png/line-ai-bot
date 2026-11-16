"use strict";

const {DEPARTMENTS}=require("./department-agents");
const {ACTIONS}=require("./command-center");

const IDS=new Set(DEPARTMENTS.map(x=>x.id));
const PLANNING_INSTRUCTIONS=[
 "あなたは株式会社OneのJARVIS司令塔に属する業務ルーティング計画器です。",
 "依頼内容を読み、実行に必要な担当部署だけを1〜6個選択してください。",
 "部署IDは次の許可リストのみ: "+[...IDS].join(", "),
 "actionClassは read, analyze, draft, notify, internal_task, external_submit, financial, contract, publish, delete, permission_change のいずれか。",
 "情報収集・分析・下書き・社内通知は安全な内部作業として分類してください。",
 "申請提出、行政送信、発注、支払い、送金、契約、公開投稿、削除、権限変更などの外部・不可逆操作を依頼された場合は必ず対応する承認必須actionClassを選択してください。",
 "外部操作を実行する計画を作らないでください。承認必須のものは承認待ちにするだけです。",
 "出力はJSONオブジェクト1個だけ。形式: {\"departmentIds\":[...],\"actionClass\":\"analyze\",\"rationale\":\"短い理由\"}",
 "不明な場合はjarvisを選び、actionClassをanalyzeにしてください。"
].join("\n");

function extractText(data){
 if(typeof data?.output_text==="string")return data.output_text.trim();
 if(Array.isArray(data?.output))return data.output.flatMap(item=>Array.isArray(item.content)?item.content:[]).filter(x=>x.type==="output_text"&&typeof x.text==="string").map(x=>x.text).join("\n").trim();
 return "";
}
function validatePlan(value){
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Planner returned an invalid plan");
 if(!Array.isArray(value.departmentIds)||value.departmentIds.length<1||value.departmentIds.length>6)throw new Error("Planner selected an invalid number of departments");
 const ids=[...new Set(value.departmentIds)];
 if(ids.length!==value.departmentIds.length||ids.some(id=>!IDS.has(id)))throw new Error("Planner selected an unknown or duplicate department");
 if(!ACTIONS.has(value.actionClass))throw new Error("Planner selected an unsupported action class");
 if(typeof value.rationale!=="string"||!value.rationale.trim()||value.rationale.length>500)throw new Error("Planner rationale is invalid");
 return {departmentIds:ids,actionClass:value.actionClass,rationale:value.rationale.trim()};
}
function createCommandPlanner({apiKey=process.env.OPENAI_API_KEY||"",model=process.env.JARVIS_OPENAI_MODEL||"gpt-5.6-luna",fetchImpl=fetch}={}){
 return {
  enabled:Boolean(apiKey),
  async plan({request}={}){
   if(!apiKey)throw new Error("JARVIS command planner is not configured");
   if(typeof request!=="string"||!request.trim()||request.length>4000)throw new Error("Planner request must be 1-4000 characters");
   const response=await fetchImpl("https://api.openai.com/v1/responses",{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+apiKey},
    body:JSON.stringify({model,instructions:PLANNING_INSTRUCTIONS,input:request.trim(),max_output_tokens:500}),
    signal:AbortSignal.timeout(30000)
   });
   if(!response.ok){const error=new Error("Command planner request failed with status "+response.status);error.retryable=response.status===429||response.status>=500;throw error;}
   const data=await response.json(),text=extractText(data);
   if(!text)throw new Error("Command planner returned an empty response");
   let parsed;try{parsed=JSON.parse(text);}catch{throw new Error("Command planner response was not valid JSON");}
   return {...validatePlan(parsed),model,responseId:typeof data.id==="string"?data.id:null};
  }
 };
}
module.exports={PLANNING_INSTRUCTIONS,extractText,validatePlan,createCommandPlanner};
