"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("./server");
const token="t".repeat(64);
const employeeHeaders=["従業員ID","氏名","LINE表示名","職種","役職","単価","電話番号","入社日","登録日","状態","備考"];
const dailyHeaders=["日報ID","記録日時","作業日","従業員ID","氏名","現場名","作業内容","開始時刻","終了時刻","休憩（分）","作業人数","使用機械・車両","使用材料","連絡事項"];

function fixture() {
  const calls=[];
  const app=createServer({
    token,
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"s".repeat(128),
    fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push(body);
      if(body.action==="listSheets") return {ok:true,json:async()=>({ok:true,sheets:["01 従業員","03 日報","13 LINE連携","15 設定"]})};
      if(body.action==="readRows"&&body.sheetName==="01 従業員") return {ok:true,json:async()=>({ok:true,rows:[
        employeeHeaders,["EMP003","宮本朔也","LINE表示名","土木","代表","99999","090-0000-0000","","","有効","非公開メモ"]
      ]})};
      if(body.action==="readRows"&&body.sheetName==="03 日報") return {ok:true,json:async()=>({ok:true,rows:[
        dailyHeaders,
        ["DR-1","2026-11-15T09:00:00.000Z","2026-11-15","EMP003","宮本朔也","岡山現場","掘削作業","08:00","17:00",60,3,"バックホウ","RC30",""]
      ]})};
      throw new Error("Unexpected Sheets action");
    }
  });
  return {app,calls};
}

