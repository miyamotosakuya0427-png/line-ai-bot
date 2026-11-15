"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {SOURCES,WATCH_AREAS,getOfficeIntelligence}=require("./office-intelligence");
test("office intelligence separates tax and administration departments",()=>{
 const data=getOfficeIntelligence({asOfDate:"2026-11-16"});
 assert.equal(data.departments.length,2);
 assert.equal(data.departments[0].name,"税務部");
 assert.equal(data.departments[1].name,"事務部");
 assert.ok(data.departments[0].sources.every(s=>s.department==="税務部"));
 assert.ok(data.departments[1].sources.every(s=>s.department==="事務部"));
 assert.ok(WATCH_AREAS.some(x=>x.includes("建設")));
 assert.ok(WATCH_AREAS.some(x=>x.includes("リサイクル")));
});
test("all configured monitoring sources use official authority domains and HTTPS",()=>{
 for(const source of SOURCES){const u=new URL(source.url);assert.equal(u.protocol,"https:");assert.ok(source.authority);assert.ok(source.name);}
});
test("monitoring rules report no-change snapshots and never submit applications",()=>{
 const data=getOfficeIntelligence({asOfDate:"2026-11-16"});
 assert.equal(data.monitoring.noChangeReport,true);
 assert.equal(data.monitoring.applicationSubmission,false);
 assert.ok(data.monitoring.notifyOn.includes("budget-exhausted"));
 assert.throws(()=>getOfficeIntelligence({asOfDate:"not-a-date"}),/Invalid/);
});
