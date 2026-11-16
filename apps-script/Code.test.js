"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function makeSheet(initialRows) {
  const rows = initialRows.map(row => row.slice());
  return {
    rows,
    getDataRange() {
      return { getValues: () => rows.map(row => row.slice()) };
    },
    getLastRow() { return rows.length; },
    getLastColumn() { return Math.max(0, ...rows.map(row => row.length)); },
    getRange(row, column, numRows = 1, numColumns = 1) {
      return {
        getValue() { return rows[row - 1]?.[column - 1] ?? ""; },
        setValue(value) {
          while (rows.length < row) rows.push([]);
          while (rows[row - 1].length < column) rows[row - 1].push("");
          rows[row - 1][column - 1] = value;
        },
        getDisplayValues() {
          return Array.from({ length: numRows }, (_, r) =>
            Array.from({ length: numColumns }, (_, c) =>
              String(rows[row - 1 + r]?.[column - 1 + c] ?? "")
            )
          );
        },
        setValues(values) {
          values.forEach((valuesRow, r) => {
            while (rows.length < row + r) rows.push([]);
            for (let c = 0; c < valuesRow.length; c++) {
              while (rows[row - 1 + r].length < column + c) rows[row - 1 + r].push("");
              rows[row - 1 + r][column - 1 + c] = valuesRow[c];
            }
          });
        }
      };
    }
  };
}

function makeSpreadsheet(lineRows) {
  const employeeHeaders = ["従業員ID", "氏名", "LINE表示名", "職種", "役職", "単価", "電話番号", "入社日", "登録日", "状態", "備考"];
  const sheets = {
    "13 LINE連携": makeSheet(lineRows),
    "01 従業員": makeSheet([
      employeeHeaders,
      ["EMP001", "従業員A", "", "", "", "", "", "", "", "有効", ""],
      ["EMP003", "宮本朔也", "", "", "", "", "", "", "", "有効", ""]
    ])
  };
  return {
    sheets,
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) {
      if (sheets[name]) throw new Error("Sheet already exists");
      sheets[name] = makeSheet([]);
      return sheets[name];
    }
  };
}

function loadAppsScript() {
  const source = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");
  const context = {
    console,
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(content) {
        return { content, setMimeType() { return this; } };
      }
    }
  };
  vm.runInNewContext(source, context, { filename: "Code.gs" });
  return context;
}

const headers = ["連携ID", "LINEユーザーID", "LINE表示名", "従業員ID", "従業員名", "グループID", "権限", "状態"];
const adminId = "U" + "a".repeat(32);
const applicantId = "U" + "b".repeat(32);

test("non-admin cannot approve or reject a LINE link request", () => {
  const app = loadAppsScript();
  const ss = makeSpreadsheet([
    headers,
    ["PENDING-1", applicantId, "申請者", "EMP001", "従業員A", "", "一般", "確認待ち"]
  ]);

  const response = JSON.parse(app.reviewLineLink(ss, {
    adminLineUserId: adminId,
    linkId: "PENDING-1",
    decision: "approve"
  }).content);

  assert.equal(response.ok, false);
  assert.equal(response.error, "Administrator authorization required");
  assert.equal(ss.sheets["13 LINE連携"].rows[1][7], "確認待ち");
  assert.equal(ss.sheets["14 管理者操作履歴"], undefined);
});

test("active administrator review changes status and appends start and success audit events", () => {
  const app = loadAppsScript();
  const ss = makeSpreadsheet([
    headers,
    ["ADMIN-1", adminId, "管理者", "EMP003", "管理者", "", "管理者", "有効"],
    ["PENDING-1", applicantId, "申請者", "EMP001", "従業員A", "", "一般", "確認待ち"]
  ]);

  const response = JSON.parse(app.reviewLineLink(ss, {
    adminLineUserId: adminId,
    linkId: "PENDING-1",
    decision: "approve"
  }).content);

  assert.deepEqual(response, { ok: true, linkId: "PENDING-1", status: "有効" });
  assert.equal(ss.sheets["13 LINE連携"].rows[2][7], "有効");
  const audit = ss.sheets["14 管理者操作履歴"].rows;
  assert.equal(audit.length, 3);
  assert.equal(audit[1][1], adminId);
  assert.equal(audit[1][7], "開始");
  assert.equal(audit[2][7], "成功");
});

