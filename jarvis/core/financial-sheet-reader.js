"use strict";
const { summarizeFinancialRecords } = require("./financial-analytics");

const SALES_SHEET = "売上";
const EXPENSE_SHEET = "経費";
const SALES_HEADERS = ["売上ID","日付","現場ID","現場名","得意先","内容","税抜売上","消費税","税込売上","請求ID","備考","登録日時"];
const EXPENSE_HEADERS = ["経費ID","日付","現場ID","現場名","区分","項目","支払先","税抜金額","消費税","税込金額","支払方法","領収書URL","備考","登録日時"];
const MAX_DATA_ROWS = 99;

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
    records.push({kind:"revenue",date,project:String(cell(row,salesMap,"現場名")).trim()||"現場未設定",category:"工事売上",amountYen});
  }
  for (const row of expenseRows.slice(1)) {
    if (!row.some(value=>String(value??"").trim())) continue;
    const date=parseDate(cell(row,expenseMap,"日付"));
    const amountYen=parseYen(cell(row,expenseMap,"税抜金額"));
    if (!date||amountYen===null) throw new Error("経費シートに日付または税抜金額の不正データがあります");
    const category=[cell(row,expenseMap,"区分"),cell(row,expenseMap,"項目")].map(v=>String(v).trim()).filter(Boolean).join(" / ")||"経費";
    records.push({kind:"expense",date,project:String(cell(row,expenseMap,"現場名")).trim()||"現場未設定",category,amountYen});
  }
  return {...summarizeFinancialRecords(records),salesRecordCount:salesRows.length-1,expenseRecordCount:expenseRows.length-1,
    sourceSheets:[SALES_SHEET,EXPENSE_SHEET],sampleLimit:MAX_DATA_ROWS,
    basis:"税抜売上－税抜経費の登録済みデータ。外注費・材料費など別タブとの二重計上を避けるため、ここでは売上・経費タブのみを集計。",
    completeness:"各シート先頭99件のサンプル。全件集計ではありません。請求・入金・未収金、未登録原価、税務上の利益とは異なります。"};
}
module.exports={SALES_SHEET,EXPENSE_SHEET,SALES_HEADERS,EXPENSE_HEADERS,MAX_DATA_ROWS,readFinancialSheets,parseDate,parseYen};
