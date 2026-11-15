"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {buildDailyReportAnalytics}=require("./company-analytics");
test("aggregates daily reports by site, equipment, workers and estimated person-hours",()=>{
 const result=buildDailyReportAnalytics([
  {workDate:"2026-11-15",siteName:"岡山現場",workerCount:3,startTime:"08:00",endTime:"17:00",breakMinutes:60,equipment:"バックホウ、ダンプ"},
  {workDate:"2026-11-15",siteName:"岡山現場",workerCount:2,startTime:"08:30",endTime:"16:30",breakMinutes:60,equipment:"ダンプ"},
  {workDate:"2026-11-14",siteName:"倉敷現場",workerCount:1,startTime:"08:00",endTime:"17:00",breakMinutes:60,equipment:"バックホウ"}
 ]);
 assert.equal(result.reportCount,3);assert.equal(result.siteCount,2);assert.equal(result.workerDays,6);assert.equal(result.estimatedPersonHours,46);
 assert.deepEqual(result.topSites[0],{name:"岡山現場",count:2});assert.deepEqual(result.topEquipment[0],{name:"ダンプ",count:2});
});
test("ignores malformed times and bounds output to top ten",()=>{
 const reports=Array.from({length:12},(_,i)=>({workDate:"2026-11-15",siteName:"現場"+i,workerCount:1,startTime:"bad",endTime:"17:00",breakMinutes:0,equipment:""}));
 const result=buildDailyReportAnalytics(reports);assert.equal(result.estimatedPersonHours,0);assert.equal(result.topSites.length,10);assert.ok(result.dataScope.includes("99件"));
});
test("rejects non-array input",()=>assert.throws(()=>buildDailyReportAnalytics(null),/array/));
