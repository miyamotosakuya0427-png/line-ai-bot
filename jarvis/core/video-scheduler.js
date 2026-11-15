"use strict";

function tokyoClock(date) {
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
 return Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
}
function startDailyContentPlanner({store,now=()=>new Date(),intervalMs=60000,hour=8,minute=45}={}) {
 if(!store||typeof store.create!=="function")throw new Error("A persistent job store is required");
 if(!Number.isInteger(intervalMs)||intervalMs<10000||intervalMs>3600000||!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)throw new Error("Invalid content planner schedule");
 let lastAttemptedDate="";
 let running=false;
 async function tick() {
  if(running)return {queued:false,reason:"already-running"};
  running=true;
  try {
   const clock=tokyoClock(now()),date=clock.year+"-"+clock.month+"-"+clock.day;
   if(Number(clock.hour)<hour||(Number(clock.hour)===hour&&Number(clock.minute)<minute)||lastAttemptedDate===date)return {queued:false,reason:"not-due"};
   lastAttemptedDate=date;
   const request=[
    "ONE CONTENTの毎日動画企画タスクです。",
    "チャンネル：時をかける日本史（https://www.youtube.com/@samurai-b6i）。日本語8〜12分の歴史解説動画を1本分企画してください。",
    "過去の企画と重複しにくいテーマ案を3つ比較し、最適な1つを選び、視聴者像・冒頭フック・構成・台本アウトライン・必要な史料/公的資料の調査リスト・難読漢字読み確認リスト・映像素材案・字幕方針・仮タイトル/説明文を作成してください。",
    "この実行環境ではWeb検索・史料閲覧が保証されていません。根拠を直接確認できない歴史的事実を検証済みと表示しないこと。出典URLを捏造しないこと。未確認事項を明記し、根拠が必要な記述は調査待ちにすること。",
    "このタスクは企画・下書きだけです。音声/動画の有料生成、購入、外部アップロード、YouTube公開、予約投稿は実行しないでください。代表者の承認待ちとして止めてください。"
   ].join("\n");
   const result=await store.create({type:"department.content",payload:{request,departmentId:"content",scheduledDate:date},idempotencyKey:"content-daily-plan-"+date});
   return {queued:Boolean(result.created),date,job:result.job||null,duplicate:!result.created};
  } finally {running=false;}
 }
 const timer=setInterval(()=>{tick().catch(()=>{});},intervalMs);timer.unref?.();
 tick().catch(()=>{});
 return {tick,stop(){clearInterval(timer);}};
}
module.exports={tokyoClock,startDailyContentPlanner};
