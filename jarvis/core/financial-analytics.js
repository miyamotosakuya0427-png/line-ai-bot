"use strict";

const MAX_RECORDS = 1000;
const VALID_KINDS = new Set(["revenue", "expense"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y,m,d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d;
}

function normalizeFinancialRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error("Invalid financial record collection");
  return records.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid financial record at index " + index);
    if (!VALID_KINDS.has(row.kind)) throw new Error("Invalid financial record kind at index " + index);
    if (!validDate(row.date)) throw new Error("Invalid financial record date at index " + index);
    if (!Number.isSafeInteger(row.amountYen) || row.amountYen < 0) throw new Error("Invalid financial record amount at index " + index);
    const project = typeof row.project === "string" ? row.project.trim().slice(0,100) : "";
    const category = typeof row.category === "string" ? row.category.trim().slice(0,80) : "";
    return { kind: row.kind, date: row.date, project: project || "現場未設定", category: category || "区分未設定", amountYen: row.amountYen };
  });
}

function summarizeFinancialRecords(records) {
  const normalized = normalizeFinancialRecords(records);
  const groups = new Map();
  let revenueYen = 0, expenseYen = 0;
  for (const row of normalized) {
    if (row.kind === "revenue") revenueYen += row.amountYen;
    else expenseYen += row.amountYen;
    const month = row.date.slice(0,7);
    for (const [key, label] of [[month,"month"],[row.project,"project"],[row.category,"category"]]) {
      const groupKey = label + ":" + key;
      if (!groups.has(groupKey)) groups.set(groupKey,{type:label,name:key,revenueYen:0,expenseYen:0});
      const group = groups.get(groupKey);
      if (row.kind === "revenue") group.revenueYen += row.amountYen;
      else group.expenseYen += row.amountYen;
    }
  }
  const profitYen = revenueYen - expenseYen;
  const sorted = type => [...groups.values()].filter(x=>x.type===type).sort((a,b)=>a.name.localeCompare(b.name,"ja")).map(x=>({...x,profitYen:x.revenueYen-x.expenseYen}));
  return {
    recordCount: normalized.length,
    revenueYen,
    expenseYen,
    profitYen,
    profitMargin: revenueYen > 0 ? Math.round((profitYen/revenueYen)*1000)/10 : null,
    byMonth: sorted("month"),
    byProject: sorted("project"),
    byCategory: sorted("category"),
    accountingNote: "登録された売上・経費レコードの単純集計です。請求額・入金額・未収金、税区分、原価配賦、未登録費用を補正した会計利益ではありません。"
  };
}

module.exports = { MAX_RECORDS, normalizeFinancialRecords, summarizeFinancialRecords };
