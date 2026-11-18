"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const {commandCenterDashboardPage}=require("./command-center-dashboard");

test("command center dashboard renders responsive network and operational panels",()=>{
 const html=commandCenterDashboardPage();
 for(const marker of ["AGENT NETWORK","AGENT INSPECTOR","TASK STREAM","ALERTS","NEW TASK","PLATFORM HEALTH","DEVELOPMENT AGENTS","@media(max-width:520px)","/v1/command-center","/v1/departments","/v1/status","/v1/tasks?limit=50","/v1/approvals","/v1/content/workflow","15秒","未接続"]){
  assert.ok(html.includes(marker),"missing dashboard marker: "+marker);
 }
 const match=/<script>([\s\S]*?)<\/script>/.exec(html);
 assert.ok(match,"dashboard script must exist");
 assert.doesNotThrow(()=>new vm.Script(match[1]));
});

test("command center dashboard does not persist credentials or invent external social metrics",()=>{
 const html=commandCenterDashboardPage();
 assert.doesNotMatch(html,/localStorage|sessionStorage|document\.cookie/);
 assert.match(html,/APIトークン（メモリ内だけ）/);
 assert.match(html,/未接続/);
 assert.match(html,/SNS実績は未接続です/);
 assert.match(html,/textContent/);
});

test("command center dashboard uses authenticated API calls and bounded request text",()=>{
 const html=commandCenterDashboardPage();
 assert.match(html,/Authorization:"Bearer "\+apiToken/);
 assert.match(html,/maxlength="4000"/);
 assert.match(html,/command-center\/plan/);
 assert.match(html,/clearInterval/);
});
