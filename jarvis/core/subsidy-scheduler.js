"use strict";
const {tokyoClock}=require("./video-scheduler");
function startDailySubsidyMonitor({store,now=()=>new Date(),intervalMs=60000,hour=8,minute=30}={}) {
 if(!store||typeof store.create!=="function")throw new Error("A persistent job store is required");
 if(!Number.isInteger(intervalMs)||intervalMs<10000||intervalMs>3600000||!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)throw new Error("Invalid subsidy monitor schedule");
 let lastAttemptedDate="",running=false;
 async function tick(){
  if(running)return {queued:false,reason:"already-running"};
  running=true;
  try{
   const clock=tokyoClock(now()),date=clock.year+"-"+clock.month+"-"+clock.day;
   if(Number(clock.hour)<hour||(Number(clock.hour)===hour&&Number(clock.minute)<minute)||lastAttemptedDate===date)return {queued:false,reason:"not-due"};
   const request=[
    "ONE OFFICEの毎日の補助金・助成金公式情報監視タスクです。",
    "国、岡山県、岡山市、倉敷市、徳島県、吉野川市の公式情報源を確認し、株式会社Oneに関連する建設・土木・電気工事、蓄電池・太陽光・省エネ・GX、重機・車両・ICT・省力化、産廃・再資源化、人材採用・資格・賃上げ・安全、AI/DXの支援制度を抽出してください。",
    "取得した各ページが公式サイトの入口ページにすぎない場合は、個別公募要領・対象条件・補助率・上限・受付期間が未確認と明記してください。HTTP取得失敗は募集終了を意味しません。推測や架空のURL・金額・締切を禁止します。",
    "新規・変更・締切接近を優先し、制度名、実施主体、地域、対象要件、対象経費、補助率、上限額、開始・締切、必要書類、公式URL、確認日時、変更点、適合度と不足情報を報告してください。",
    "申請書の下書きとチェックリストまで。申請提出、誓約、外部送信、契約、支払は絶対に実行せず代表者承認待ちにしてください。"
   ].join("\n");
   const result=await store.create({type:"department.office",payload:{request,departmentId:"office",scheduledDate:date},idempotencyKey:"office-daily-subsidy-"+date});
   lastAttemptedDate=date;
   return {queued:Boolean(result.created),date,job:result.job||null,duplicate:!result.created};
  }finally{running=false;}
 }
 const timer=setInterval(()=>{tick().catch(()=>{});},intervalMs);timer.unref?.();tick().catch(()=>{});
 return {tick,stop(){clearInterval(timer);}};
}
module.exports={startDailySubsidyMonitor};
