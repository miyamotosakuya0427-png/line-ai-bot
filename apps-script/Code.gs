"use strict";

const SPREADSHEET_ID = "1L4ChnqizuusFoPZKwsJL3bcMnYHc96QjC4EFYK_3COg";
const EMPLOYEE_SHEET = "01 従業員";
const LINE_SHEET = "13 LINE連携";
const AUDIT_SHEET = "14 管理者操作履歴";
const INITIAL_ADMIN_PROPERTY = "JARVIS_INITIAL_ADMIN_LINE_USER_ID";
const READABLE_SHEETS = new Set(["01 従業員", "日報", "03 日報", "04 売上", "05 経費", "09 請求", "10 入金", "13 LINE連携"]);
const AUDIT_HEADERS = [
  "記録日時", "操作者LINEユーザーID", "操作", "対象連携ID",
  "対象従業員ID", "変更前状態", "変更後状態", "処理結果"
];

function setupOneJarvis() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (!ss.getSheets().length) throw new Error("スプレッドシートにシートがありません。");
  props.setProperty("SPREADSHEET_ID", SPREADSHEET_ID);
  if (!props.getProperty("JARVIS_SHEETS_TOKEN")) {
    const token = Array.from({ length: 4 }, () => Utilities.getUuid().replace(/-/g, "")).join("");
    props.setProperty("JARVIS_SHEETS_TOKEN", token);
  }
  Logger.log("ONE-JARVIS-SHEETS 設定確認完了");
}

function doGet() {
  return output({ ok: true, service: "ONE-JARVIS-SHEETS" });
}

function doPost(e) {
  try {
    const body = e && e.postData ? e.postData.contents : "";
    if (!body || body.length > 30000) return output({ ok: false, error: "Invalid request size" });
    const data = JSON.parse(body);
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty("JARVIS_SHEETS_TOKEN");
    if (!token || data.token !== token) return output({ ok: false, error: "Unauthorized" });

    const spreadsheetId = props.getProperty("SPREADSHEET_ID");
    if (!spreadsheetId) return output({ ok: false, error: "Spreadsheet is not configured" });
    const ss = SpreadsheetApp.openById(spreadsheetId);

    if (data.action === "ping") return output({ ok: true, title: ss.getName() });
    if (data.action === "listSheets") return output({ ok: true, sheets: ss.getSheets().map(s => s.getName()) });
    if (data.action === "bootstrapAdmin") return bootstrapAdmin(ss, data, props);
    if (data.action === "reviewLineLink") return reviewLineLink(ss, data);
    if (data.action === "appendDailyReport") return appendDailyReport(ss, data);
    if (data.action === "appendLineLink") return appendLineLink(ss, data);

    const sheetName = String(data.sheetName || "");
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return output({ ok: false, error: "Sheet not found" });

    if (data.action === "readRows") {
      if (!READABLE_SHEETS.has(sheetName)) return output({ ok: false, error: "Sheet is not allowlisted for reading" });
      const start = Math.max(1, Number(data.startRow) || 1);
      const count = Math.min(100, Math.max(1, Number(data.numRows) || 20));
      const last = sheet.getLastRow();
      const cols = Math.min(20, Math.max(1, sheet.getLastColumn()));
      if (start > last) return output({ ok: true, rows: [] });
      return output({
        ok: true,
        rows: sheet.getRange(start, 1, Math.min(count, last - start + 1), cols).getDisplayValues()
      });
    }

    if (data.action === "appendRows") return output({ ok: false, error: "Generic writes are disabled; use a dedicated validated action" });

    return output({ ok: false, error: "Unknown action" });
  } catch (err) {
    console.error(err);
    return output({ ok: false, error: "Internal error" });
  }
}

/**
 * 初回管理者登録。
 * LINE IDトークンの検証はJARVISサーバー側で実施済みであること。
 * さらに、スプレッドシート管理者がScript Propertiesへ登録した許可IDと一致する場合だけ許可する。
 */
