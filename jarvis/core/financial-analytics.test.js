"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {normalizeFinancialRecords,summarizeFinancialRecords}=require("./financial-analytics");

test("calculates revenue, expenses, profit and margin without mixing projects",()=>{
 const result=summarizeFinancialRecords([
  {kind:"revenue",date:"2026-11-01",project:"岡山現場",category:"工事売上",amountYen:850000},
  {kind:"expense",date:"2026-11-02",project:"岡山現場",category:"外注費",amountYen:400000},
  {kind:"expense",date:"2026-11-03",project:"岡山現場",category:"材料費",amountYen:280000},
  {kind:"revenue",date:"2026-11-04",project:"倉敷現場",category:"工事売上",amountYen:200000}
 ]);
 assert.equal(result.revenueYen,1050000);assert.equal(result.expenseYen,680000);assert.equal(result.profitYen,370000);
 assert.equal(result.profitMargin,35.2);assert.equal(result.byProject.length,2);
 assert.equal(result.byProject.find(x=>x.name==="岡山現場").profitYen,170000);
});

test("rejects invalid dates, negative values, decimals, unknown kinds and oversized collections",()=>{
 for(const row of [
  {kind:"revenue",date:"2026-02-30",amountYen:1},
  {kind:"expense",date:"2026-11-01",amountYen:-1},
  {kind:"expense",date:"2026-11-01",amountYen:1.5},
  {kind:"salary",date:"2026-11-01",amountYen:1}
 ]) assert.throws(()=>normalizeFinancialRecords([row]));
 assert.throws(()=>normalizeFinancialRecords(Array.from({length:1001},()=>({kind:"revenue",date:"2026-11-01",amountYen:1}))));
});

test("excludes unapproved personal and free-text fields from normalized output",()=>{
 const [row]=normalizeFinancialRecords([{kind:"expense",date:"2026-11-01",amountYen:100,project:" 現場A ",category:" 材料費 ",employeeName:"氏名",phone:"090",notes:"private"}]);
 assert.deepEqual(row,{kind:"expense",date:"2026-11-01",project:"現場A",category:"材料費",amountYen:100});
});

test("returns null margin when no revenue exists",()=>{
 const result=summarizeFinancialRecords([{kind:"expense",date:"2026-11-01",amountYen:100}]);
 assert.equal(result.profitMargin,null);assert.equal(result.profitYen,-100);
});
