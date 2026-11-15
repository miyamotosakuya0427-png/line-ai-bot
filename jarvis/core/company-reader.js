"use strict";

const EMPLOYEE_SHEET = "01 従業員";
const DAILY_REPORT_SHEET = "03 日報";
const EMPLOYEE_HEADERS = ["従業員ID","氏名","LINE表示名","職種","役職","単価","電話番号","入社日","登録日","状態","備考"];
const DAILY_REPORT_HEADERS = ["日報ID","記録日時","作業日","従業員ID","氏名","現場名","作業内容","開始時刻","終了時刻","休憩（分）","作業人数","使用機械・車両","使用材料","連絡事項"];

function normalizeRows(rows, expectedHeaders, label) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
    const error = new Error(label + " sheet data is unavailable");
    error.code = "SHEET_DATA_UNAVAILABLE";
    throw error;
  }
  const headers = rows[0].map(value => String(value ?? "").trim());
  if (JSON.stringify(headers.slice(0, expectedHeaders.length)) !== JSON.stringify(expectedHeaders)) {
    const error = new Error(label + " sheet headers do not match the approved schema");
    error.code = "SHEET_SCHEMA_MISMATCH";
    throw error;
  }
  return rows.slice(1).filter(row => Array.isArray(row) && row.some(value => String(value ?? "").trim() !== ""));
}

function readEmployees(rows) {
  return normalizeRows(rows, EMPLOYEE_HEADERS, EMPLOYEE_SHEET).map(row => ({
    employeeId: String(row[0] ?? "").trim(),
    name: String(row[1] ?? "").trim(),
    job: String(row[3] ?? "").trim(),
    title: String(row[4] ?? "").trim(),
    status: String(row[9] ?? "").trim()
  })).filter(row => row.employeeId && row.name);
}

function readDailyReports(rows) {
  return normalizeRows(rows, DAILY_REPORT_HEADERS, DAILY_REPORT_SHEET).map(row => ({
    reportId: String(row[0] ?? "").trim(),
    recordedAt: String(row[1] ?? "").trim(),
    workDate: String(row[2] ?? "").trim().slice(0, 10),
    employeeId: String(row[3] ?? "").trim(),
    employeeName: String(row[4] ?? "").trim(),
    siteName: String(row[5] ?? "").trim(),
    workDetails: String(row[6] ?? "").trim(),
    startTime: String(row[7] ?? "").trim(),
    endTime: String(row[8] ?? "").trim(),
    breakMinutes: Number(row[9] ?? 0),
    workerCount: Number(row[10] ?? 0),
    equipment: String(row[11] ?? "").trim(),
    materials: String(row[12] ?? "").trim(),
    notes: String(row[13] ?? "").trim()
  })).filter(row => row.reportId && /^\d{4}-\d{2}-\d{2}$/.test(row.workDate));
}

function buildCompanyOverview({ employeeRows, dailyReportRows }) {
  const employees = readEmployees(employeeRows);
  const reports = readDailyReports(dailyReportRows).sort((a,b) => b.workDate.localeCompare(a.workDate) || b.recordedAt.localeCompare(a.recordedAt));
  return {
    employeeSheetFound: true,
    activeEmployeeCount: employees.filter(row => row.status === "有効").length,
    employeeCountSampled: employees.length,
    dailyReportSheetFound: true,
    dailyReportCountSampled: reports.length,
    latestWorkDate: reports[0]?.workDate || null,
    recentDailyReports: reports.slice(0, 5)
  };
}

function filterDailyReports(reports, { from, to, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error("Invalid limit");
    error.code = "INVALID_QUERY";
    throw error;
  }
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const error = new Error("Invalid from date");
    error.code = "INVALID_QUERY";
    throw error;
  }
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const error = new Error("Invalid to date");
    error.code = "INVALID_QUERY";
    throw error;
  }
  if (from && to && from > to) {
    const error = new Error("from must not be after to");
    error.code = "INVALID_QUERY";
    throw error;
  }
  return reports.filter(row => (!from || row.workDate >= from) && (!to || row.workDate <= to))
    .sort((a,b) => b.workDate.localeCompare(a.workDate) || b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, limit);
}

module.exports = { EMPLOYEE_SHEET, DAILY_REPORT_SHEET, EMPLOYEE_HEADERS, DAILY_REPORT_HEADERS, readEmployees, readDailyReports, buildCompanyOverview, filterDailyReports };
