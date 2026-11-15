"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EMPLOYEE_HEADERS, DAILY_REPORT_HEADERS, readEmployees, readDailyReports, buildCompanyOverview, filterDailyReports } = require("./company-reader");

test("reads only approved employee fields and excludes pay and phone data", () => {
  const rows = [EMPLOYEE_HEADERS, ["EMP003","宮本朔也","LINE","土木","代表","99999","090-0000-0000","","","有効","secret"]];
  assert.deepEqual(readEmployees(rows), [{employeeId:"EMP003",name:"宮本朔也",job:"土木",title:"代表",status:"有効"}]);
});

test("rejects unexpected employee schema", () => {
  assert.throws(() => readEmployees([["従業員ID","氏名","電話番号"]]), /headers do not match/);
});

test("reads daily reports and filters by date without modifying source data", () => {
  const rows = [
    DAILY_REPORT_HEADERS,
    ["DR-1","2026-11-15T09:00:00.000Z","2026-11-15","EMP003","宮本朔也","岡山現場","掘削","08:00","17:00",60,3,"バックホウ","RC30",""],
    ["DR-2","2026-11-14T09:00:00.000Z","2026-11-14","EMP001","信原 晴","倉敷現場","整地","08:00","17:00",60,2,"ダンプ","",""]
  ];
  const reports = readDailyReports(rows);
  assert.equal(reports.length, 2);
  assert.deepEqual(filterDailyReports(reports,{from:"2026-11-15",to:"2026-11-15"}).map(row=>row.reportId),["DR-1"]);
});

test("overview returns counts and recent reports only", () => {
  const employeeRows = [EMPLOYEE_HEADERS,["EMP003","宮本朔也","","土木","代表","100","090","","","有効",""]];
  const dailyReportRows = [DAILY_REPORT_HEADERS,["DR-1","2026-11-15","2026-11-15","EMP003","宮本朔也","岡山現場","掘削","08:00","17:00",60,3,"","",""]];
  const result = buildCompanyOverview({employeeRows,dailyReportRows});
  assert.equal(result.activeEmployeeCount,1);
  assert.equal(result.dailyReportCountSampled,1);
  assert.equal(result.recentDailyReports[0].reportId,"DR-1");
  assert.equal(JSON.stringify(result).includes("090"),false);
});

test("rejects invalid report query bounds", () => {
  assert.throws(() => filterDailyReports([], {from:"2026-13-40"}), /Invalid from date/);
  assert.throws(() => filterDailyReports([], {from:"2026-11-16",to:"2026-11-15"}), /from must not be after to/);
});
