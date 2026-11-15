"use strict";

const SPREADSHEET_ID = "1L4ChnqizuusFoPZKwsJL3bcMnYHc96QjC4EFYK_3COg";
const EMPLOYEE_SHEET = "01 従業員";
const LINE_SHEET = "13 LINE連携";
const AUDIT_SHEET = "14 管理者操作履歴";
const INITIAL_ADMIN_PROPERTY = "JARVIS_INITIAL_ADMIN_LINE_USER_ID";
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

    const sheetName = String(data.sheetName || "");
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return output({ ok: false, error: "Sheet not found" });

    if (data.action === "readRows") {
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

    if (data.action === "appendRows") {
      if (!Array.isArray(data.rows) || data.rows.length < 1 || data.rows.length > 50) {
        return output({ ok: false, error: "Invalid rows" });
      }
      if (!data.rows.every(row =>
        Array.isArray(row) && row.length >= 1 && row.length <= 20 &&
        row.every(value => ["string", "number", "boolean"].includes(typeof value) || value === null)
      )) return output({ ok: false, error: "Invalid row format" });

      const width = Math.max(...data.rows.map(row => row.length));
      const safeRows = data.rows.map(row =>
        row.concat(Array(width - row.length).fill("")).map(value =>
          typeof value === "string" && /^\\s*=/.test(value) ? "'" + value : value
        )
      );
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        sheet.getRange(sheet.getLastRow() + 1, 1, safeRows.length, width).setValues(safeRows);
      } finally {
        lock.releaseLock();
      }
      return output({ ok: true, appended: safeRows.length });
    }
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