function bootstrapAdmin(ss, data, props) {
  const lineUserId = String(data.lineUserId || "").trim();
  const employeeId = String(data.employeeId || "").trim();
  const allowedLineUserId = String(props.getProperty(INITIAL_ADMIN_PROPERTY) || "").trim();

  if (!/^U[0-9a-f]{32}$/i.test(lineUserId) ||
      !/^U[0-9a-f]{32}$/i.test(allowedLineUserId) ||
      lineUserId !== allowedLineUserId ||
      employeeId !== "EMP003") {
    return output({ ok: false, error: "Initial administrator is not authorized" });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ss.getSheetByName(LINE_SHEET);
    if (!sheet) return output({ ok: false, error: "LINE sheet not found" });
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return output({ ok: false, error: "Pending application not found" });
    const headers = values[0].map(v => String(v).trim());
    const lineCol = headers.indexOf("LINEユーザーID");
    const employeeCol = headers.indexOf("従業員ID");
    const roleCol = headers.indexOf("権限");
    const statusCol = headers.indexOf("状態");
    const idCol = headers.indexOf("連携ID");
    if ([lineCol, employeeCol, roleCol, statusCol, idCol].some(v => v < 0)) {
      return output({ ok: false, error: "Invalid LINE sheet headers" });
    }
    if (values.slice(1).some(row => String(row[roleCol] || "").trim() === "管理者")) {
      return output({ ok: false, error: "Admin already exists" });
    }
    const matches = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (String(row[lineCol] || "").trim() === lineUserId &&
          String(row[employeeCol] || "").trim() === employeeId &&
          String(row[statusCol] || "").trim() === "確認待ち") matches.push(i + 1);
    }
    if (matches.length !== 1) return output({ ok: false, error: "Pending application not found or duplicated" });

    const rowNumber = matches[0];
    const linkId = String(sheet.getRange(rowNumber, idCol + 1).getValue() || "");
    const employeeNameCol = headers.indexOf("氏名");
    if (employeeNameCol < 0) return output({ ok: false, error: "Invalid LINE sheet headers" });
    const pendingEmployeeName = String(sheet.getRange(rowNumber, employeeNameCol + 1).getValue() || "").trim();
    const employee = findEmployeeRecord(ss, employeeId);
    if (!employee || employee.name !== pendingEmployeeName) {
      return output({ ok: false, error: "Initial administrator identity does not match the employee register" });
    }
    appendAuditEvent(ss, [new Date(), lineUserId, "初回管理者登録", linkId, employeeId, "確認待ち", "管理者/有効", "開始"]);
    sheet.getRange(rowNumber, roleCol + 1).setValue("管理者");
    sheet.getRange(rowNumber, statusCol + 1).setValue("有効");
    appendAuditEvent(ss, [new Date(), lineUserId, "初回管理者登録", linkId, employeeId, "確認待ち", "管理者/有効", "成功"]);
    return output({ ok: true, status: "有効", role: "管理者" });
  } catch (err) {
    try {
      appendAuditEvent(ss, [new Date(), lineUserId, "初回管理者登録", "", employeeId, "", "", "失敗"]);
    } catch (auditError) {
      console.error(auditError);
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 管理者によるLINE連携申請の審査。
 * adminLineUserIdはJARVISサーバーがLINE IDトークンを検証して得た値のみを受け取る。
 */
function reviewLineLink(ss, data) {
  const adminLineUserId = String(data.adminLineUserId || "").trim();
  const linkId = String(data.linkId || "").trim();
  const decision = String(data.decision || "").trim();
  if (!/^U[0-9a-f]{32}$/i.test(adminLineUserId) || !linkId || linkId.length > 100 ||
      !["approve", "reject"].includes(decision)) {
    return output({ ok: false, error: "Invalid review request" });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ss.getSheetByName(LINE_SHEET);
    if (!sheet) return output({ ok: false, error: "LINE sheet not found" });
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return output({ ok: false, error: "No LINE records" });
    const headers = values[0].map(v => String(v).trim());
    const idCol = headers.indexOf("連携ID");
    const lineCol = headers.indexOf("LINEユーザーID");
    const employeeCol = headers.indexOf("従業員ID");
    const roleCol = headers.indexOf("権限");
    const statusCol = headers.indexOf("状態");
    if ([idCol, lineCol, employeeCol, roleCol, statusCol].some(v => v < 0)) {
      return output({ ok: false, error: "Invalid LINE sheet headers" });
    }
    const isAdmin = values.slice(1).some(row =>
      String(row[lineCol] || "").trim() === adminLineUserId &&
      String(row[roleCol] || "").trim() === "管理者" &&
      String(row[statusCol] || "").trim() === "有効"
    );
    if (!isAdmin) return output({ ok: false, error: "Administrator authorization required" });

    const matches = [];
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idCol] || "").trim() === linkId) matches.push(i + 1);
    }
    if (matches.length !== 1) return output({ ok: false, error: "Link request not found or duplicated" });

    const rowNumber = matches[0];
    const currentStatus = String(sheet.getRange(rowNumber, statusCol + 1).getValue()).trim();
    if (currentStatus !== "確認待ち") return output({ ok: false, error: "Request is not pending" });
    const employeeId = String(sheet.getRange(rowNumber, employeeCol + 1).getValue() || "").trim();
    const employeeNameCol = headers.indexOf("氏名");
    if (employeeNameCol < 0) return output({ ok: false, error: "Invalid LINE sheet headers" });
    const employeeName = String(sheet.getRange(rowNumber, employeeNameCol + 1).getValue() || "").trim();
    const employee = findEmployeeRecord(ss, employeeId);
    if (!employee || employee.name !== employeeName) return output({ ok: false, error: "Employee identity does not match the employee register" });
    if (decision === "approve") {
      const targetLineId = String(sheet.getRange(rowNumber, lineCol + 1).getValue() || "").trim();
      const duplicateActive = values.slice(1).some((row, index) => index + 2 !== rowNumber &&
        String(row[statusCol] || "").trim() === "有効" &&
        (String(row[lineCol] || "").trim() === targetLineId ||
         String(row[employeeCol] || "").trim() === employeeId));
      if (duplicateActive) return output({ ok: false, error: "An active LINE link already exists for this user or employee" });
    }
    const newStatus = decision === "approve" ? "有効" : "却下";
    const action = decision === "approve" ? "LINE連携承認" : "LINE連携却下";

    appendAuditEvent(ss, [new Date(), adminLineUserId, action, linkId, employeeId, currentStatus, newStatus, "開始"]);
    try {
      sheet.getRange(rowNumber, statusCol + 1).setValue(newStatus);
      appendAuditEvent(ss, [new Date(), adminLineUserId, action, linkId, employeeId, currentStatus, newStatus, "成功"]);
    } catch (err) {
      try {
        appendAuditEvent(ss, [new Date(), adminLineUserId, action, linkId, employeeId, currentStatus, newStatus, "失敗"]);
      } catch (auditError) {
        console.error(auditError);
      }
      throw err;
    }
    return output({ ok: true, linkId: linkId, status: newStatus });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 監査ログは既存行を更新・削除せず、イベントごとに追記する。
 * シートへの閲覧・編集権限は必要最小限に制限すること。
 */