test("company overview requires bearer authentication and performs read-only approved reads",async()=>{
  const {app,calls}=fixture();
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const denied=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/overview`);
    assert.equal(denied.status,401);
    assert.equal(calls.length,0);
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/overview`,{headers:{Authorization:`Bearer ${token}`}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.activeEmployeeCount,1);
    assert.equal(result.dailyReportCountSampled,1);
    assert.equal(result.recentDailyReports[0].siteName,"岡山現場");
    assert.equal(JSON.stringify(result).includes("090-0000"),false);
    assert.deepEqual(calls.map(call=>call.action),["listSheets","readRows","readRows"]);
    assert.ok(calls.every(call=>["listSheets","readRows"].includes(call.action)));
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("company employee API excludes personal phone, pay, and notes",async()=>{
  const {app}=fixture();
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/employees`,{headers:{Authorization:`Bearer ${token}`}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.deepEqual(result.employees,[{employeeId:"EMP003",name:"宮本朔也",job:"土木",title:"代表",status:"有効"}]);
    assert.equal(JSON.stringify(result).includes("99999"),false);
    assert.equal(JSON.stringify(result).includes("090-0000"),false);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("company daily reports API applies date and result limits",async()=>{
  const {app}=fixture();
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/daily-reports?from=2026-11-15&to=2026-11-15&limit=5`,{headers:{Authorization:`Bearer ${token}`}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.returned,1);
    assert.equal(result.reports[0].reportId,"DR-1");
    const invalid=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/daily-reports?limit=101`,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(invalid.status,400);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});


test("company analytics API returns bounded aggregate data only",async()=>{
  const {app,calls}=fixture();
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/analytics`,{headers:{Authorization:`Bearer ${token}`}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.analytics.reportCount,1);
    assert.equal(result.analytics.workerDays,3);
    assert.equal(result.analytics.estimatedPersonHours,24);
    assert.equal(result.analytics.topSites[0].name,"岡山現場");
    assert.equal(JSON.stringify(result).includes("宮本朔也"),false);
    assert.deepEqual(calls.map(call=>call.action),["listSheets","readRows"]);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("company ask queues an AI question with aggregate context and no personal data",async()=>{
  const {calls}=fixture();
  let created;
  const jobStore={create:async value=>{created=value;return {created:true,job:{id:"00000000-0000-4000-8000-000000000001",status:"queued"}};}};
  const app=createServer({token,sheetsUrl:"https://script.google.com/macros/s/test-id/exec",sheetsToken:"s".repeat(128),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    if(body.action==="listSheets") return {ok:true,json:async()=>({ok:true,sheets:["03 日報"]})};
    return {ok:true,json:async()=>({ok:true,rows:[dailyHeaders,["DR-1","2026-11-15T09:00:00.000Z","2026-11-15","EMP003","宮本朔也","岡山現場","掘削作業","08:00","17:00",60,3,"バックホウ","RC30",""]]})};
  },jobStore});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/ask`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({request:"現場の稼働状況を教えて"})});
    const result=await response.json();
    assert.equal(response.status,201);
    assert.equal(result.job.status,"queued");
    assert.equal(created.type,"assistant.company_question");
    assert.equal(created.payload.companyContext.dailyReportAnalytics.reportCount,1);
    assert.equal(JSON.stringify(created.payload.companyContext).includes("宮本朔也"),false);
    assert.deepEqual(calls.map(call=>call.action),["listSheets","readRows"]);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});


test("financials API reads only approved sales and expense sheets and returns tax-exclusive aggregates",async()=>{
 const {SALES_HEADERS,EXPENSE_HEADERS}=require("./core/financial-sheet-reader");
 const calls=[];
 const app=createServer({token,sheetsUrl:"https://script.google.com/macros/s/test-id/exec",sheetsToken:"s".repeat(128),fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push(body);
  if(body.action==="listSheets")return{ok:true,json:async()=>({ok:true,sheets:["売上","経費","01 従業員"]})};
  if(body.sheetName==="売上")return{ok:true,json:async()=>({ok:true,rows:[SALES_HEADERS,["S-1","2026/11/01","P1","岡山現場","顧客","工事","850,000","85,000","935,000","I-1","",""] ]})};
  if(body.sheetName==="経費")return{ok:true,json:async()=>({ok:true,rows:[EXPENSE_HEADERS,["E-1","2026/11/02","P1","岡山現場","工事原価","外注費","業者","400,000","40,000","440,000","振込","","",""] ]})};
  throw new Error("Unexpected sheet");
 }});
 await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/financials`,{headers:{Authorization:`Bearer ${token}`}});
  const result=await response.json();
  assert.equal(response.status,200);assert.equal(result.financials.revenueYen,850000);assert.equal(result.financials.expenseYen,400000);assert.equal(result.financials.profitYen,450000);
  assert.equal(JSON.stringify(result).includes("顧客"),false);assert.equal(JSON.stringify(result).includes("業者"),false);
  assert.deepEqual(calls.map(x=>x.action+":"+(x.sheetName||"")),["listSheets:","readRows:売上","readRows:経費"]);
 }finally{await new Promise(resolve=>app.close(resolve));}
});

test("financial API fails closed if either financial sheet is absent",async()=>{
 const app=createServer({token,sheetsUrl:"https://script.google.com/macros/s/test-id/exec",sheetsToken:"s".repeat(128),fetchImpl:async()=>({ok:true,json:async()=>({ok:true,sheets:["売上"]})})});
 await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/financials`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(response.status,404);
 }finally{await new Promise(resolve=>app.close(resolve));}
});


test("company AI question receives bounded financial aggregates but no customer or payee details",async()=>{
 const {SALES_HEADERS,EXPENSE_HEADERS}=require("./core/financial-sheet-reader");
 let created;
 const app=createServer({token,sheetsUrl:"https://script.google.com/macros/s/test-id/exec",sheetsToken:"s".repeat(128),jobStore:{create:async value=>{created=value;return{created:true,job:{id:"00000000-0000-4000-8000-000000000002",status:"queued"}};}},fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);
  if(body.action==="listSheets")return{ok:true,json:async()=>({ok:true,sheets:["03 日報","売上","経費"]})};
  if(body.sheetName==="03 日報")return{ok:true,json:async()=>({ok:true,rows:[dailyHeaders,["DR-1","2026-11-15T09:00:00.000Z","2026-11-15","EMP003","氏名非公開","岡山現場","作業","08:00","17:00",60,2,"","",""]]})};
  if(body.sheetName==="売上")return{ok:true,json:async()=>({ok:true,rows:[SALES_HEADERS,["S-1","2026/11/01","P1","岡山現場","顧客秘密","工事","500000","50000","550000","I-1","",""]]})};
  if(body.sheetName==="経費")return{ok:true,json:async()=>({ok:true,rows:[EXPENSE_HEADERS,["E-1","2026/11/02","P1","岡山現場","工事原価","外注費","業者秘密","200000","20000","220000","振込","url","備考秘密",""]]})};
  throw new Error("Unexpected sheet");
 }});
 await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/company/ask`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({request:"今月の売上と差引を教えて"})});
  assert.equal(response.status,201);
  const context=created.payload.companyContext;
  assert.equal(context.financialSummary.revenueYen,500000);
  assert.equal(context.financialSummary.expenseYen,200000);
  assert.equal(context.financialSummary.profitYen,300000);
  const serialized=JSON.stringify(context);
  for(const secret of ["顧客秘密","業者秘密","備考秘密","氏名非公開","I-1","url"])assert.equal(serialized.includes(secret),false);
 }finally{await new Promise(resolve=>app.close(resolve));}
});
