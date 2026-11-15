"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const {dashboardPage}=require("./dashboard");

test("dashboard approval controls render and embedded JavaScript parses",()=>{
 const html=dashboardPage();
 assert.match(html,/id="approvals-panel"/);
 assert.match(html,/id="approval-form"/);
 assert.match(html,/外部処理は実行されません/);
 assert.match(html,/AIに企画・台本下書きを依頼/);
 assert.match(html,/\/v1\/content\/videos\//);
 const match=/<script>([\s\S]*?)<\/script>/.exec(html);
 assert.ok(match,"dashboard script must exist");
 assert.doesNotThrow(()=>new vm.Script(match[1]));
});
