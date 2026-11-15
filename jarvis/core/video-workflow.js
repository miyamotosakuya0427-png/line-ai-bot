"use strict";

const VIDEO_SERIES=Object.freeze({
  id:"tokiwokakeru-nihonshi",
  name:"時をかける日本史",
  channelUrl:"https://www.youtube.com/@samurai-b6i",
  language:"ja",
  defaultFormat:"illustrated-history-voiceover",
  targetDurationMinutes:10,
  acceptableDurationMinutes:{min:8,max:12},
  defaultNarration:"Hinata (Japanese male, calm; previously selected)",
  reviewLimit:2,
  publicationMode:"owner-publishes-after-approval",
  noPaidGenerationWithoutCurrentApproval:true
});

const EXISTING_PROJECTS=Object.freeze([
 {id:"072f8671-af62-480c-8072-bb253faf58b7",title:"江戸大名、借金まみれの真実",compositionId:"cd7b6796-23cc-43a7-ae7c-c2e3cfb50d32",durationSeconds:74,media:{images:5,audio:"HeyGen音声_Kenichi_江戸大名借金.wav",audioDurationSeconds:33.276961},publishCount:0,transcriptSpeakerLabel:"Hayama",verification:"Descript project inspected; existing audio filename says Kenichi and transcript speaker label says Hayama, while selected default voice preference is Hinata; do not overwrite without review",historicalReview:{status:"primary-source-verified",sourceUrl:"https://www.bunka.pref.mie.lg.jp/rekishi/kenshi/asp/hakken/detail228.html",verifiedClaims:["安永5〜6年（1776〜1777年）の亀山藩予算書","歳入約1万6,900両","支出約4万5,700両","赤字約3万300両"],note:"三重県県史編さんグループの公開資料とナレーション原稿の主要数値が一致"}},
 {id:"5b28e058-e58b-41a7-9a26-0164aaea9ca6",title:"時をかける日本史｜江戸の大火",compositionId:"8a30994f-210a-4dd7-aa85-31904ea6368b",durationSeconds:24,media:{images:5,audio:"江戸の大火_ナレーション_Kenichi_読み修正版.wav",audioDurationSeconds:32.827528,previousAudioDurationSeconds:32.309569},readCheckProject:{id:"6c1431bd-671b-41f9-b781-e5ad1cde851b",title:"江戸の大火｜ナレーション読み確認",durationSeconds:32.309569},publishCount:0,verification:"Separate Descript project; 24-second scene-material composition and separate 32.3-second read-check audio project; not the Edo-daimyo video"}
]);

const STAGES=Object.freeze([
 {id:"research",label:"企画・最新情報調査",owner:"content",mode:"autonomous"},
 {id:"script",label:"台本作成・史実検証",owner:"content",mode:"autonomous"},
 {id:"pronunciation",label:"漢字・固有名詞・音読み訓読み確認",owner:"content",mode:"autonomous"},
 {id:"voice",label:"ナレーション生成・音声確認",owner:"content",mode:"approval-before-paid-generation"},
 {id:"assets",label:"画像・映像・権利確認",owner:"content",mode:"autonomous-using-authorized-assets"},
 {id:"edit",label:"編集・字幕・構成",owner:"content",mode:"autonomous"},
 {id:"qa",label:"映像・音声・字幕・事実の最終検査",owner:"jarvis",mode:"autonomous"},
 {id:"review",label:"代表者レビュー",owner:"jarvis",mode:"owner-approval"},
 {id:"publish",label:"投稿・公開",owner:"content",mode:"owner-approval"},
 {id:"analytics",label:"公開後分析・次回改善",owner:"content",mode:"autonomous-after-owner-reports-published"}
].map(x=>Object.freeze(x)));

const QA_CHECKS=Object.freeze([
 "台本の各歴史的事実に信頼できる根拠と出典がある",
 "年号・人名・地名・官職・金額・単位を照合した",
 "難読漢字と固有名詞の音読み・訓読み・アクセントを確認した",
 "実際のナレーション音声と台本・字幕が一致する",
 "音声が冒頭から末尾まで聞こえ、音量・ノイズ・無音区間に問題がない",
 "字幕の誤字・脱字・表示タイミング・スマホ可読性を確認した",
 "画像・BGM・効果音の利用権限と出典を確認した",
 "映像の黒画面・静止画の長時間放置・音声欠落・書き出し破損がない",
 "タイトル・サムネイル・説明文が内容を誇張していない",
 "公開先・公開設定・予約日時は代表者承認待ちである"
]);

