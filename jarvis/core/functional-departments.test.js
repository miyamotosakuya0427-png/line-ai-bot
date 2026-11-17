"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {DEPARTMENTS,BASE_PERMISSIONS,getFunctionalDepartment,listFunctionalDepartments}=require("./functional-departments");

const EXPECTED=["management","finance-accounting","sales","construction","estimating","hr-labor","legal-contracts","procurement","safety","quality","marketing","video","sns","data-analysis","system-development","audit-security"];
test("functional registry defines all 16 requested business departments exactly once",()=>{
  assert.equal(DEPARTMENTS.length,16);
  assert.deepEqual(DEPARTMENTS.map(x=>x.id),EXPECTED);
  assert.equal(new Set(DEPARTMENTS.map(x=>x.id)).size,16);
});
test("every department has an auditable contract and bounded permissions",()=>{
  for(const d of DEPARTMENTS){
    assert.ok(d.name&&d.mission);
    for(const key of ["inputs","outputs","tools","audit","legacyAgentIds"])assert.ok(Array.isArray(d[key])&&d[key].length>0,d.id+" missing "+key);
    assert.equal(d.permissions.read,true);
    assert.equal(d.permissions.analyze,true);
    assert.equal(d.permissions.draft,true);
    assert.equal(d.permissions.internalTask,true);
    for(const key of ["externalSubmit","financialCommit","publish","delete","permissionChange"])assert.equal(d.permissions[key],false,d.id+" must not autonomously "+key);
    assert.equal(d.permissions.approvalRequiredForExternalEffects,true);
  }
});
test("legacy agent mapping preserves compatibility and unknown roles fail closed",()=>{
  const valid=new Set(["jarvis","management","tax","office","construction","hr","procurement","recycling","safety","content","affiliate","invest","trader"]);
  for(const d of DEPARTMENTS)for(const id of d.legacyAgentIds)assert.ok(valid.has(id),d.id+" references unknown legacy agent "+id);
  assert.equal(getFunctionalDepartment("sales").id,"sales");
  assert.equal(getFunctionalDepartment("unknown"),null);
  assert.equal(listFunctionalDepartments(),DEPARTMENTS);
});
