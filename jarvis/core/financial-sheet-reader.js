"use strict";
const { summarizeFinancialRecords } = require("./financial-analytics");

const SALES_SHEET = "04 売上";
const EXPENSE_SHEET = "05 経費";
const INVOICE_SHEET = "09 請求";
const PAYMENT_SHEET = "10 入金";
const SALES_HEADERS = ["売上ID","日付","現場ID","現場名","得意先","内容","税抜売上","消費税","税込売上","請求ID","備考","登録日時"];
const EXPENSE_HEADERS = ["経費ID","日付","現場ID","現場名","区分","項目","支払先","税抜金額","消費税","税込金額","支払方法","領収書URL","備考","登録日時"];
const MAX_DATA_ROWS = 99;
const INVOICE_HEADERS = ["請求ID","請求書番号","発行日","支払期限","現場ID","現場名","得意先","税抜金額","消費税","請求金額","入金済額","未入金額","状態","備考"];
const PAYMENT_HEADERS = ["入金ID","入金日","請求ID","現場ID","現場名","得意先","入金額","入金方法","口座","備考"];

function parseDate(value) {
  const raw=String(value||"").trim();
  let match=/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw);
  if (!match) return null;
  const date=match[1]+"-"+match[2].padStart(2,"0")+"-"+match[3].padStart(2,"0");
  const [y,m,d]=date.split("-").map(Number);
  const parsed=new Date(Date.UTC(y,m-1,d));
  return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===m-1&&parsed.getUTCDate()===d?date:null;
}
function parseYen(value) {
  const raw=String(value??"").trim().replace(/[¥￥,\s]/g,"");
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const number=Number(raw);
  return Number.isSafeInteger(number)&&number>=0?number:null;
}
function indexHeaders(row, expected, sheetName) {
  if (!Array.isArray(row) || JSON.stringify(row.map(v=>String(v).trim()))!==JSON.stringify(expected)) {
    const error=new Error("財務シートの列見出しが想定と一致しません: "+sheetName);
    error.code="INVALID_FINANCIAL_SCHEMA";
    throw error;
  }
  return new Map(expected.map((name,index)=>[name,index]));
}
function cell(row, map, key) { return row[map.get(key)]??""; }
function readFinancialSheets({salesRows,expenseRows}) {
  if (!Array.isArray(salesRows)||!Array.isArray(expenseRows)) throw new Error("Financial sheet rows are required");
  if (salesRows.length>MAX_DATA_ROWS+1||expenseRows.length>MAX_DATA_ROWS+1) throw new Error("Financial sheet sample limit exceeded");
  const salesMap=indexHeaders(salesRows[0],SALES_HEADERS,SALES_SHEET);
  const expenseMap=indexHeaders(expenseRows[0],EXPENSE_HEADERS,EXPENSE_SHEET);
  const records=[];
  for (const row of salesRows.slice(1)) {
    if (!row.some(value=>String(value??"").trim())) continue;
    const date=parseDate(cell(row,salesMap,"日付"));
    const amountYen=parseYen(cell(row,salesMap,"税抜売上"));
    if (!date||amountYen===null) throw new Error("売上シートに日付または税抜売上の不正データがあります");
    records.push({kind:"revenue",date,project:String(cell(row,salesMap,"現場ID")).trim()||"現場ID未設定",category:"工事売上",amountYen});
  }
  for (const row of expenseRows.slice(1)) {
    if (!row.some(value=>String(value??"").trim())) continue;
    const date=parseDate(cell(row,expenseMap,"日付"));
    const amountYen=parseYen(cell(row,expenseMap,"税抜金額"));
    if (!date||amountYen===null) throw new Error("経費シートに日付または税抜金額の不正データがあります");
    const category=String(cell(row,expenseMap,"区分")).trim()||"経費";
    records.push({kind:"expense",date,project:String(cell(row,expenseMap,"現場ID")).trim()||"現場ID未設定",category,amountYen});
  }
  return {...summarizeFinancialRecords(records),salesRecordCount:salesRows.length-1,expenseRecordCount:expenseRows.length-1,
    sourceSheets:[SALES_SHEET,EXPENSE_SHEET],sampleLimit:MAX_DATA_ROWS,
    basis:"税抜売上－税抜経費の登録済みデータ。外注費・材料費など別タブとの二重計上を避けるため、ここでは売上・経費タブのみを集計。",
    completeness:"各シート先頭99件のサンプル。全件集計ではありません。請求・入金・未収金、未登録原価、税務上の利益とは異なります。"};
}
function readReceivablesSheets({invoiceRows,paymentRows,asOfDate}) {
  if (!Array.isArray(invoiceRows)||!Array.isArray(paymentRows)) throw new Error("Receivables sheet rows are required");
  if (invoiceRows.length>MAX_DATA_ROWS+1||paymentRows.length>MAX_DATA_ROWS+1) throw new Error("Receivables sample limit exceeded");
  if (!parseDate(asOfDate)) throw new Error("Invalid receivables as-of date");
  const invoiceMap=indexHeaders(invoiceRows[0],INVOICE_HEADERS,INVOICE_SHEET);
  const paymentMap=indexHeaders(paymentRows[0],PAYMENT_HEADERS,PAYMENT_SHEET);
  const invoices=[];
  const invoiceIds=new Set();
  for(const row of invoiceRows.slice(1)){
    if(!row.some(value=>String(value??"").trim()))continue;
    const invoiceId=String(cell(row,invoiceMap,"請求ID")).trim();
    const amountYen=parseYen(cell(row,invoiceMap,"請求金額"));
    const receivedRaw=cell(row,invoiceMap,"入金済額");
    const outstandingRaw=cell(row,invoiceMap,"未入金額");
    const receivedYen=String(receivedRaw??"").trim()===""?0:parseYen(receivedRaw);
    const dueDate=String(cell(row,invoiceMap,"支払期限")).trim()===""?null:parseDate(cell(row,invoiceMap,"支払期限"));
    if(!invoiceId||invoiceIds.has(invoiceId)||amountYen===null||receivedYen===null||(String(cell(row,invoiceMap,"支払期限")).trim()!==""&&!dueDate)) throw new Error("請求シートに不正データがあります");
    const outstandingYen=String(outstandingRaw??"").trim()===""?Math.max(0,amountYen-receivedYen):parseYen(outstandingRaw);
    if(outstandingYen===null||receivedYen>amountYen)throw new Error("請求シートの入金・未入金額が不正です");
    invoiceIds.add(invoiceId);
    invoices.push({invoiceId,dueDate,project:String(cell(row,invoiceMap,"現場ID")).trim()||"現場ID未設定",amountYen,receivedYen,outstandingYen});
  }
  let paymentTotalYen=0;
  const paymentByInvoice=new Map();
  for(const row of paymentRows.slice(1)){
    if(!row.some(value=>String(value??"").trim()))continue;
    const date=parseDate(cell(row,paymentMap,"入金日"));
    const invoiceId=String(cell(row,paymentMap,"請求ID")).trim();
    const amountYen=parseYen(cell(row,paymentMap,"入金額"));
    if(!date||!invoiceId||amountYen===null)throw new Error("入金シートに不正データがあります");
    paymentTotalYen+=amountYen;
    paymentByInvoice.set(invoiceId,(paymentByInvoice.get(invoiceId)||0)+amountYen);
  }
  const billedYen=invoices.reduce((sum,row)=>sum+row.amountYen,0);
  const invoiceReceivedYen=invoices.reduce((sum,row)=>sum+row.receivedYen,0);
  const outstandingYen=invoices.reduce((sum,row)=>sum+row.outstandingYen,0);
  const overdue=invoices.filter(row=>row.outstandingYen>0&&row.dueDate&&row.dueDate<asOfDate);
  const byProject=new Map();
  for(const row of invoices){
    const item=byProject.get(row.project)||{project:row.project,billedYen:0,receivedYen:0,outstandingYen:0};
    item.billedYen+=row.amountYen;item.receivedYen+=row.receivedYen;item.outstandingYen+=row.outstandingYen;
    byProject.set(row.project,item);
  }
  return {
    invoiceCount:invoices.length,paymentCount:paymentRows.slice(1).filter(row=>row.some(v=>String(v??"").trim())).length,
    billedYen,receivedYen:invoiceReceivedYen,outstandingYen,paymentRecordsTotalYen:paymentTotalYen,
    paymentReconciliationDifferenceYen:paymentTotalYen-invoiceReceivedYen,
    overdueInvoiceCount:overdue.length,overdueYen:overdue.reduce((sum,row)=>sum+row.outstandingYen,0),
    byProject:[...byProject.values()].sort((a,b)=>b.outstandingYen-a.outstandingYen).slice(0,10),
    asOfDate,sourceSheets:[INVOICE_SHEET,PAYMENT_SHEET],sampleLimit:MAX_DATA_ROWS,
    note:"請求シートの入金済額・未入金額を請求残高の基準として集計。入金タブの合計との差額は照合用であり、自動補正しません。"
  };
}

module.exports={SALES_SHEET,EXPENSE_SHEET,INVOICE_SHEET,PAYMENT_SHEET,SALES_HEADERS,EXPENSE_HEADERS,INVOICE_HEADERS,PAYMENT_HEADERS,MAX_DATA_ROWS,readFinancialSheets,readReceivablesSheets,parseDate,parseYen};