function appendAuditEvent(ss, row) {
  let sheet = ss.getSheetByName(AUDIT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(AUDIT_SHEET);
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]);
  } else {
    const headers = sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).getDisplayValues()[0];
    if (JSON.stringify(headers) !== JSON.stringify(AUDIT_HEADERS)) {
      throw new Error("監査ログシートの見出しが想定と異なります");
    }
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}


const DAILY_REPORT_SHEET = "03 日報";
const DAILY_REPORT_HEADERS = [
  "日報ID", "記録日時", "作業日", "従業員ID", "氏名", "現場名", "作業内容",
  "開始時刻", "終了時刻", "休憩（分）", "作業人数", "使用機械・車両", "使用材料", "連絡事項"
];

function findActiveLineLink(ss, lineUserId, employeeId, employeeName) {
  const sheet = ss.getSheetByName(LINE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return false;
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(v => String(v).trim());
  const lineCol = headers.indexOf("LINEユーザーID");
  const employeeCol = headers.indexOf("従業員ID");
  const nameCol = headers.indexOf("氏名");
  const statusCol = headers.indexOf("状態");
  if ([lineCol, employeeCol, nameCol, statusCol].some(index => index < 0)) return false;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastColumn).getDisplayValues();
  const matches = rows.filter(row => String(row[lineCol] || "").trim() === lineUserId &&
    String(row[employeeCol] || "").trim() === employeeId &&
    String(row[nameCol] || "").trim() === employeeName &&
    String(row[statusCol] || "").trim() === "有効");
  return matches.length === 1;
}

