"use strict";

const {readEmployees,readDailyReports}=require("./company-reader");
const {buildDailyReportAnalytics}=require("./company-analytics");
const {readFinancialSheets,readReceivablesSheets}=require("./financial-sheet-reader");

const SHEETS=Object.freeze({
  employees:"01 従業員",
  dailyReports:"03 日報",
  sales:"04 売上",
  expenses:"05 経費",
  invoices:"09 請求",
  payments:"10 入金"
});
const MAX_ROWS=100;
const SUPPORTED_CONTEXT_DEPARTMENTS=new Set(["hr","construction","jarvis","management","tax"]);
function japanDate(date){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return values.year+"-"+values.month+"-"+values.day;
}

function createDepartmentContextLoader({sheetsUrl="",sheetsToken="",fetchImpl=fetch,clock=()=>new Date()}={}){
  const configured=Boolean(sheetsUrl&&sheetsToken);
  function assertEndpoint(){
    const url=new URL(sheetsUrl);
    if(url.protocol!=="https:"||url.hostname!=="script.google.com"||!url.pathname.startsWith("/macros/s/")||!url.pathname.endsWith("/exec")){
      const error=new Error("Google Sheets endpoint configuration is invalid");error.code="INVALID_SHEETS_ENDPOINT";throw error;
    }
  }
  async function readSheet(sheetName){
    if(!configured){const error=new Error("Google Sheets integration is not configured");error.code="SHEETS_NOT_CONFIGURED";throw error;}
    if(!Object.values(SHEETS).includes(sheetName))throw new Error("Sheet is not allowlisted");
    assertEndpoint();
    const response=await fetchImpl(sheetsUrl,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:sheetsToken,action:"readRows",sheetName,startRow:1,numRows:MAX_ROWS}),
      signal:AbortSignal.timeout(12000)
    });
    if(!response.ok){const error=new Error("Google Sheets request failed");error.code="SHEETS_REQUEST_FAILED";throw error;}
    const result=await response.json();
    if(!result||result.ok!==true||!Array.isArray(result.rows)){const error=new Error("Google Sheets returned invalid rows");error.code="SHEETS_INVALID_RESPONSE";throw error;}
    if(result.rows.length>MAX_ROWS)throw new Error("Google Sheets sample limit exceeded");
    return result.rows;
  }
  async function safeRead(sheetName,parser){
    try{return {status:"available",data:parser(await readSheet(sheetName)),source:sheetName,sampleLimit:MAX_ROWS-1};}
    catch(error){return {status:"unavailable",source:sheetName,reason:typeof error.code==="string"?error.code:"DATA_VALIDATION_FAILED",sampleLimit:MAX_ROWS-1};}
  }
  async function load(departmentId){
    const generatedAt=clock().toISOString();
    if(!configured)return {generatedAt,status:"not_configured",note:"Google Sheetsの読み取り接続が未設定です。実データを参照していません。"};
    if(departmentId==="hr"){
      const employees=await safeRead(SHEETS.employees,rows=>{
        const parsed=readEmployees(rows);
        const byJob={},byStatus={};
        for(const item of parsed){const job=item.job||"未設定";const status=item.status||"未設定";byJob[job]=(byJob[job]||0)+1;byStatus[status]=(byStatus[status]||0)+1;}
        return {employeeCount:parsed.length,byJob,byStatus,privacy:"氏名・従業員ID・連絡先・単価はAIに渡していません。"};
      });
      return {generatedAt,status:employees.status==="available"?"available":"partial",employees};
    }
    if(departmentId==="construction"){
      const reports=await safeRead(SHEETS.dailyReports,rows=>buildDailyReportAnalytics(readDailyReports(rows).map(({employeeId,employeeName,notes,...safe})=>safe)));
      return {generatedAt,status:reports.status==="available"?"available":"unavailable",dailyReports:reports,privacy:"従業員名・従業員ID・連絡事項はAIに渡していません。"};
    }
    if(["jarvis","management","tax"].includes(departmentId)){
      const [salesExpenses,invoices]=await Promise.all([
        (async()=>{try{
          const [salesRows,expenseRows]=await Promise.all([readSheet(SHEETS.sales),readSheet(SHEETS.expenses)]);
          return {status:"available",data:readFinancialSheets({salesRows,expenseRows}),sources:[SHEETS.sales,SHEETS.expenses],sampleLimit:MAX_ROWS-1};
        }catch(error){return {status:"unavailable",reason:typeof error.code==="string"?error.code:"DATA_VALIDATION_FAILED",sources:[SHEETS.sales,SHEETS.expenses],sampleLimit:MAX_ROWS-1};}})(),
        (async()=>{try{
          const [invoiceRows,paymentRows]=await Promise.all([readSheet(SHEETS.invoices),readSheet(SHEETS.payments)]);
          return {status:"available",data:readReceivablesSheets({invoiceRows,paymentRows,asOfDate:japanDate(clock())}),sources:[SHEETS.invoices,SHEETS.payments],sampleLimit:MAX_ROWS-1};
        }catch(error){return {status:"unavailable",reason:typeof error.code==="string"?error.code:"DATA_VALIDATION_FAILED",sources:[SHEETS.invoices,SHEETS.payments],sampleLimit:MAX_ROWS-1};}})()
      ]);
      return {generatedAt,status:salesExpenses.status==="available"||invoices.status==="available"?"partial":"unavailable",financial:salesExpenses,receivables:invoices,
        warning:"各タブ最大99件のサンプルです。全件集計・税務上の確定利益ではありません。列見出しが一致しない場合は集計を停止します。"};
    }
    return {generatedAt,status:"not_available_for_department",note:"この部署用の承認済み読み取りデータアダプターはまだありません。実データを参照していません。"};
  }
  return {load,configured,supports:departmentId=>SUPPORTED_CONTEXT_DEPARTMENTS.has(departmentId),sheets:Object.freeze({...SHEETS})};
}
module.exports={SHEETS,MAX_ROWS,SUPPORTED_CONTEXT_DEPARTMENTS,japanDate,createDepartmentContextLoader};
