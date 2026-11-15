"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {startDailyContentPlanner,tokyoClock}=require("./video-scheduler");
test("daily content scheduler uses Tokyo local time and waits until its configured hour",async()=>{
 let date=new Date("2026-11-16T08:44:00+09:00"),calls=[];
 const planner=startDailyContentPlanner({store:{create:async job=>{calls.push(job);return {created:true,job:{id:"x"}};}},now:()=>date,intervalMs:3600000});
 try{const early=await planner.tick();assert.equal(early.queued,false);date=new Date("2026-11-16T08:45:00+09:00");const due=await planner.tick();assert.equal(due.queued,true);assert.equal(calls.length,1);assert.equal(calls[0].type,"department.content");assert.equal(calls[0].idempotencyKey,"content-daily-plan-2026-11-16");assert.match(calls[0].payload.request,/YouTube公開/);const repeat=await planner.tick();assert.equal(repeat.queued,false);assert.equal(calls.length,1);}finally{planner.stop();}
});
test("Tokyo clock handles the Japan time zone independently of UTC",()=>{const value=tokyoClock(new Date("2026-11-16T00:00:00Z"));assert.equal(value.year,"2026");assert.equal(value.month,"11");assert.equal(value.day,"16");assert.equal(value.hour,"09");});