const APPROVAL_GATES=Object.freeze({
 paid_generation:"当該生成の直前に代表者の明示承認が必要。承認なしで生成APIを呼ばない",
 purchase_or_subscription:"代表者の明示承認が必要",
 external_upload_or_publish:"代表者の明示承認が必要。承認前は投稿用ファイルと文案の納品まで",
 schedule_publication:"代表者の明示承認が必要",
 script_and_storyboard:"既定の制作方針の範囲で自動作成。新しい主題・表現変更はレビュー対象",
 factual_claim:"一次資料・公的資料・信頼できる史料を照合し、不確実な記述は断定しない"
});

function createVideoPlan({id,title,topic,format=VIDEO_SERIES.defaultFormat,script="",sources=[]}={}) {
 if(typeof id!=="string"||!/^V\d{2,4}$/.test(id))throw new Error("Invalid video plan id");
 if(typeof title!=="string"||!title.trim()||title.length>160)throw new Error("Invalid video title");
 if(typeof topic!=="string"||!topic.trim()||topic.length>500)throw new Error("Invalid video topic");
 if(typeof script!=="string"||script.length>12000)throw new Error("Invalid video script");
 if(!Array.isArray(sources)||sources.length>30||!sources.every(x=>typeof x==="string"&&x.length<=1000))throw new Error("Invalid source list");
 return {id,title:title.trim(),topic:topic.trim(),format,script,sources:[...sources],status:"planned",currentStage:"research",completedStages:[],qa:{checks:QA_CHECKS.map((label,index)=>({id:index,label,passed:false,notes:""}))},voiceGeneration:{mode:"existing_asset"},approval:{paidGeneration:false,publish:false},createdAt:null,updatedAt:null};
}
function markStageComplete(plan,stageId) {
 if(!plan||!STAGES.some(s=>s.id===stageId))throw new Error("Unknown video plan or stage");
 const index=STAGES.findIndex(s=>s.id===stageId);
 const currentIndex=STAGES.findIndex(s=>s.id===plan.currentStage);
 if(index!==currentIndex)throw new Error("Video stages must be completed in order");
 if(stageId==="voice"&&plan.voiceGeneration?.mode==="paid_generation"&&!plan.approval.paidGeneration)throw new Error("Owner approval required before paid voice/video generation");
 if(stageId==="review"&&plan.qa.checks.some(x=>!x.passed))throw new Error("All quality checks must pass before owner review");
 if(stageId==="publish"&&!plan.approval.publish)throw new Error("Owner approval required before publication");
 const completedStages=[...new Set([...plan.completedStages,stageId])];
 const next=STAGES[index+1];
 return {...plan,completedStages,currentStage:next?next.id:"done",status:stageId==="review"?"awaiting-owner-review":stageId==="publish"?"published":next?"in-progress":"ready-for-owner-approval"};
}
function setVoiceGenerationMode(plan,mode) {
 if(!plan||!["existing_asset","free_generation","paid_generation"].includes(mode))throw new Error("Invalid voice generation mode");
 if(mode==="paid_generation"&&!plan.approval.paidGeneration) return {...plan,voiceGeneration:{mode},status:"awaiting-paid-generation-approval"};
 return {...plan,voiceGeneration:{mode}};
}
function setOwnerApproval(plan,kind,approved) {
 if(!plan||!["paidGeneration","publish"].includes(kind)||typeof approved!=="boolean")throw new Error("Invalid approval");
 return {...plan,approval:{...plan.approval,[kind]:approved}};
}
function setQualityCheck(plan,checkId,passed,notes="") {
 if(!plan||!Number.isInteger(checkId)||checkId<0||checkId>=QA_CHECKS.length||typeof passed!=="boolean"||typeof notes!=="string"||notes.length>500)throw new Error("Invalid quality check");
 const checks=plan.qa.checks.map(x=>x.id===checkId?{...x,passed,notes}:x);
 return {...plan,qa:{checks}};
}
function getVideoWorkflow({autoplanEnabled=false}={}) {
 return {series:VIDEO_SERIES,projects:EXISTING_PROJECTS,stages:STAGES,qualityChecks:QA_CHECKS,approvalGates:APPROVAL_GATES,automationStatus:autoplanEnabled?"daily-planner-enabled":"opt-in-not-enabled",autoplanEnabled,publicationEnabled:false,paidGenerationEnabled:false,notes:["Existing production project is not automatically marked complete; inspect the real editor project and media before advancing stages.","Scheduled production requires a connected persistent worker and an approved budget."]};
}
module.exports={VIDEO_SERIES,EXISTING_PROJECTS,STAGES,QA_CHECKS,APPROVAL_GATES,createVideoPlan,markStageComplete,setVoiceGenerationMode,setOwnerApproval,setQualityCheck,getVideoWorkflow};
