"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {readFinancialSheets,SALES_HEADERS,EXPENSE_HEADERS,parseDate,parseYen}=require("./financial-sheet-reader");
const sales=[SALES_HEADERS,["S-1","2026/11/01","P1","岡山現場","得意先A","工事","1,000,000","100,000","1,100,000","I-1","",""]];
const expenses=[EXPENSE_HEADERS,["E-1","2026/11/02","P1","岡山現場","工事原価","外注費","業者A","400,000","40,000","440,000","振込","","",""]];
test("reads only exact approved financial headers and aggregates tax-exclusive yen",()=>{
 const result=readFinancialSheets({salesRows:sales,expenseRows:expenses});
 assert.equal(result.revenueYen,1000000);assert.equal(result.expenseYen,400000);assert.equal(result.profitYen,600000);
 assert.equal(result.profitMargin,60);assert.equal(result.byProject[0].name,"岡山現場");
 assert.deepEqual(result.sourceSheets,["売上","経費"]);
});
test("fails closed on unknown headers, invalid amounts, and malformed dates",()=>{
 assert.throws(()=>readFinancialSheets({salesRows:[["売上ID","別の日付"]],expenseRows:expenses}),/見出し/);
 const bad=[SALES_HEADERS,["S-2","2026/02/30","P1","現場","","","100","","","","",""]];
 assert.throws(()=>readFinancialSheets({salesRows:bad,expenseRows:expenses}),/不正データ/);
 const badAmount=[...sales.slice(0,1),["S-2","2026/11/01","P1","現場","","","-100","","","","",""]];
 assert.throws(()=>readFinancialSheets({salesRows:badAmount,expenseRows:expenses}),/不正データ/);
});
test("does not expose customers, payees, invoice ids, receipts or notes",()=>{
 const result=readFinancialSheets({salesRows:sales,expenseRows:expenses});
 const serialized=JSON.stringify(result);
 for(const privateValue of ["得意先A","業者A","I-1","領収書URL"]) assert.equal(serialized.includes(privateValue),false);
});
test("validates Japanese date and yen formats",()=>{
 assert.equal(parseDate("2026/9/3"),"2026-09-03");assert.equal(parseDate("2026-02-30"),null);
 assert.equal(parseYen("￥1,234"),1234);assert.equal(parseYen("-1"),null);assert.equal(parseYen("1.5"),null);
});
