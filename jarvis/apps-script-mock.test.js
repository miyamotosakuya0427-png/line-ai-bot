"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createGasHarness() {
  const sheets = new Map();
  const properties = new Map([["JARVIS_SHEETS_TOKEN", "s".repeat(128)], ["SPREADSHEET_ID", "test-sheet"]]);
  let uuid = 0;
  class Range {
    constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
    getDisplayValues() { return this.read().map(row => row.map(v => v instanceof Date ? v.toISOString() : String(v ?? ""))); }
    getValues() { return this.read(); }
    read() {
      const out = [];
      for (let r = 0; r < this.rows; r++) {
        const line = [];
        for (let c = 0; c < this.cols; c++) line.push(this.sheet.data[this.row - 1 + r]?.[this.col - 1 + c] ?? "");
        out.push(line);
      }
      return out;
    }
    setValues(values) {
      for (let r = 0; r < values.length; r++) {
        const target = this.sheet.data[this.row - 1 + r] ||= [];
        for (let c = 0; c < values[r].length; c++) target[this.col - 1 + c] = values[r][c];
      }
      return this;
    }
    setValue(value) { return this.setValues([[value]]); }
    getValue() { return this.read()[0][0]; }
  }
  class Sheet {
    constructor(name, rows = []) { this.name = name; this.data = rows.map(row => [...row]); }
    getLastRow() { return this.data.length; }
    getLastColumn() { return Math.max(0, ...this.data.map(row => row.length)); }
    getDataRange() { return new Range(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
    getRange(row, col, rows = 1, cols = 1) { return new Range(this, row, col, rows, cols); }
  }
  const ss = {
    getName: () => "Test spreadsheet",
    getSheets: () => [...sheets.values()],
    getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => { const sheet = new Sheet(name); sheets.set(name, sheet); return sheet; }
  };
  const context = {
    console,
    Date,
    JSON,
    Math,
    String,
    Number,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value)
    }) },
    SpreadsheetApp: { openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => "test-uuid-" + (++uuid) },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: text => ({ text, setMimeType() { return this; } })
    },
    Logger: { log() {} }
  };
  const source = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");
  vm.runInNewContext(source, context, { filename: "Code.gs" });
  return { context, sheets, properties, ss, addSheet(name, rows) { const sheet = new Sheet(name, rows); sheets.set(name, sheet); return sheet; }, request(data, token = "s".repeat(128)) {
    const result = context.doPost({ postData: { contents: JSON.stringify({ ...data, token }) } });
    return JSON.parse(result.text);
  } };
}

const EMPLOYEE_HEADERS = ["従業員ID", "氏名", "LINE表示名", "職種", "役職", "単価", "電話番号", "入社日", "登録日", "状態", "備考"];
const LINE_HEADERS = ["連携ID", "LINEユーザーID", "LINE表示名", "従業員ID", "氏名", "備考", "権限", "状態", "申請日時"];

test("Apps Script rejects missing or invalid shared token", () => {
  const h = createGasHarness();
  assert.deepEqual(h.request({ action: "ping" }, "wrong"), { ok: false, error: "Unauthorized" });
});

test("Apps Script read allowlist denies settings and generic writes", () => {
  const h = createGasHarness();
  h.addSheet("15 設定", [["設定項目"], ["秘密"]]);
  assert.deepEqual(h.request({ action: "readRows", sheetName: "15 設定" }), { ok: false, error: "Sheet is not allowlisted for reading" });
  h.addSheet("03 日報", [["見出し"]]);
  assert.deepEqual(h.request({ action: "appendRows", sheetName: "03 日報", rows: [["x"]] }), {
    ok: false, error: "Generic writes are disabled; use a dedicated validated action"
  });
});

