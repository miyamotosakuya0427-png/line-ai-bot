"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const {dashboardPage}=require("./dashboard");

test("video batch dashboard renders and embedded JavaScript parses",()=>{
 const html=dashboardPage();
 assert.match(html,/id="batch-ideas"/);
 assert.match(html,/id="approval-inbox"/);
 assert.match(html,/id="content-projects"/);
 const match=/<script>([\s\S]*?)<\/script>/.exec(html);
 assert.ok(match,"dashboard script must exist");
 assert.doesNotThrow(()=>new vm.Script(match[1]));
});