test("initial admin bootstrap is denied when the trusted allowlist property is missing", () => {
  const app = loadAppsScript();
  const ss = makeSpreadsheet([
    headers,
    ["PENDING-ADMIN", adminId, "管理者候補", "EMP003", "宮本朔也", "", "一般", "確認待ち"]
  ]);
  const props = { getProperty: () => null };

  const response = JSON.parse(app.bootstrapAdmin(ss, {
    lineUserId: adminId,
    employeeId: "EMP003"
  }, props).content);

  assert.equal(response.ok, false);
  assert.equal(response.error, "Initial administrator is not authorized");
  assert.equal(ss.sheets["13 LINE連携"].rows[1][6], "一般");
  assert.equal(ss.sheets["13 LINE連携"].rows[1][7], "確認待ち");
});

test("initial admin bootstrap accepts only the manually allowlisted LINE identity", () => {
  const app = loadAppsScript();
  const ss = makeSpreadsheet([
    headers,
    ["PENDING-ADMIN", adminId, "管理者候補", "EMP003", "宮本朔也", "", "一般", "確認待ち"]
  ]);
  const props = { getProperty: key => key === "JARVIS_INITIAL_ADMIN_LINE_USER_ID" ? adminId : null };

  const response = JSON.parse(app.bootstrapAdmin(ss, {
    lineUserId: adminId,
    employeeId: "EMP003"
  }, props).content);

  assert.deepEqual(response, { ok: true, status: "有効", role: "管理者" });
  assert.equal(ss.sheets["13 LINE連携"].rows[1][6], "管理者");
  assert.equal(ss.sheets["13 LINE連携"].rows[1][7], "有効");
  const audit = ss.sheets["14 管理者操作履歴"].rows;
  assert.equal(audit.length, 3);
  assert.equal(audit[1][7], "開始");
  assert.equal(audit[2][7], "成功");
});

test("initial admin bootstrap rejects a LINE identity that differs from the allowlist", () => {
  const app = loadAppsScript();
  const ss = makeSpreadsheet([
    headers,
    ["PENDING-ADMIN", applicantId, "申請者", "EMP003", "宮本朔也", "", "一般", "確認待ち"]
  ]);
  const props = { getProperty: () => adminId };

  const response = JSON.parse(app.bootstrapAdmin(ss, {
    lineUserId: applicantId,
    employeeId: "EMP003"
  }, props).content);

  assert.equal(response.ok, false);
  assert.equal(response.error, "Initial administrator is not authorized");
  assert.equal(ss.sheets["13 LINE連携"].rows[1][7], "確認待ち");
});

test("LINE link application requires a matching active employee and stores fixed general/pending state", () => {
  const app = loadAppsScript();
  const ss = makeSpreadsheet([headers]);
  const good = JSON.parse(app.appendLineLink(ss, {
    lineUserId: applicantId, displayName: "申請者", employeeId: "EMP001", employeeName: "従業員A"
  }).content);
  assert.equal(good.ok, true);
  const row = ss.sheets["13 LINE連携"].rows[1];
  assert.equal(row[6], "一般");
  assert.equal(row[7], "確認待ち");
  const mismatch = JSON.parse(app.appendLineLink(ss, {
    lineUserId: adminId, displayName: "別申請者", employeeId: "EMP001", employeeName: "別人"
  }).content);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /employee register/);
});

test("administrator approval rejects a pending row whose employee identity no longer matches", () => {
  const app = loadAppsScript();
  const ss = makeSpreadsheet([
    headers,
    ["ADMIN-1", adminId, "管理者", "EMP003", "宮本朔也", "", "管理者", "有効"],
    ["PENDING-1", applicantId, "申請者", "EMP001", "別人", "", "一般", "確認待ち"]
  ]);
  const response = JSON.parse(app.reviewLineLink(ss, {
    adminLineUserId: adminId, linkId: "PENDING-1", decision: "approve"
  }).content);
  assert.equal(response.ok, false);
  assert.match(response.error, /does not match/);
  assert.equal(ss.sheets["13 LINE連携"].rows[2][7], "確認待ち");
});