test("LINE link request requires an exact active employee-register ID/name match", () => {
  const h = createGasHarness();
  h.addSheet("01 従業員", [EMPLOYEE_HEADERS,["EMP001","従業員A","","","","","","","","有効",""]]);
  h.addSheet("13 LINE連携", [LINE_HEADERS]);
  const invalid = h.request({ action:"appendLineLink", lineUserId:"U"+"a".repeat(32), displayName:"LINE名", employeeId:"EMP001", employeeName:"別人" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /employee register/);
  const valid = h.request({ action:"appendLineLink", lineUserId:"U"+"a".repeat(32), displayName:"LINE名", employeeId:"EMP001", employeeName:"従業員A" });
  assert.equal(valid.ok, true);
  assert.equal(valid.status, "確認待ち");
  const duplicate = h.request({ action:"appendLineLink", lineUserId:"U"+"b".repeat(32), displayName:"別LINE", employeeId:"EMP001", employeeName:"従業員A" });
  assert.equal(duplicate.ok, false);
});

test("administrator review refuses a tampered pending employee identity", () => {
  const h = createGasHarness();
  h.addSheet("01 従業員", [EMPLOYEE_HEADERS,["EMP001","正規の氏名","","","","","","","","有効",""],["EMP003","代表者","","","","","","","","有効",""]]);
  h.addSheet("13 LINE連携", [
    LINE_HEADERS,
    ["ADMIN-1","U"+"a".repeat(32),"代表者","EMP003","代表者","","管理者","有効",""],
    ["PENDING-1","U"+"b".repeat(32),"申請者","EMP001","別人","","一般","確認待ち",""]
  ]);
  const result = JSON.parse(h.context.reviewLineLink(h.ss, {
    adminLineUserId:"U"+"a".repeat(32), linkId:"PENDING-1", decision:"approve"
  }).text);
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match/);
  assert.equal(h.sheets.get("13 LINE連携").data[2][7], "確認待ち");
});

test("initial administrator bootstrap refuses a mismatched employee name", () => {
  const h = createGasHarness();
  const allowedLineId = "U"+"a".repeat(32);
  h.addSheet("01 従業員", [EMPLOYEE_HEADERS,["EMP003","代表者","","","","","","","","有効",""]]);
  h.addSheet("13 LINE連携", [
    LINE_HEADERS,
    ["PENDING-1",allowedLineId,"代表者","EMP003","別人","","一般","確認待ち",""]
  ]);
  const result = JSON.parse(h.context.bootstrapAdmin(h.ss, {
    lineUserId:allowedLineId, employeeId:"EMP003"
  }, { getProperty:key => key==="JARVIS_INITIAL_ADMIN_LINE_USER_ID"?allowedLineId:null }).text);
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match/);
  assert.equal(h.sheets.get("13 LINE連携").data[1][6], "一般");
  assert.equal(h.sheets.get("13 LINE連携").data[1][7], "確認待ち");
});

test("daily report requires the active verified LINE-to-employee link and is idempotent", () => {
  const h = createGasHarness();
  const lineId = "U"+"c".repeat(32);
  const employeeHeaders = EMPLOYEE_HEADERS;
  const reportHeaders = ["日報ID","記録日時","作業日","従業員ID","氏名","現場名","作業内容","開始時刻","終了時刻","休憩（分）","作業人数","使用機械・車両","使用材料","連絡事項"];
  h.addSheet("01 従業員", [employeeHeaders,["EMP001","従業員A","","","","","","","","有効",""]]);
  h.addSheet("13 LINE連携", [LINE_HEADERS,["LINK-1",lineId,"LINE名","EMP001","従業員A","","一般","有効",""]]);
  h.addSheet("03 日報", [reportHeaders]);
  const report = {
    reportId:"DR-123e4567-e89b-42d3-a456-426614174000",
    recordedAt:"2026-11-17T00:00:00.000Z", workDate:"2026-11-17",
    lineUserId:lineId, employeeId:"EMP001", employeeName:"従業員A",
    siteName:"岡山現場", workDetails:"=IMPORTXML(\"https://invalid.example\")",
    startTime:"08:00", endTime:"17:00", breakMinutes:60, workerCount:2,
    equipment:"", materials:"", notes:""
  };
  const spoofed = JSON.parse(h.context.appendDailyReport(h.ss,{report:{...report,lineUserId:"U"+"d".repeat(32)}}).text);
  assert.equal(spoofed.ok,false);
  assert.match(spoofed.error,/active LINE link/);
  const saved = JSON.parse(h.context.appendDailyReport(h.ss,{report}).text);
  assert.equal(saved.ok,true);
  assert.equal(saved.saved,true);
  assert.equal(h.sheets.get("03 日報").data[1][6], "'=IMPORTXML(\"https://invalid.example\")");
  const duplicate = JSON.parse(h.context.appendDailyReport(h.ss,{report}).text);
  assert.equal(duplicate.ok,true);
  assert.equal(duplicate.duplicate,true);
  assert.equal(h.sheets.get("03 日報").data.length,2);
});
