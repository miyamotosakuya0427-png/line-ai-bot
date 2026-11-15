"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {startDailySubsidyMonitor}=require("./subsidy-scheduler");
test("daily subsidy monitor queues one official research job per Tokyo date",async()=>{
 let date=new Date("2026-11-16T08:29:00+09:00"),calls=[];
 const scheduler=startDailySubsidyMonitor({store:{create:async job=>{calls.push(job);return {created:true,job:{id:"grant"}};}},now:()=>date,intervalMs:3600000});
 try{assert.equal((await scheduler.tick()).queued,false);date=new Date("2026-11-16T08:30:00+09:00");const result=await scheduler.tick();assert.equal(result.queued,true);assert.equal(calls[0].type,"department.office");assert.equal(calls[0].idempotencyKey,"office-daily-subsidy-2026-11-16");assert.match(calls[0].payload.request,/公式情報源/);assert.equal((await scheduler.tick()).queued,false);}finally{scheduler.stop();}
});