function appendDailyReport(ss, data) {
  const report = data.report || {};
  const required = ["reportId","recordedAt","workDate","lineUserId","employeeId","employeeName","siteName","workDetails","startTime","endTime"];
  if (required.some(key => !String(report[key] || "").trim()) ||
      !/^DR-[0-9a-f-]{36}$/i.test(String(report.reportId || "")) ||
      !/^U[0-9a-f]{32}$/i.test(String(report.lineUserId || "")) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(report.workDate || "")) ||
      !Number.isFinite(Date.parse(String(report.workDate || "") + "T00:00:00Z")) ||
      new Date(String(report.workDate || "") + "T00:00:00Z").toISOString().slice(0, 10) !== String(report.workDate || "") ||
      !Number.isFinite(Date.parse(String(report.recordedAt || ""))) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(report.startTime || "")) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(report.endTime || "")) ||
      !Number.isInteger(Number(report.breakMinutes)) || Number(report.breakMinutes) < 0 || Number(report.breakMinutes) > 600 ||
      !Number.isInteger(Number(report.workerCount)) || Number(report.workerCount) < 1 || Number(report.workerCount) > 100 ||
      String(report.siteName || "").length > 100 || String(report.workDetails || "").length > 2000 ||
      String(report.equipment || "").length > 300 || String(report.materials || "").length > 500 ||
      String(report.notes || "").length > 1000) {
    return output({ ok: false, error: "Invalid daily report" });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const employee = findEmployeeRecord(ss, String(report.employeeId).trim());
    if (!employee || employee.name !== String(report.employeeName).trim()) {
      return output({ ok: false, error: "Daily report employee does not match the employee register" });
    }
    if (!findActiveLineLink(ss, String(report.lineUserId).trim(), String(report.employeeId).trim(), employee.name)) {
      return output({ ok: false, error: "An active LINE link for this employee is required" });
    }
    let sheet = ss.getSheetByName(DAILY_REPORT_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(DAILY_REPORT_SHEET);
      sheet.getRange(1, 1, 1, DAILY_REPORT_HEADERS.length).setValues([DAILY_REPORT_HEADERS]);
    }
    const headers = sheet.getRange(1, 1, 1, DAILY_REPORT_HEADERS.length).getDisplayValues()[0];
    if (JSON.stringify(headers) !== JSON.stringify(DAILY_REPORT_HEADERS)) {
      return output({ ok: false, error: "Daily report sheet headers do not match" });
    }
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const existing = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat();
      if (existing.includes(String(report.reportId))) return output({ ok: true, saved: true, duplicate: true });
    }
    const values = [
      report.reportId, report.recordedAt, report.workDate, report.employeeId, report.employeeName,
      report.siteName, report.workDetails, report.startTime, report.endTime,
      Number(report.breakMinutes), Number(report.workerCount), report.equipment || "",
      report.materials || "", report.notes || ""
    ].map(value => typeof value === "string" && /^\s*=/.test(value) ? "'" + value : value);
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, values.length).setValues([values]);
    return output({ ok: true, saved: true });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 従業員台帳を唯一の正とし、IDと氏名の組み合わせを検証する。
 */
function findEmployeeRecord(ss, employeeId) {
  if (!/^[A-Z]{2,3}[0-9]{3,6}$/.test(String(employeeId || ""))) return null;
  const sheet = ss.getSheetByName(EMPLOYEE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 2) return null;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(v => String(v).trim());
  const idCol = headers.indexOf("従業員ID");
  const nameCol = headers.indexOf("氏名");
  const statusCol = headers.indexOf("状態");
  if (idCol < 0 || nameCol < 0) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastColumn).getDisplayValues();
  const matches = rows.filter(row => String(row[idCol] || "").trim() === employeeId);
  if (matches.length !== 1) return null;
  const row = matches[0];
  if (statusCol >= 0 && String(row[statusCol] || "有効").trim() === "無効") return null;
  const name = String(row[nameCol] || "").trim();
  return name ? { employeeId, name } : null;
}

/**
 * LINE連携申請専用の追記処理。権限・状態は呼び出し側から受け取らず固定する。
 */
