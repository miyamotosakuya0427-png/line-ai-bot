"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDepartmentContextLoader,SHEETS}=require("./department-context-loader");

const employeeHeaders=["従業員ID","氏名","LINE表示名","職種","役職","単価","電話番号","入社日","登録日","状態","備考"];
const dailyHeaders=["日報ID","記録日時","作業日","従業員ID","氏名","現場名","作業内容","開始時刻","終了時刻","休憩（分）","作業人数","使用機械・車両","使用材料","連絡事項"];

function makeLoader(rowsBySheet){
 const sent=[];
 const loader=createDepartmentContextLoader({
  sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
  sheetsToken:"secret-token-that-must-not-leak",
  clock:()=>new Date("2026-11-16T00:00:00.000Z"),
  fetchImpl:async(url,options)=>{
   assert.equal(url,"https://script.google.com/macros/s/test-id/exec");
   const body=JSON.parse(options.body);sent.push(body);
   assert.equal(body.action,"readRows");
   assert.equal(body.startRow,1);
   assert.equal(body.numRows,100);
   return {ok:true,json:async()=>({ok:true,rows:rowsBySheet[body.sheetName]||[]})};
  }
 });
 return {loader,sent};
}

test("HR context aggregates employee data and excludes direct identifiers",async()=>{
 const rows=[
  employeeHeaders,
  ["EMP001","山田太郎","表示名","土工","作業員","20000","09000000000","2024-01-01","2026-01-01","有効","秘密"],
  ["EMP002","佐藤花子","表示名2","電工","職長","25000","09000000001","2023-01-01","2026-01-01","有効","秘密"]
 ];
 const {loader,sent}=makeLoader({[SHEETS.employees]:rows});
 const result=await loader.load("hr");
 assert.equal(result.status,"available");
 assert.equal(result.employees.data.employeeCount,2);
 assert.deepEqual(result.employees.data.byJob,{土工:1,電工:1});
 assert.equal(JSON.stringify(result).includes("山田太郎"),false);
 assert.equal(JSON.stringify(result).includes("EMP001"),false);
 assert.equal(JSON.stringify(result).includes("09000000000"),false);
 assert.equal(JSON.stringify(result).includes("secret-token"),false);
 assert.equal(sent.length,1);
});

test("construction context returns bounded aggregates without names or notes",async()=>{
 const rows=[
  dailyHeaders,
  ["R1","2026-11-15T18:00:00+09:00","2026-11-15","EMP001","山田太郎","岡山現場","掘削","08:00","17:00","60","3","バックホウ","RC40","個人情報を含むメモ"]
 ];
 const {loader}=makeLoader({[SHEETS.dailyReports]:rows});
 const result=await loader.load("construction");
 assert.equal(result.status,"available");
 assert.equal(result.dailyReports.data.reportCount,1);
 assert.equal(result.dailyReports.data.estimatedPersonHours,24);
 assert.equal(JSON.stringify(result).includes("山田太郎"),false);
 assert.equal(JSON.stringify(result).includes("個人情報を含むメモ"),false);
});

test("financial context fails closed when sheet headers do not match",async()=>{
 const {loader}=makeLoader({
  [SHEETS.sales]:[["売上ID","別の列"]],
  [SHEETS.expenses]:[["経費ID","別の列"]],
  [SHEETS.invoices]:[["請求ID","別の列"]],
  [SHEETS.payments]:[["入金ID","別の列"]]
 });
 const result=await loader.load("management");
 assert.equal(result.status,"unavailable");
 assert.equal(result.financial.status,"unavailable");
 assert.equal(result.receivables.status,"unavailable");
 assert.equal(JSON.stringify(result).includes("secret-token"),false);
});

test("unconfigured context explicitly reports that no company data was read",async()=>{
 const loader=createDepartmentContextLoader();
 const result=await loader.load("tax");
 assert.equal(result.status,"not_configured");
 assert.match(result.note,/実データを参照していません/);
});

test("unsupported departments never read arbitrary sheet names",async()=>{
 const {loader,sent}=makeLoader({});
 const result=await loader.load("affiliate");
 assert.equal(result.status,"not_available_for_department");
 assert.equal(sent.length,0);
});
