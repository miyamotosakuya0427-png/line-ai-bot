* 株式会社One
* 建設現場管理システム（LINE / Render / OpenAI 連携版）
* 修正版
*
* ---------------------------------------------------
* [今回の修正内容]
* 1. doPost内の6アクション(経費/外注費/材料費/重機‧⾞両/請求/⼊⾦)で
* oneJson() の呼び出しが漏れており、⽣オブジェクトを返していたため
* WebアプリからJSONが返らずエラーになっていた点を修正。
* 2. oneGetSiteProfit() が重機‧⾞両費を全く計算していなかったため、
* 08シートを読み込んで区分（⾞両を含むか）で重機費/⾞両費に
* 振り分けて集計するように追加。
* 3. ⼊⾦登録時、対応する請求(09)の⼊⾦済額‧未⼊⾦額‧状態が
* 更新されず、get
unpaid が常に未⼊⾦のままだった点を修正。
_
* ⼊⾦登録の都度、該当請求IDの⼊⾦合計を再計算して反映する。
* 4. 材料費(07)の税抜⾦額が⾃動計算されておらず、
* LINE側で計算済みの値を送り忘れると空になっていたため、
* 数量×単価から⾃動計算するよう追加。
* 5. 休憩時間の解釈があいまい（8以下なら時間とみなす、という当てずっぽう）
* だったため、「数値は分」「時刻⽂字列(H:MM)は時間:分の⻑さ」という
* 明確なルールに統⼀
。
* 6.
「残業」列が定義されているのに⼀切使われていなかったため、
* 設定シートの「通常勤務時間」を超えた分を残業として算出し、
* 「残業割増率」を掛けて⼈⼯を計算するようにした。
* 7.
「11 利益」「12 ⽉別集計」シートが定義だけで⾃動集計されて
* いなかったため、お⾦が動く登録（売上/経費/外注費/材料費/
* 重機‧⾞両/⽇報/請求/⼊⾦）のたびに全件再集計するようにした。
* 8. 消費税率をハードコード(0.10)せず、15 設定シートの値を
* 参照するように変更。
* ---------------------------------------------------
*
* 機能
* ‧従業員管理 / 現場管理 / ⽇報 / 売上 / 経費 / 外注費
* ‧材料費 / 重機‧⾞両 / 請求 / ⼊⾦ / 利益 / ⽉別集計
* ‧LINEユーザー連携 / API認証 / ID⾃動発⾏
* ‧⼆重登録防⽌ / ロック処理
*******************************************************/
/*******************************************************
* 0. 基本設定
*******************************************************/
const ONE
SYSTEM
NAME =
"株式会社One 建設現場管理システム";
_
_
const ONE
SHEETS = {
_
"01 従業員": [
"従業員ID"
,
"電話番号"
,
"⽒名"
,
"⼊社⽇"
,
"LINE表⽰名"
,
"職種"
,
"役職"
,
"単価"
,
"登録⽇"
,
"状態"
,
"備考"
],
"02 現場": [
"現場ID"
,
"開始⽇"
,
"現場名"
,
"得意先"
,
"終了予定⽇"
,
"状態"
,
"住所"
,
"備考"
,
"担当者"
,
"契約⾦額"
,
"登録⽇時"
],
"03 ⽇報": [
"⽇報ID"
,
"⽇付"
,
"従業員ID"
,
"従業員名"
,
"作業内容"
,
"開始時刻"
,
"終了時刻"
,
"休憩"
,
"⼈⼯"
,
"残業"
,
"交通費"
,
"備考"
,
"登録⽇時"
"現場ID"
,
"現場名"
,
"実働時間"
,
],
"04 売上": [
"売上ID"
,
"税抜売上"
,
"⽇付"
,
"現場ID"
,
"現場名"
,
"得意先"
,
"内容"
,
"税込売上"
,
"請求ID"
,
"備考"
,
"登録⽇時"
],
"05 経費": [
"経費ID"
,
"⽇付"
,
"税抜⾦額"
,
"消費税"
,
"備考"
,
"登録⽇時"
"現場ID"
,
"現場名"
,
"区分"
"税込⾦額"
,
"⽀払⽅法"
,
,
"項⽬"
,
"⽀払先"
,
"領収書URL"
,
],
"06 外注費": [
"外注費ID"
,
"税抜⾦額"
,
"⽇付"
,
"消費税"
,
"現場ID"
,
"現場名"
,
"業者名"
,
"内容"
,
"税込⾦額"
,
"⽀払状況"
,
"備考"
,
"登録⽇時"
],
"07 材料費": [
"材料費ID"
,
"⽇付"
,
"現場ID"
,
"現場名"
,
"材料名"
,
"仕⼊先"
"数量"
,
"単位"
,
"単価"
,
"税抜⾦額"
,
"消費税"
,
"税込⾦額"
,
"備考"
,
"登録⽇時"
,
],
"08 重機‧⾞両": [
"管理ID"
,
"区分"
"⽇額/時間単価"
,
,
"名称"
"燃料費"
,
,
"⾞種/型式"
"稼働時間"
,
,
"ナンバー
"
,
"所有/リース"
,
"使⽤⽇"
,
"稼働現場ID"
,
"備考"
],
"09 請求": [
"請求ID"
,
"得意先"
,
"未⼊⾦額"
,
"請求書番号"
"税抜⾦額"
,
"状態"
,
,
"発⾏⽇"
,
"⽀払期限"
,
"現場ID"
"消費税"
,
"請求⾦額"
,
"⼊⾦済額"
,
"備考"
,
"現場名"
,
],
"10 ⼊⾦": [
"⼊⾦ID"
,
"⼊⾦⽇"
,
"請求ID"
,
"現場ID"
,
"現場名"
,
"得意先"
,
"⼊⾦額"
,
"⼊⾦⽅法"
,
"⼝座"
,
"備考"
],
"11 利益": [
"集計⽉"
"材料費"
,
,
"利益"
,
"現場ID"
"重機費"
"利益率"
,
,
,
"現場名"
"⾞両費"
,
"更新⽇時"
,
"売上"
,
"⼈件費"
,
"外注費"
,
"その他経費"
,
"総原価"
,
],
"12 ⽉別集計": [
"集計⽉"
"売上"
"⼈件費"
"外注費"
"⾞両費"
"請求額"
,
,
,
,
,
,
"その他経費"
,
"総原価"
,
"利益"
"⼊⾦額"
,
"未⼊⾦額"
,
"現場数"
"材料費"
,
"利益率"
,
,
"⼈⼯数"
"重機費"
,
,
],
"13 LINE連携": [
"連携ID"
,
"LINEユーザーID"
,
"グループID"
,
"権限"
,
"状態"
,
"LINE表⽰名"
,
"初回登録⽇時"
,
"従業員ID"
,
"最終利⽤⽇時"
"従業員名"
,
],
"14 APIログ": [
"ログID"
,
"結果"
,
"⽇時"
"内容"
,
,
"アクション"
,
"LINEユーザーID"
,
"LINE表⽰名"
,
"エラー
"
],
"15 設定": [
"設定項⽬"
,
"設定値"
,
"備考"
]
};
// ⾦額計算‧利益集計を⾃動的に再計算すべきシート
const ONE
MONEY
SHEETS = [
_
_
"03 ⽇報"
,
"04 売上"
,
"05 経費"
,
"06 外注費"
,
"07 材料費"
,
"08 重機‧⾞両"
,
"09 請求"
,
"10 ⼊⾦"
];
/*******************************************************
* 1. 初回セットアップ
*******************************************************/
function setupOneSystem() {
const ss = SpreadsheetApp.getActiveSpreadsheet();
Object.keys(ONE
SHEETS).forEach(function (sheetName) {
_
let sheet = ss.getSheetByName(sheetName);
if (!sheet) {
sheet = ss.insertSheet(sheetName);
}
const headers = ONE
SHEETS[sheetName];
_
const lastColumn = Math.max(sheet.getLastColumn(), 1);
const currentHeaders = sheet
.getRange(1, 1, 1, lastColumn)
.getValues()[0];
const hasHeader = currentHeaders.some(function (v) {
return String(v || "").trim() !==
"";
});
if (!hasHeader) {
sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}
sheet
.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length))
.setFontWeight("bold");
sheet.setFrozenRows(1);
for (let c = 1; c <= Math.max(sheet.getLastColumn(), headers.length); c++) {
sheet.setColumnWidth(c, 130);
}
});
/*
*/
* 設定初期値
const settingSheet = ss.getSheetByName("15 設定");
if (settingSheet.getLastRow() < 2) {
settingSheet.getRange(2, 1, 7, 3).setValues([
["会社名"
,
"株式会社One"
,
""],
["消費税率"
, 0.10,
"通常税率"],
["通常勤務時間"
, 8,
"1⽇あたりの通常勤務時間（残業判定の基準）"],
["残業割増率"
, 1.25,
"通常時給に対する倍率"],
["API状態"
,
"ACTIVE"
,
""],
["システムバージョン"
,
"ONE-LINE-1.1"
,
""],
["最終セットアップ"
, new Date(),
""]
]);
} else {
// 既存設定に不⾜している項⽬があれば追加する（値は上書きしない）
oneEnsureSettingRow(settingSheet,
"通常勤務時間"
, 8,
oneEnsureSettingRow(settingSheet,
"残業割増率"
, 1.25,
"1⽇あたりの通常勤務時間（残業判定の基準）");
"通常時給に対する倍率");
}
setupOneApiToken(false);
// 初回セットアップ時点のデータで利益‧⽉別集計を作成しておく
oneRecalcProfitAndMonthly();
SpreadsheetApp.getUi().alert(
"株式会社Oneシステムのセットアップが完了しました。
"
);
}
function oneEnsureSettingRow(settingSheet, name, value, note) {
const values = settingSheet.getDataRange().getValues();
for (let i = 1; i < values.length; i++) {
if (String(values[i][0]) === name) {
return; // 既にある場合は何もしない
}
}
settingSheet.appendRow([name, value, note]);
}
/*******************************************************
* 2. APIトークン
*******************************************************/
function setupOneApiToken(showAlert) {
const props = PropertiesService.getScriptProperties();
let token = props.getProperty("ONE
API
_
_
TOKEN");
if (!token) {
token = Utilities.getUuid() + "
-
props.setProperty("ONE
API
TOKEN"
" + Utilities.getUuid();
, token);
_
_
}
if (showAlert !== false) {
SpreadsheetApp.getUi().alert(
"APIトークン\n\n" + token +
"\n\nこのトークンはRenderの\nONE
SHEETS
API
TOKEN\nに設定してください。
_
_
_
);
}
return token;
"
}
/*******************************************************
* 3. GET
*******************************************************/
function doGet(e) {
return oneJson({
ok: true,
service: ONE
SYSTEM
NAME,
_
_
status: "online"
,
version: "ONE-LINE-1.1"
,
time: new Date().toISOString()
});
}
/*******************************************************
* 4. POST API
*******************************************************/
function doPost(e) {
try {
if (!e || !e.postData || !e.postData.contents) {
return oneJson({ ok: false, error: "POSTデータがありません" });
}
const body = JSON.parse(e.postData.contents);
/*
* API認証
*/
const savedToken = PropertiesService.getScriptProperties().getProperty("ONE
API
_
_
TOKEN");
if (!savedToken) {
return oneJson({ ok: false, error: "APIトークンが設定されていません" });
}
if (body.token !== savedToken) {
oneWriteApiLog(body,
"ERROR"
,
"API認証エラー
");
return oneJson({ ok: false, error: "認証エラー
" });
}
const action = String(body.action || "").trim();
if (!action) {
return oneJson({ ok: false, error: "actionが指定されていません" });
}
/* PING */
if (action ===
"ping") {
return oneJson({
ok: true,
action: "ping"
,
message: "株式会社One Google Sheets API 接続OK"
,
time: new Date().toISOString()
});
}
/* LINE情報登録 */
if (action ===
"line
info") {
_
return oneJson(oneRegisterLineUser(body));
}
/* ⽇報 */
if (action ===
"register
_
daily_
report") {
return oneJson(oneRegisterRow({
sheetName: "03 ⽇報"
, idHeader: "⽇報ID"
data: body.data || {}, action: action
}));
,
}
/* 売上 */
if (action ===
"register
sales") {
_
return oneJson(oneRegisterRow({
sheetName: "04 売上"
, idHeader: "売上ID"
data: body.data || {}, action: action
}));
}
/* 経費 */
if (action ===
"register
expense") {
_
return oneJson(oneRegisterRow({
sheetName: "05 経費"
, idHeader: "経費ID"
data: body.data || {}, action: action
}));
,
,
}
/* 外注費 */
if (action ===
"register
subcontract") {
_
return oneJson(oneRegisterRow({
sheetName: "06 外注費"
, idHeader: "外注費ID"
data: body.data || {}, action: action
}));
,
}
/* 材料費 */
if (action ===
"register
material") {
_
return oneJson(oneRegisterRow({
sheetName: "07 材料費"
, idHeader: "材料費ID"
data: body.data || {}, action: action
}));
,
}
/* 重機‧⾞両 */
if (action ===
"register
machine") {
_
return oneJson(oneRegisterRow({
sheetName: "08 重機‧⾞両"
, idHeader: "管理ID"
data: body.data || {}, action: action
}));
,
}
/* 請求 */
if (action ===
"register
invoice") {
_
return oneJson(oneRegisterRow({
sheetName: "09 請求"
, idHeader: "請求ID"
data: body.data || {}, action: action
}));
,
}
/* ⼊⾦ */
if (action ===
"register
_payment") {
const result = oneRegisterRow({
sheetName: "10 ⼊⾦"
, idHeader: "⼊⾦ID"
data: body.data || {}, action: action
,
});
// ⼊⾦登録が成功したら、対応する請求の⼊⾦状況を更新する
if (result.ok) {
oneUpdateInvoiceOnPayment(body.data || {});
}
return oneJson(result);
}
/* 従業員 */
if (action ===
"register
employee") {
_
return oneJson(oneRegisterRow({
sheetName: "01 従業員"
, idHeader: "従業員ID"
data: body.data || {}, action: action
}));
,
}
/* 現場 */
if (action ===
"register
site") {
_
return oneJson(oneRegisterRow({
sheetName: "02 現場"
, idHeader: "現場ID"
data: body.data || {}, action: action
}));
,
}
/* 現場⼀覧 */
if (action ===
"get
sites") {
_
return oneJson({ ok: true, action: action, data: oneSheetToObjects("02 現場") });
}
/* 従業員⼀覧 */
if (action ===
"get
employees") {
_
return oneJson({ ok: true, action: action, data: oneSheetToObjects("01 従業員") });
}
/* LINE連携情報取得 */
if (action ===
"get
line
user") {
_
_
const userId = String(body.lineUserId || "").trim();
return oneJson({ ok: true, action: action, data: oneFindLineUser(userId) });
}
/* ⽉別集計 */
if (action ===
"get
_
monthly_
summary") {
const year = Number(body.year);
const month = Number(body.month);
return oneJson(oneGetMonthlySummary(year, month));
}
/* 未⼊⾦ */
if (action ===
"get
unpaid") {
_
return oneJson({ ok: true, data: oneGetUnpaid() });
}
/* 現場利益 */
if (action ===
"get
site
_
_profit") {
const siteId = String(body.siteId || "").trim();
return oneJson(oneGetSiteProfit(siteId));
}
/* 利益‧⽉別集計の⼿動再計算 */
if (action ===
"recalc
_profit") {
oneRecalcProfitAndMonthly();
return oneJson({ ok: true, action: action, message: "再集計しました" });
}
return oneJson({ ok: false, error: "未対応のactionです"
, action: action });
} catch (error) {
return oneJson({ ok: false, error: String(error.message || error) });
}
}
/*******************************************************
* 5. JSONレスポンス
*******************************************************/
function oneJson(obj) {
return ContentService
.createTextOutput(JSON.stringify(obj))
.setMimeType(ContentService.MimeType.JSON);
}
/*******************************************************
* 6. データ登録
*******************************************************/
function oneRegisterRow(options) {
const lock = LockService.getScriptLock();
try {
lock.waitLock(15000);
const ss = SpreadsheetApp.getActiveSpreadsheet();
const sheet = ss.getSheetByName(options.sheetName);
if (!sheet) {
return { ok: false, error: "シートがありません: " + options.sheetName };
}
const lastColumn = sheet.getLastColumn();
const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
const data = options.data || {};
/* ID列 */
const idIndex = headers.indexOf(options.idHeader);
/* 既存IDが送信されていれば重複チェック */
if (idIndex !== -1 && data[options.idHeader]) {
const existing = oneFindValue(sheet, idIndex + 1, String(data[options.idHeader]));
if (existing) {
return {
ok: false, duplicate: true,
error: "同じIDが既に存在します"
id: data[options.idHeader]
,
};
}
}
/* ⾏作成 */
const row = new Array(headers.length).fill("");
headers.forEach(function (header, index) {
const key = String(header || "").trim();
if (Object.prototype.hasOwnProperty.call(data, key)) {
row[index] = data[key];
}
});
/* ID⾃動発⾏ */
if (idIndex !== -1 && !row[idIndex]) {
row[idIndex] = oneCreateId(sheet, options.idHeader);
}
/* 登録⽇時 */
const timestampIndex = headers.indexOf("登録⽇時");
if (timestampIndex !== -1 && !row[timestampIndex]) {
row[timestampIndex] = new Date();
}
/* ⽇報の実働時間‧残業‧⼈⼯計算 */
if (options.sheetName ===
"03 ⽇報") {
oneCalculateDailyReport(headers, row);
}
/* ⾦額計算（材料費の⾃動計算‧税計算を含む） */
oneCalculateMoney(headers, row);
/* 請求の初期値（⼊⾦済額0‧未⼊⾦額=請求⾦額‧状態=未⼊⾦） */
if (options.sheetName ===
"09 請求") {
oneInitializeInvoiceRow(headers, row);
}
/* 空データ防⽌ */
const meaningful = row.some(function (value) {
return value !==
"" && value !== null && value !== undefined;
});
if (!meaningful) {
return { ok: false, error: "登録するデータがありません" };
}
/* 最終⾏へ追加 */
const rowNumber = sheet.getLastRow() + 1;
sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
/* APIログ */
oneWriteApiLog(
{ action: options.action, data: data },
"SUCCESS"
,
options.sheetName + "へ登録"
);
const result = {
ok: true,
action: options.action,
sheet: options.sheetName,
id: idIndex !== -1 ? row[idIndex] : ""
rowNumber: rowNumber,
message: "登録しました"
,
};
return result;
} catch (error) {
return { ok: false, error: String(error.message || error) };
} finally {
try { lock.releaseLock(); } catch (e) { }
// ⾦額が動くシートへの登録なら、利益‧⽉別集計を再計算する
// (登録の成否に関わらず安全に呼べる: 失敗時もデータは変わっていないため無害)
if (ONE
MONEY
SHEETS.indexOf(options.sheetName) !== -1) {
_
_
try { oneRecalcProfitAndMonthly(); } catch (e) { }
}
}
}
/*******************************************************
* 7. ID作成
*******************************************************/
function oneCreateId(sheet, idHeader) {
const column = sheet
.getRange(1, 1, Math.max(sheet.getLastRow(), 1), sheet.getLastColumn())
.getValues();
const headers = column[0];
const idIndex = headers.indexOf(idHeader);
if (idIndex === -1) {
return idHeader + "
-
" + Utilities.getUuid().substring(0, 8);
}
let maxNumber = 0;
for (let i = 1; i < column.length; i++) {
const value = String(column[i][idIndex] || "");
const match = value.match(/(\d+)$/);
if (match) {
maxNumber = Math.max(maxNumber, Number(match[1]));
}
}
const prefixMap = {
"従業員ID": "EMP-
"売上ID": "SALES-
"材料費ID": "MAT-
"⼊⾦ID": "PAY-
"
,
"
"
"
,
,
,
"現場ID": "SITE-
"
"経費ID": "EXP-
"管理ID": "MCH-
"連携ID": "LINE-
"
"
"
,
,
,
,
"⽇報ID": "DR-
"
,
"外注費ID": "SUB-
"請求ID": "INV-
"
,
"ログID": "LOG-
"
"
,
};
const prefix = prefixMap[idHeader] || idHeader + "
-
";
return prefix + Utilities.formatString("%06d"
, maxNumber + 1);
}
/*******************************************************
* 8. ⽇報計算（実働時間‧残業‧⼈⼯）
*******************************************************/
function oneCalculateDailyReport(headers, row) {
const startIndex = headers.indexOf("開始時刻");
const endIndex = headers.indexOf("終了時刻");
const breakIndex = headers.indexOf("休憩");
const hoursIndex = headers.indexOf("実働時間");
const laborIndex = headers.indexOf("⼈⼯");
const overtimeIndex = headers.indexOf("残業");
if (startIndex === -1 || endIndex === -1) {
return;
}
const start = oneTimeToMinutes(row[startIndex]);
const end = oneTimeToMinutes(row[endIndex]);
if (start === null || end === null) {
return;
}
const breakMinutes = oneDurationToMinutes(row[breakIndex]);
let totalMinutes = end - start;
/* ⽇跨ぎ */
if (totalMinutes < 0) {
totalMinutes += 1440;
}
const actualMinutes = Math.max(0, totalMinutes - breakMinutes);
const actualHours = actualMinutes / 60;
const normalHours = Number(oneGetSetting("通常勤務時間"
const overtimeRate = Number(oneGetSetting("残業割増率"
, 8)) || 8;
, 1.25)) || 1.25;
const overtimeHours = Math.max(0, actualHours - normalHours);
const regularHours = actualHours - overtimeHours;
const laborUnits = normalHours > 0
? (regularHours + overtimeHours * overtimeRate) / normalHours
: 0;
if (hoursIndex !== -1) {
row[hoursIndex] = Number(actualHours.toFixed(2));
}
if (overtimeIndex !== -1) {
row[overtimeIndex] = Number(overtimeHours.toFixed(2));
}
if (laborIndex !== -1) {
row[laborIndex] = Number(laborUnits.toFixed(2));
}
}
/*******************************************************
* 9. 時刻‧時間の変換
*******************************************************/
// 開始/終了時刻（1⽇の中の時刻）→ 0時からの分
function oneTimeToMinutes(value) {
if (value === null || value === undefined || value ===
return null;
"") {
}
if (Object.prototype.toString.call(value) ===
return value.getHours() * 60 + value.getMinutes();
"[object Date]") {
}
const text = String(value).trim();
const match = text.match(/^(\d{1,2}):(\d{1,2})/);
if (!match) {
// 数値のみが渡された場合は「分」として扱う
const num = Number(text);
return isNaN(num) ? null : num;
}
return Number(match[1]) * 60 + Number(match[2]);
}
// 休憩時間（⻑さ）→ 分
// ルール: 数値はそのまま「分」。
"H:MM" 形式の⽂字列や時刻シリアル値は
// 「時間:分の⻑さ」として解釈する（例: "1:00"
= 60分,
"0:30"
= 30分）。
function oneDurationToMinutes(value) {
if (value === null || value === undefined || value ===
"") {
return 0;
}
if (Object.prototype.toString.call(value) ===
return value.getHours() * 60 + value.getMinutes();
"[object Date]") {
}
if (typeof value ===
return value;
"number") {
}
const text = String(value).trim();
const match = text.match(/^(\d{1,2}):(\d{1,2})$/);
if (match) {
return Number(match[1]) * 60 + Number(match[2]);
}
const num = Number(text);
return isNaN(num) ? 0 : num;
}
/*******************************************************
* 10. ⾦額計算
*******************************************************/
function oneCalculateMoney(headers, row) {
const taxRate = Number(oneGetSetting("消費税率"
, 0.10)) || 0.10;
/*
* 材料費: 数量 × 単価 → 税抜⾦額（未⼊⼒の場合のみ）
*/
const qtyIndex = headers.indexOf("数量");
const unitPriceIndex = headers.indexOf("単価");
const taxExIndex = headers.indexOf("税抜⾦額");
if (
qtyIndex !== -1 &&
unitPriceIndex !== -1 &&
taxExIndex !== -1 &&
!row[taxExIndex]
) {
const qty = Number(row[qtyIndex]) || 0;
const unitPrice = Number(row[unitPriceIndex]) || 0;
if (qty && unitPrice) {
row[taxExIndex] = qty * unitPrice;
}
}
/*
*/
* 汎⽤: 税抜⾦額 → 消費税‧税込⾦額
const taxIndex = headers.indexOf("消費税");
const taxInIndex = headers.indexOf("税込⾦額");
if (taxExIndex !== -1) {
const base = Number(row[taxExIndex]) || 0;
if (taxIndex !== -1 && !row[taxIndex]) {
row[taxIndex] = Math.floor(base * taxRate);
}
if (taxInIndex !== -1 && !row[taxInIndex]) {
row[taxInIndex] = base +
(taxIndex !== -1 ? Number(row[taxIndex]) || 0 : Math.floor(base * taxRate));
}
}
/*
*/
* 売上: 税抜売上 → 税込売上
const salesExIndex = headers.indexOf("税抜売上");
const salesInIndex = headers.indexOf("税込売上");
if (salesExIndex !== -1 && salesInIndex !== -1) {
const sales = Number(row[salesExIndex]) || 0;
if (!row[salesInIndex]) {
row[salesInIndex] = sales + Math.floor(sales * taxRate);
}
}
/*
* 請求: 税抜⾦額 → 消費税‧請求⾦額
* （経費/外注費/材料費と「税抜⾦額」列を共有するため、
* 「請求⾦額」列がある場合のみここで処理する）
*/
const invoiceTotalIndex = headers.indexOf("請求⾦額");
if (taxExIndex !== -1 && invoiceTotalIndex !== -1) {
const base = Number(row[taxExIndex]) || 0;
if (!row[invoiceTotalIndex]) {
row[invoiceTotalIndex] = base +
(taxIndex !== -1 ? Number(row[taxIndex]) || 0 : Math.floor(base * taxRate));
}
}
}
/*******************************************************
* 10-2. 請求⾏の初期値
*******************************************************/
function oneInitializeInvoiceRow(headers, row) {
const totalIndex = headers.indexOf("請求⾦額");
const paidIndex = headers.indexOf("⼊⾦済額");
const unpaidIndex = headers.indexOf("未⼊⾦額");
const statusIndex = headers.indexOf("状態");
const total = totalIndex !== -1 ? (Number(row[totalIndex]) || 0) : 0;
if (paidIndex !== -1 && !row[paidIndex]) {
row[paidIndex] = 0;
}
if (unpaidIndex !== -1 && !row[unpaidIndex]) {
row[unpaidIndex] = total;
}
if (statusIndex !== -1 && !row[statusIndex]) {
row[statusIndex] = total > 0 ? "未⼊⾦" : "";
}
}
/*******************************************************
* 10-3. ⼊⾦登録に伴う請求の更新
*******************************************************/
function oneUpdateInvoiceOnPayment(paymentData) {
const invoiceId = String(paymentData["請求ID"] || "").trim();
if (!invoiceId) {
return;
}
const ss = SpreadsheetApp.getActiveSpreadsheet();
const invoiceSheet = ss.getSheetByName("09 請求");
if (!invoiceSheet) {
return;
}
const invoiceValues = invoiceSheet.getDataRange().getValues();
const invoiceHeaders = invoiceValues[0];
const idIndex = invoiceHeaders.indexOf("請求ID");
const totalIndex = invoiceHeaders.indexOf("請求⾦額");
const paidIndex = invoiceHeaders.indexOf("⼊⾦済額");
const unpaidIndex = invoiceHeaders.indexOf("未⼊⾦額");
const statusIndex = invoiceHeaders.indexOf("状態");
if (idIndex === -1) {
return;
}
let targetRow = -1;
for (let i = 1; i < invoiceValues.length; i++) {
if (String(invoiceValues[i][idIndex]) === invoiceId) {
targetRow = i + 1; // シート上の⾏番号
break;
}
}
if (targetRow === -1) {
return; // 対応する請求が⾒つからない場合は何もしない
}
// この請求IDに対する⼊⾦の合計を再計算する
const payments = oneSheetToObjects("10 ⼊⾦");
let paidTotal = 0;
payments.forEach(function (p) {
if (String(p["請求ID"]) === invoiceId) {
paidTotal += Number(p["⼊⾦額"]) || 0;
}
});
const total = totalIndex !== -1
? (Number(invoiceValues[targetRow - 1][totalIndex]) || 0)
: 0;
const unpaid = Math.max(0, total - paidTotal);
let status =
"未⼊⾦";
if (paidTotal >= total && total > 0) {
status =
"⼊⾦完了";
} else if (paidTotal > 0) {
status =
"
⼀部⼊⾦";
}
if (paidIndex !== -1) {
invoiceSheet.getRange(targetRow, paidIndex + 1).setValue(paidTotal);
}
if (unpaidIndex !== -1) {
invoiceSheet.getRange(targetRow, unpaidIndex + 1).setValue(unpaid);
}
if (statusIndex !== -1) {
invoiceSheet.getRange(targetRow, statusIndex + 1).setValue(status);
}
}
/*******************************************************
* 11. LINEユーザー登録
*******************************************************/
function oneRegisterLineUser(body) {
const data = body.data || {};
const lineUserId = String(
data["LINEユーザーID"] || body.lineUserId || ""
).trim();
if (!lineUserId) {
return { ok: false, error: "LINEユーザーIDがありません" };
}
const existing = oneFindLineUser(lineUserId);
if (existing) {
const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("13 LINE連携");
const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
const row = existing.row;
const timeIndex = headers.indexOf("最終利⽤⽇時");
if (timeIndex !== -1) {
sheet.getRange(row, timeIndex + 1).setValue(new Date());
}
return { ok: true, existing: true, data: oneSheetRowObject(sheet, row) };
}
const registerData = {
"LINEユーザーID": lineUserId,
"LINE表⽰名": data["LINE表⽰名"] || body.lineDisplayName || ""
"従業員ID": data["従業員ID"] || ""
,
"従業員名": data["従業員名"] || ""
,
"グループID": data["グループID"] || body.groupId || ""
,
"権限": data["権限"] || "
⼀般"
"状態": data["状態"] || "有効"
,
,
"初回登録⽇時": new Date(),
"最終利⽤⽇時": new Date()
,
};
return oneRegisterRow({
sheetName: "13 LINE連携"
,
idHeader: "連携ID"
,
data: registerData,
action: "line
info"
_
});
}
/*******************************************************
* 12. LINEユーザー検索
*******************************************************/
function oneFindLineUser(lineUserId) {
if (!lineUserId) {
return null;
}
const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("13 LINE連携");
if (!sheet) {
return null;
}
const values = sheet.getDataRange().getValues();
if (values.length < 2) {
return null;
}
const headers = values[0];
const idIndex = headers.indexOf("LINEユーザーID");
if (idIndex === -1) {
return null;
}
for (let i = 1; i < values.length; i++) {
if (String(values[i][idIndex]) === String(lineUserId)) {
return { row: i + 1, data: oneArrayToObject(headers, values[i]) };
}
}
return null;
}
/*******************************************************
* 13. シート→オブジェクト
*******************************************************/
function oneSheetToObjects(sheetName) {
const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
if (!sheet) {
return [];
}
const values = sheet.getDataRange().getValues();
if (values.length < 2) {
return [];
}
const headers = values[0];
const result = [];
for (let i = 1; i < values.length; i++) {
let hasData = false;
for (let j = 0; j < values[i].length; j++) {
if (values[i][j] !==
"" && values[i][j] !== null) {
hasData = true;
break;
}
}
if (!hasData) {
continue;
}
result.push(oneArrayToObject(headers, values[i]));
}
return result;
}
/*******************************************************
* 14. 配列→オブジェクト
*******************************************************/
function oneArrayToObject(headers, values) {
const obj = {};
headers.forEach(function (header, index) {
if (header !==
"" && header !== null) {
obj[String(header)] = values[index];
}
});
return obj;
}
/*******************************************************
* 15. シートの1⾏取得
*******************************************************/
function oneSheetRowObject(sheet, rowNumber) {
const values = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
return oneArrayToObject(headers, values);
}
/*******************************************************
* 16. 重複検索
*******************************************************/
function oneFindValue(sheet, columnNumber, value) {
if (sheet.getLastRow() < 2) {
return false;
}
const values = sheet.getRange(2, columnNumber, sheet.getLastRow() - 1, 1).getValues();
for (let i = 0; i < values.length; i++) {
if (String(values[i][0]) === String(value)) {
return true;
}
}
return false;
}
/*******************************************************
* 17. 設定値の取得
*******************************************************/
function oneGetSetting(name, fallback) {
const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("15 設定");
if (!sheet) {
return fallback;
}
const values = sheet.getDataRange().getValues();
for (let i = 1; i < values.length; i++) {
if (String(values[i][0]) === name) {
const value = values[i][1];
if (value ===
"" || value === null || value === undefined) {
return fallback;
}
return value;
}
}
return fallback;
}
/*******************************************************
* 18. ⽉別集計の取得（12 ⽉別集計シートから読む）
*******************************************************/
function oneGetMonthlySummary(year, month) {
if (!year || !month || month < 1 || month > 12) {
return { ok: false, error: "年⽉が正しくありません" };
}
const target = year + "
-
" + Utilities.formatString("%02d"
, month);
const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("12 ⽉別集計");
if (!sheet) {
return { ok: false, error: "12 ⽉別集計シートがありません" };
}
const values = sheet.getDataRange().getValues();
if (values.length < 2) {
return { ok: true, month: target, data: null };
}
const headers = values[0];
const monthIndex = headers.indexOf("集計⽉");
if (monthIndex === -1) {
return { ok: false, error: "集計⽉列がありません" };
}
for (let i = 1; i < values.length; i++) {
if (String(values[i][monthIndex]) === target) {
return { ok: true, month: target, data: oneArrayToObject(headers, values[i]) };
}
}
return { ok: true, month: target, data: null };
}
/*******************************************************
* 19. 未⼊⾦
*******************************************************/
function oneGetUnpaid() {
const data = oneSheetToObjects("09 請求");
return data.filter(function (row) {
const unpaid = Number(row["未⼊⾦額"]) || 0;
return unpaid > 0;
});
}
/*******************************************************
* 20. 重機‧⾞両の原価計算補助
*******************************************************/
function oneMachineCost(row) {
const rate = Number(row["⽇額/時間単価"]) || 0;
const hours = Number(row["稼働時間"]) || 0;
const fuel = Number(row["燃料費"]) || 0;
return fuel + rate * hours;
}
function oneIsVehicle(row) {
return String(row["区分"] || "").indexOf("⾞両") !== -1;
}
function oneMonthKeyFromValue(value) {
if (value === null || value === undefined || value ===
return null;
"") {
}
if (Object.prototype.toString.call(value) ===
"[object Date]") {
return Utilities.formatDate(value, Session.getScriptTimeZone(),
"yyyy-MM");
}
const text = String(value).trim();
// "2026-01-15" や "2026/01/15" のような形式を想定
const match = text.match(/^(\d{4})[-\/](\d{1,2})/);
if (match) {
return match[1] + "
-
" + Utilities.formatString("%02d"
}
, Number(match[2]));
return text.substring(0, 7);
}
/*******************************************************
* 21. 現場別利益（累計‧現在時点）
*******************************************************/
function oneGetSiteProfit(siteId) {
if (!siteId) {
return { ok: false, error: "現場IDがありません" };
}
const result = {
ok: true, 現場ID: siteId,
売上: 0, ⼈件費: 0, 外注費: 0, 材料費: 0,
重機費: 0, ⾞両費: 0, その他経費: 0,
総原価: 0, 利益: 0, 利益率: 0
};
oneSheetToObjects("04 売上").forEach(function (row) {
if (String(row["現場ID"]) === String(siteId)) {
result.売上 += Number(row["税抜売上"]) || 0;
}
});
oneSheetToObjects("06 外注費").forEach(function (row) {
if (String(row["現場ID"]) === String(siteId)) {
result.外注費 += Number(row["税抜⾦額"]) || 0;
}
});
oneSheetToObjects("07 材料費").forEach(function (row) {
if (String(row["現場ID"]) === String(siteId)) {
result.材料費 += Number(row["税抜⾦額"]) || 0;
}
});
oneSheetToObjects("05 経費").forEach(function (row) {
if (String(row["現場ID"]) === String(siteId)) {
result.その他経費 += Number(row["税抜⾦額"]) || 0;
}
});
/* 重機‧⾞両（区分に「⾞両」を含むかで振り分け） */
oneSheetToObjects("08 重機‧⾞両").forEach(function (row) {
if (String(row["稼働現場ID"]) === String(siteId)) {
const cost = oneMachineCost(row);
if (oneIsVehicle(row)) {
result.⾞両費 += cost;
} else {
result.重機費 += cost;
}
}
});
/* ⽇報 → ⼈件費 */
const reports = oneSheetToObjects("03 ⽇報");
const employees = oneSheetToObjects("01 従業員");
reports.forEach(function (report) {
if (String(report["現場ID"]) !== String(siteId)) {
return;
}
const employee = employees.find(function (emp) {
return String(emp["従業員ID"]) === String(report["従業員ID"]);
});
if (!employee) {
return;
}
const unitPrice = Number(employee["単価"]) || 0;
const labor = Number(report["⼈⼯"]) || 0;
result.⼈件費 += unitPrice * labor;
});
result.総原価 =
result.⼈件費 + result.外注費 + result.材料費 +
result.重機費 + result.⾞両費 + result.その他経費;
result.利益 = result.売上 - result.総原価;
if (result.売上 > 0) {
result.利益率 = result.利益 / result.売上;
}
return result;
}
/*******************************************************
* 22. 利益（現場×⽉）‧⽉別集計の全件再計算
*******************************************************/
function oneRecalcProfitAndMonthly() {
const ss = SpreadsheetApp.getActiveSpreadsheet();
const sites = oneSheetToObjects("02 現場");
const sales = oneSheetToObjects("04 売上");
const expenses = oneSheetToObjects("05 経費");
const subcontracts = oneSheetToObjects("06 外注費");
const materials = oneSheetToObjects("07 材料費");
const machines = oneSheetToObjects("08 重機‧⾞両");
const reports = oneSheetToObjects("03 ⽇報");
const employees = oneSheetToObjects("01 従業員");
const invoices = oneSheetToObjects("09 請求");
const payments = oneSheetToObjects("10 ⼊⾦");
const employeeById = {};
employees.forEach(function (e) {
employeeById[String(e["従業員ID"])] = e;
});
const siteById = {};
sites.forEach(function (s) {
siteById[String(s["現場ID"])] = s;
});
// key: "⽉|現場ID"
const profitMap = {};
function ensureProfit(month, siteId) {
const key = month + "|" + siteId;
if (!profitMap[key]) {
profitMap[key] = {
集計⽉: month, 現場ID: siteId,
現場名: siteById[siteId] ? siteById[siteId]["現場名"] : ""
売上: 0, ⼈件費: 0, 外注費: 0, 材料費: 0,
重機費: 0, ⾞両費: 0, その他経費: 0
,
};
}
return profitMap[key];
}
sales.forEach(function (row) {
const month = oneMonthKeyFromValue(row["⽇付"]);
const siteId = String(row["現場ID"] || "");
if (!month || !siteId) return;
ensureProfit(month, siteId).売上 += Number(row["税抜売上"]) || 0;
});
subcontracts.forEach(function (row) {
const month = oneMonthKeyFromValue(row["⽇付"]);
const siteId = String(row["現場ID"] || "");
if (!month || !siteId) return;
ensureProfit(month, siteId).外注費 += Number(row["税抜⾦額"]) || 0;
});
materials.forEach(function (row) {
const month = oneMonthKeyFromValue(row["⽇付"]);
const siteId = String(row["現場ID"] || "");
if (!month || !siteId) return;
ensureProfit(month, siteId).材料費 += Number(row["税抜⾦額"]) || 0;
});
expenses.forEach(function (row) {
const month = oneMonthKeyFromValue(row["⽇付"]);
const siteId = String(row["現場ID"] || "");
if (!month || !siteId) return;
ensureProfit(month, siteId).その他経費 += Number(row["税抜⾦額"]) || 0;
});
machines.forEach(function (row) {
const month = oneMonthKeyFromValue(row["使⽤⽇"]);
const siteId = String(row["稼働現場ID"] || "");
if (!month || !siteId) return;
const entry = ensureProfit(month, siteId);
const cost = oneMachineCost(row);
if (oneIsVehicle(row)) {
entry.⾞両費 += cost;
} else {
entry.重機費 += cost;
}
});
let laborUnitsByMonth = {};
reports.forEach(function (row) {
const month = oneMonthKeyFromValue(row["⽇付"]);
const siteId = String(row["現場ID"] || "");
if (!month || !siteId) return;
const employee = employeeById[String(row["従業員ID"])];
const unitPrice = employee ? (Number(employee["単価"]) || 0) : 0;
const labor = Number(row["⼈⼯"]) || 0;
ensureProfit(month, siteId).⼈件費 += unitPrice * labor;
laborUnitsByMonth[month] = (laborUnitsByMonth[month] || 0) + labor;
});
// 総原価‧利益‧利益率を確定
Object.keys(profitMap).forEach(function (key) {
const p = profitMap[key];
p.総原価 = p.⼈件費 + p.外注費 + p.材料費 + p.重機費 + p.⾞両費 + p.その他経費;
p.利益 = p.売上 - p.総原価;
p.利益率 = p.売上 > 0 ? p.利益 / p.売上 : 0;
p.更新⽇時 = new Date();
});
/* ---- 11 利益シートへの書き込み ---- */
const profitSheet = ss.getSheetByName("11 利益");
if (profitSheet) {
const profitHeaders = ONE
SHEETS["11 利益"];
_
const profitRows = Object.keys(profitMap)
.sort()
.map(function (key) {
const p = profitMap[key];
return profitHeaders.map(function (h) { return p[h] !== undefined ? p[h] : ""; });
});
if (profitSheet.getMaxRows() > 1) {
profitSheet
.getRange(2, 1, profitSheet.getMaxRows() - 1, profitHeaders.length)
.clearContent();
}
if (profitRows.length > 0) {
profitSheet.getRange(2, 1, profitRows.length, profitHeaders.length).setValues(profitRows);
}
}
/* ---- 12 ⽉別集計への集計‧書き込み ---- */
const monthlyMap = {};
function ensureMonthly(month) {
if (!monthlyMap[month]) {
monthlyMap[month] = {
集計⽉: month, 売上: 0, ⼈件費: 0, 外注費: 0, 材料費: 0,
重機費: 0, ⾞両費: 0, その他経費: 0,
請求額: 0, ⼊⾦額: 0, 未⼊⾦額: 0,
現場数: new Set(), ⼈⼯数: 0
};
}
return monthlyMap[month];
}
Object.keys(profitMap).forEach(function (key) {
const p = profitMap[key];
const m = ensureMonthly(p.集計⽉);
m.売上 += p.売上;
m.⼈件費 += p.⼈件費;
m.外注費 += p.外注費;
m.材料費 += p.材料費;
m.重機費 += p.重機費;
m.⾞両費 += p.⾞両費;
m.その他経費 += p.その他経費;
if (p.売上 || p.⼈件費 || p.外注費 || p.材料費 || p.重機費 || p.⾞両費 || p.その他経費) {
m.現場数.add(p.現場ID);
}
});
Object.keys(laborUnitsByMonth).forEach(function (month) {
ensureMonthly(month).⼈⼯数 += laborUnitsByMonth[month];
});
invoices.forEach(function (row) {
const month = oneMonthKeyFromValue(row["発⾏⽇"]);
if (!month) return;
ensureMonthly(month).請求額 += Number(row["請求⾦額"]) || 0;
});
payments.forEach(function (row) {
const month = oneMonthKeyFromValue(row["⼊⾦⽇"]);
if (!month) return;
ensureMonthly(month).⼊⾦額 += Number(row["⼊⾦額"]) || 0;
});
invoices.forEach(function (row) {
const month = oneMonthKeyFromValue(row["発⾏⽇"]);
if (!month) return;
ensureMonthly(month).未⼊⾦額 += Number(row["未⼊⾦額"]) || 0;
});
const monthlySheet = ss.getSheetByName("12 ⽉別集計");
if (monthlySheet) {
const monthlyHeaders = ONE
SHEETS["12 ⽉別集計"];
_
const monthlyRows = Object.keys(monthlyMap)
.sort()
.map(function (month) {
const m = monthlyMap[month];
const 総原価 = m.⼈件費 + m.外注費 + m.材料費 + m.重機費 + m.⾞両費 + m.その他経費;
const 利益 = m.売上 - 総原価;
const 利益率 = m.売上 > 0 ? 利益 / m.売上 : 0;
const record = {
集計⽉: m.集計⽉, 売上: m.売上, ⼈件費: m.⼈件費, 外注費: m.外注費,
材料費: m.材料費, 重機費: m.重機費, ⾞両費: m.⾞両費,
その他経費: m.その他経費, 総原価: 総原価, 利益: 利益, 利益率: 利益率,
請求額: m.請求額, ⼊⾦額: m.⼊⾦額, 未⼊⾦額: m.未⼊⾦額,
現場数: m.現場数.size, ⼈⼯数: Number(m.⼈⼯数.toFixed(2))
};
return monthlyHeaders.map(function (h) { return record[h] !== undefined ? record[h] : ""; });
});
if (monthlySheet.getMaxRows() > 1) {
monthlySheet
.getRange(2, 1, monthlySheet.getMaxRows() - 1, monthlyHeaders.length)
.clearContent();
if (monthlyRows.length > 0) {
monthlySheet.getRange(2, 1, monthlyRows.length, monthlyHeaders.length).setValues(monthlyRows);
}
}
}
}
/*******************************************************
* 23. APIログ
*******************************************************/
function oneWriteApiLog(body, result, message) {
try {
const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("14 APIログ");
if (!sheet) {
return;
}
const data = body || {};
sheet.appendRow([
oneCreateId(sheet,
"ログID"),
new Date(),
String(data.action || ""),
String(data.lineUserId || ""),
String(data.lineDisplayName || ""),
result,
message,
""
]);
} catch (error) {
// ログエラーは本処理を⽌めない
}
}
/*******************************************************
* 24. メニュー
*******************************************************/
function onOpen() {
SpreadsheetApp.getUi()
.createMenu("株式会社One")
.addItem("初期セットアップ"
,
.addItem("APIトークン表⽰"
,
.addItem("利益‧⽉別集計を再計算"
.addToUi();
"setupOneSystem")
"setupOneApiToken")
,
"oneRecalcProfitAndMonthly")
.addToUi();
}