function appendLineLink(ss, data) {
  const lineUserId = String(data.lineUserId || "").trim();
  const displayName = String(data.displayName || "").trim();
  const employeeId = String(data.employeeId || "").trim();
  const employeeName = String(data.employeeName || "").trim();
  if (!/^U[0-9a-f]{32}$/i.test(lineUserId) || !displayName || displayName.length > 100 ||
      !/^[A-Z]{2,3}[0-9]{3,6}$/.test(employeeId) || !employeeName || employeeName.length > 100) {
    return output({ ok: false, error: "Invalid LINE link request" });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ss.getSheetByName(LINE_SHEET);
    if (!sheet) return output({ ok: false, error: "LINE sheet not found" });
    const lastColumn = sheet.getLastColumn();
    if (lastColumn < 1) return output({ ok: false, error: "LINE sheet headers are missing" });
    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(v => String(v).trim());
    const required = ["連携ID", "LINEユーザーID", "LINE表示名", "従業員ID", "氏名", "権限", "状態"];
    const columns = Object.fromEntries(required.map(name => [name, headers.indexOf(name)]));
    if (required.some(name => columns[name] < 0)) return output({ ok: false, error: "Invalid LINE sheet headers" });
    const employee = findEmployeeRecord(ss, employeeId);
    if (!employee || employee.name !== employeeName) {
      return output({ ok: false, error: "Employee ID and name must match the employee register" });
    }
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues();
      if (rows.some(row => String(row[columns["LINEユーザーID"]] || "").trim() === lineUserId || String(row[columns["従業員ID"]] || "").trim() === employeeId)) {
        return output({ ok: false, error: "LINE user or employee already has a link request" });
      }
    }
    const row = Array(lastColumn).fill("");
    row[columns["連携ID"]] = "PENDING-" + Utilities.getUuid();
    row[columns["LINEユーザーID"]] = lineUserId;
    row[columns["LINE表示名"]] = displayName;
    row[columns["従業員ID"]] = employeeId;
    row[columns["氏名"]] = employeeName;
    row[columns["権限"]] = "一般";
    row[columns["状態"]] = "確認待ち";
    const timestampColumn = headers.indexOf("申請日時");
    if (timestampColumn >= 0) row[timestampColumn] = new Date();
    sheet.getRange(lastRow + 1, 1, 1, lastColumn).setValues([row.map(value => typeof value === "string" && /^\\s*=/.test(value) ? "'" + value : value)]);
    return output({ ok: true, appended: 1, status: "確認待ち" });
  } finally { lock.releaseLock(); }
}

function output(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function registerOneEmployees() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(EMPLOYEE_SHEET);
  if (!sheet) throw new Error("01 従業員シートがありません");
  const expectedHeaders = ["従業員ID", "氏名", "LINE表示名", "職種", "役職", "単価", "電話番号", "入社日", "登録日", "状態", "備考"];
  const headers = sheet.getRange(1, 1, 1, 11).getDisplayValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) {
    throw new Error("列見出しが想定と異なるため登録を中止しました");
  }
  const people = [
    ["EMP001", "信原 晴", "社員"], ["EMP002", "宮本 輝成", "社員"],
    ["EMP003", "宮本朔也", "社員"], ["EMP004", "岡本 陽輝", "社員"],
    ["EMP005", "片山 良介", "社員"], ["EXT001", "立神隼人", "外注"],
    ["EXT002", "立神りょうじ", "外注"], ["EXT003", "石原夏輝", "外注"],
    ["EXT004", "花田宏平", "外注"], ["EXT005", "花田1（こ）", "外注"],
    ["EXT006", "花田2（るいと）", "外注"]
  ];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lastRow = sheet.getLastRow();
    const existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 11).getValues() : [];
    const idMap = new Map();
    const nameMap = new Map();
    existing.forEach(row => {
      const id = String(row[0] || "").trim();
      const name = String(row[1] || "").trim();
      if (id && idMap.has(id)) throw new Error("既存の従業員IDが重複しています");
      if (name && nameMap.has(name)) throw new Error("既存の氏名が重複しています");
      if (id) idMap.set(id, name);
      if (name) nameMap.set(name, id);
    });
    const rows = [];
    people.forEach(([id, name, category]) => {
      const existingName = idMap.get(id);
      const existingId = nameMap.get(name);
      if (existingName !== undefined || existingId !== undefined) {
        if (existingName === name && existingId === id) return;
        throw new Error("IDまたは氏名が既存データと一致しません: " + id);
      }
      rows.push([id, name, "", "", "", "", "", "", new Date(), "有効", "区分:" + category]);
    });
    if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 11).setValues(rows);
    Logger.log("新規登録：" + rows.length + "名");
    Logger.log("登録済み：" + (people.length - rows.length) + "名");
  } finally {
    lock.releaseLock();
  }
}
