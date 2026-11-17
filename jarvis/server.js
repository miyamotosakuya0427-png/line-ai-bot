"use strict";
const { initGlitchTip } = require("./core/glitchtip");
const monitoring = initGlitchTip();
const http = require("node:http");
const crypto = require("node:crypto");
const { createJobStore } = require("./core/job-store");
const { createApprovalStore } = require("./core/approval-store");
const { createWorker } = require("./core/worker");
const { createOpenAIHandler } = require("./core/openai-handler");
const { dashboardPage } = require("./dashboard");
const { EMPLOYEE_SHEET, DAILY_REPORT_SHEET, readEmployees, readDailyReports, buildCompanyOverview, filterDailyReports } = require("./core/company-reader");
const { buildDailyReportAnalytics } = require("./core/company-analytics");
const { SALES_SHEET, EXPENSE_SHEET, INVOICE_SHEET, PAYMENT_SHEET, readFinancialSheets, readReceivablesSheets } = require("./core/financial-sheet-reader");
const { DEPARTMENTS, APPROVAL } = require("./core/department-agents");
const { SUBSIDY_SOURCES, PRIORITY_TOPICS, REPORT_FIELDS } = require("./core/subsidy-monitor");
const { getVideoWorkflow } = require("./core/video-workflow");
const { createDepartmentHandlers } = require("./core/department-agent-handlers");
const { createDepartmentContextLoader } = require("./core/department-context-loader");
const { startDailyContentPlanner } = require("./core/video-scheduler");
const { startDailySubsidyMonitor } = require("./core/subsidy-scheduler");
const { createVideoBatchStore } = require("./core/video-batch-store");
const { createVideoBatchContentHandler } = require("./core/video-batch-runner");
const { createScriptMetrics } = require("./core/script-metrics");
const { createPaperTradingStore } = require("./core/paper-trading-store");
const { createBinanceJapanSpotClient } = require("./core/binance-japan-spot");
const { createBinanceJapanOrderExecutor, ACTOR: BINANCE_EXECUTOR_ACTOR } = require("./core/binance-japan-executor");
const { handleBinanceApi } = require("./core/binance-japan-api");
const { createInfluenceEventStore } = require("./core/influence-event-store");
const { createCommandCenter } = require("./core/command-center");
const { createCommandPlanner } = require("./core/command-center-planner");
const { createTaskRegistryApi } = require("./core/task-registry-api");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 24 * 1024;
const TOKEN = process.env.JARVIS_API_TOKEN || "";
const SHEETS_URL = process.env.JARVIS_SHEETS_URL || "";
const SHEETS_TOKEN = process.env.JARVIS_SHEETS_TOKEN || "";
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || "";
const LIFF_ID = process.env.LIFF_ID || "";
const JOB_STORE_PATH = process.env.JARVIS_JOB_STORE_PATH || "";
const APPROVAL_STORE_PATH = process.env.JARVIS_APPROVAL_STORE_PATH || (JOB_STORE_PATH ? JOB_STORE_PATH + ".approvals" : "");

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...extraHeaders});
  res.end(JSON.stringify(payload));
}
function isAuthorized(req, token = TOKEN) {
  if (!token || Buffer.byteLength(token,"utf8") < 32) return false;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization || "");
  if (!match) return false;
  const supplied = Buffer.from(match[1],"utf8"), expected = Buffer.from(token,"utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied,expected);
}
async function readJson(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { const e=new Error("Request body too large"); e.statusCode=413; throw e; }
    chunks.push(chunk);
  }
  if (!size) return {};
  try { const v=JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!v || typeof v!=="object" || Array.isArray(v)) throw Error(); return v; }
  catch { const e=new Error("Invalid JSON"); e.statusCode=400; throw e; }
}
function validSheetName(v) { return typeof v==="string" && v.length>0 && v.length<=100; }

async function verifyLineIdToken(idToken, channelId, fetchImpl=fetch) {
  if (typeof idToken!=="string" || idToken.length<20 || idToken.length>10000 || !channelId) {
    const e=new Error("LINE identity verification is not configured or token is invalid"); e.statusCode=400; throw e;
  }
  const body=new URLSearchParams({id_token:idToken,client_id:channelId});
  const response=await fetchImpl("https://api.line.me/oauth2/v2.1/verify",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:body.toString(),
    signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) { const e=new Error("LINE identity verification failed"); e.statusCode=401; throw e; }
  const profile=await response.json();
  if (profile.aud!==channelId || profile.iss!=="https://access.line.me" ||
      !/^U[0-9a-f]{32}$/i.test(profile.sub||"") ||
      !Number.isFinite(profile.exp) || profile.exp<=Math.floor(Date.now()/1000)) {
    const e=new Error("LINE identity token is invalid"); e.statusCode=401; throw e;
  }
  return {lineUserId:profile.sub,displayName:typeof profile.name==="string"?profile.name.slice(0,100):""};
}

function lineLinkPage(liffId) {
  const safeLiffId=JSON.stringify(liffId||"");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>株式会社One LINE連携</title><style>body{font-family:system-ui,sans-serif;background:#f5f6f8;color:#17202a;margin:0;padding:24px}main{max-width:440px;margin:8vh auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 4px 24px #0001}h1{font-size:22px}p{line-height:1.7}.muted{color:#667085;font-size:14px}select,button{width:100%;padding:14px;margin-top:12px;border-radius:9px;border:1px solid #ccd2da;font-size:16px}button{background:#182b49;color:white;border:0}button:disabled{opacity:.45}#msg{white-space:pre-wrap;margin-top:16px}</style><script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script></head><body><main><h1>株式会社One LINE連携</h1><p>自分の氏名を選んで連携申請してください。申請後、管理者が本人確認して有効化します。</p><label for="employee">従業員名</label><select id="employee" disabled><option>読み込み中…</option></select><button id="send" disabled>連携を申請</button><button id="bootstrap-admin" disabled style="background:#344054">EMP003 初回管理者登録</button><p class="muted">初回管理者登録はEMP003本人のみ実行できます。LINE公式のIDトークンをサーバーで検証します。</p><section style="margin-top:24px;border-top:1px solid #e4e7ec;padding-top:16px"><h2 style="font-size:18px">日報入力</h2><p class="muted">連携済みの本人情報を使って記録します。</p><form id="daily-report-form"><label>作業日</label><input name="workDate" type="date" required><label>現場名</label><input name="siteName" maxlength="100" required placeholder="例：岡山市○○現場"><label>作業内容</label><textarea name="workDetails" maxlength="2000" required placeholder="今日行った作業"></textarea><label>開始時刻</label><input name="startTime" type="time" required><label>終了時刻</label><input name="endTime" type="time" required><label>休憩（分）</label><input name="breakMinutes" type="number" min="0" max="600" value="60" required><label>作業人数</label><input name="workerCount" type="number" min="1" max="100" value="1" required><label>使用機械・車両</label><input name="equipment" maxlength="300" placeholder="例：バックホウ、ダンプ"><label>使用材料</label><input name="materials" maxlength="500" placeholder="例：RC30、生コン"><label>連絡事項</label><textarea name="notes" maxlength="1000"></textarea><button id="daily-report-submit" type="submit">日報を保存</button></form><p id="daily-report-message" role="status"></p></section>
<section style="margin-top:24px;border-top:1px solid #e4e7ec;padding-top:16px"><h2 style="font-size:18px">管理者メニュー</h2><button id="refresh-pending" disabled>連携申請を確認</button><div id="pending-list" aria-live="polite"></div></section><p class="muted">LINEアカウント情報はLINE公式のIDトークンをサーバーで検証して取得します。</p><div id="msg" role="status"></div></main><script>
const LIFF_ID=${safeLiffId};
const msg=document.getElementById("msg"),select=document.getElementById("employee"),button=document.getElementById("send");
const adminButton=document.getElementById("bootstrap-admin");
const refreshPendingButton=document.getElementById("refresh-pending"),pendingList=document.getElementById("pending-list");
let idToken="";
async function api(path,body){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||"通信に失敗しました");return d;}
(async()=>{try{if(!LIFF_ID){msg.textContent="LIFF_IDがまだ設定されていません。";return;}await liff.init({liffId:LIFF_ID});if(!liff.isLoggedIn()){liff.login();return;}idToken=liff.getIDToken();if(!idToken)throw new Error("LINEの本人確認情報を取得できません。LIFFのopenid設定を確認してください。");const d=await api("/v1/line/employees",{idToken});select.innerHTML='<option value="">氏名を選択してください</option>';for(const e of d.employees){const o=document.createElement("option");o.value=e.employeeId;o.textContent=e.name;select.appendChild(o);}select.disabled=false;button.disabled=false;adminButton.disabled=false;refreshPendingButton.disabled=false;}catch(e){msg.textContent=e.message;}})();
select.addEventListener("change",()=>{adminButton.disabled=!idToken||select.value!=="EMP003";});
button.addEventListener("click",async()=>{button.disabled=true;try{await api("/v1/line/link",{idToken,employeeId:select.value});msg.textContent="連携申請を受け付けました。管理者の本人確認後に利用できます。";}catch(e){msg.textContent=e.message;button.disabled=false;}});
adminButton.addEventListener("click",async()=>{if(select.value!=="EMP003"){msg.textContent="EMP003を選択してください。";return;}if(!window.confirm("LINEで本人確認を行い、EMP003を株式会社Oneの初回管理者として登録します。続行しますか？"))return;adminButton.disabled=true;try{const result=await api("/v1/line/admin/bootstrap",{idToken});msg.textContent="管理者登録が完了しました。権限："+result.role+"／状態："+result.status;}catch(e){msg.textContent=e.message;adminButton.disabled=false;}});
async function loadPending(){refreshPendingButton.disabled=true;pendingList.textContent="申請を確認しています…";try{const result=await api("/v1/line/admin/pending",{idToken});pendingList.replaceChildren();if(!result.requests.length){pendingList.textContent="承認待ちの申請はありません。";return;}for(const item of result.requests){const card=document.createElement("div");card.style.cssText="border:1px solid #d0d5dd;border-radius:10px;padding:12px;margin-top:10px";const info=document.createElement("p");info.textContent=(item.employeeName||item.employeeId)+"（"+item.employeeId+"）／LINE表示名："+(item.displayName||"未設定")+"／申請："+(item.createdAt||"日時不明");card.appendChild(info);for(const decision of ["approve","reject"]){const action=document.createElement("button");action.textContent=decision==="approve"?"承認する":"却下する";action.style.background=decision==="approve"?"#175cd3":"#b42318";action.addEventListener("click",async()=>{const label=decision==="approve"?"承認":"却下";if(!window.confirm((item.employeeName||item.employeeId)+"さんのLINE連携申請を"+label+"しますか？"))return;action.disabled=true;try{const outcome=await api("/v1/line/admin/review",{idToken,linkId:item.linkId,decision});msg.textContent="申請を"+(outcome.status==="有効"?"承認":"却下")+"しました。";await loadPending();}catch(e){msg.textContent=e.message;action.disabled=false;}});card.appendChild(action);}pendingList.appendChild(card);}}catch(e){pendingList.textContent=e.message;}finally{refreshPendingButton.disabled=false;}}
refreshPendingButton.addEventListener("click",loadPending);
const dailyForm=document.getElementById("daily-report-form"),dailySubmit=document.getElementById("daily-report-submit"),dailyMessage=document.getElementById("daily-report-message");
dailyForm.querySelector('[name="workDate"]').value=new Date().toLocaleDateString("sv-SE");
dailyForm.addEventListener("submit",async(event)=>{event.preventDefault();if(!idToken){dailyMessage.textContent="LINEの本人確認ができていません。画面を再読み込みしてください。";return;}dailySubmit.disabled=true;dailyMessage.textContent="保存しています…";const values=Object.fromEntries(new FormData(dailyForm).entries());try{const result=await api("/v1/daily-report",{idToken,...values});dailyMessage.textContent="日報を保存しました。"+result.employeeName+"さん／"+result.workDate;dailyForm.reset();dailyForm.querySelector('[name="workDate"]').value=new Date().toLocaleDateString("sv-SE");dailyForm.querySelector('[name="breakMinutes"]').value="60";dailyForm.querySelector('[name="workerCount"]').value="1";}catch(e){dailyMessage.textContent=e.message;}finally{dailySubmit.disabled=false;}});
</script></body></html>`;
}

function createServer({token=TOKEN,ownerToken=process.env.JARVIS_OWNER_TOKEN||"",sheetsUrl=SHEETS_URL,sheetsToken=SHEETS_TOKEN,lineLoginChannelId=LINE_LOGIN_CHANNEL_ID,liffId=LIFF_ID,fetchImpl=fetch,jobStore=null,approvalStore=null,videoBatchStore=null,paperTradingStore=null,influenceEventStore=null,binanceClient=null,binanceOrderExecutor=null,binanceMaxNotionalYen=5000,worker=null,departmentHandlers=null,departmentContextLoader=null,commandPlanner=null,taskRegistry=null,authorizeTaskRegistry=null,now=()=>new Date()}={}) {
  const taskRegistryApi=createTaskRegistryApi({registry:taskRegistry,authorize:authorizeTaskRegistry,json,readJson});
  async function callSheets(action, fields={}) {
    if (!sheetsUrl || !sheetsToken) { const e=new Error("Google Sheets integration is not configured"); e.statusCode=503; throw e; }
    const u=new URL(sheetsUrl);
    if (u.protocol!=="https:" || u.hostname!=="script.google.com" || !u.pathname.startsWith("/macros/s/") || !u.pathname.endsWith("/exec")) {
      const e=new Error("Google Sheets endpoint configuration is invalid"); e.statusCode=503; throw e;
    }
    const response=await fetchImpl(sheetsUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:sheetsToken,action,...fields}),signal:AbortSignal.timeout(12000)});
    if (!response.ok) { const e=new Error("Google Sheets service request failed"); e.statusCode=502; throw e; }
    const result=await response.json();
    if (!result || result.ok!==true) { const e=new Error("Google Sheets service rejected the request"); e.statusCode=result?.error==="Unauthorized"?502:400; throw e; }
    return result;
  }

  let lastPublicSheetsCheck = 0;
  return http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,"http://localhost");
      if (await taskRegistryApi(req,res,url)) return;
      if (req.method==="GET" && url.pathname==="/") {
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'","X-Frame-Options":"DENY"});
        return res.end(dashboardPage());
      }
      if (req.method==="GET" && url.pathname==="/health") return json(res,200,{ok:true,service:"ONE JARVIS",status:"running"});
      if (req.method==="GET" && url.pathname==="/health/sheets/metadata") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        const now=Date.now();
        if (now-lastPublicSheetsCheck<30000) return json(res,429,{ok:false,error:"check rate limited"});
        lastPublicSheetsCheck=now;
        try {
          const listed=await callSheets("listSheets");
          if (!Array.isArray(listed.sheets)) return json(res,502,{ok:false,error:"invalid sheet list"});
          const dailyName=listed.sheets.find(name=>name==="日報");
          const numberedDailyName=listed.sheets.find(name=>name==="03 日報");
          const employeeName=listed.sheets.find(name=>name==="01 従業員");
          const lineLinkName=listed.sheets.find(name=>name==="13 LINE連携");
          let dailyReportHeaders=null;
          let numberedDailyReportHeaders=null;
          let employeeHeaders=null;
          let lineLinkHeaders=null;
          if (dailyName) {
            const read=await callSheets("readRows",{sheetName:dailyName,startRow:1,numRows:1});
            dailyReportHeaders=Array.isArray(read.rows)&&Array.isArray(read.rows[0])?read.rows[0]:[];
          }
          if (numberedDailyName) {
            const read=await callSheets("readRows",{sheetName:numberedDailyName,startRow:1,numRows:1});
            numberedDailyReportHeaders=Array.isArray(read.rows)&&Array.isArray(read.rows[0])?read.rows[0]:[];
          }
          if (employeeName) {
            const read=await callSheets("readRows",{sheetName:employeeName,startRow:1,numRows:1});
            employeeHeaders=Array.isArray(read.rows)&&Array.isArray(read.rows[0])?read.rows[0]:[];
          }
          if (lineLinkName) {
            const read=await callSheets("readRows",{sheetName:lineLinkName,startRow:1,numRows:1});
            lineLinkHeaders=Array.isArray(read.rows)&&Array.isArray(read.rows[0])?read.rows[0]:[];
          }
          return json(res,200,{ok:true,sheets:listed.sheets,dailyReportSheetFound:Boolean(dailyName),dailyReportHeaders,numberedDailyReportSheetFound:Boolean(numberedDailyName),numberedDailyReportHeaders,employeeSheetFound:Boolean(employeeName),employeeHeaders,lineLinkSheetFound:Boolean(lineLinkName),lineLinkHeaders});
        } catch {
          return json(res,503,{ok:false,error:"metadata check failed"});
        }
      }
      if (req.method==="GET" && url.pathname==="/health/sheets/record-counts") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        const now=Date.now();
        if (now-lastPublicSheetsCheck<30000) return json(res,429,{ok:false,error:"check rate limited"});
        lastPublicSheetsCheck=now;
        try {
          const listed=await callSheets("listSheets");
          const targets=[
            {key:"employee",name:"01 従業員"},
            {key:"dailyReport",name:"03 日報"}
          ];
          const counts={};
          for (const target of targets) {
            const sheetName=Array.isArray(listed.sheets)?listed.sheets.find(name=>name===target.name):null;
            if (!sheetName) {
              counts[target.key]={sheetFound:false};
              continue;
            }
            const read=await callSheets("readRows",{sheetName,startRow:2,numRows:100});
            const rows=Array.isArray(read.rows)?read.rows:[];
            const populated=rows.filter(row=>Array.isArray(row)&&row.some(value=>value!==null&&value!==undefined&&String(value).trim()!==""));
            counts[target.key]={sheetFound:true,sampledRows:rows.length,populatedRows:populated.length,sampleLimit:100,limitedToFirst100:true};
          }
          return json(res,200,{ok:true,...counts});
        } catch {
          return json(res,503,{ok:false,error:"record count check failed"});
        }
      }
      if (req.method==="GET" && url.pathname==="/health/sheets/link-status") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        const now=Date.now();
        if (now-lastPublicSheetsCheck<30000) return json(res,429,{ok:false,error:"check rate limited"});
        lastPublicSheetsCheck=now;
        try {
          const listed=await callSheets("listSheets");
          const sheetName=Array.isArray(listed.sheets)?listed.sheets.find(name=>name==="13 LINE連携"):null;
          if (!sheetName) return json(res,200,{ok:true,sheetFound:false});
          const read=await callSheets("readRows",{sheetName,startRow:2,numRows:100});
          const rows=Array.isArray(read.rows)?read.rows:[];
          const nonEmpty=value=>value!==null&&value!==undefined&&String(value).trim()!=="";
          const withLineUserId=rows.filter(row=>Array.isArray(row)&&nonEmpty(row[1]));
          const withEmployeeId=rows.filter(row=>Array.isArray(row)&&nonEmpty(row[3]));
          const linked=rows.filter(row=>Array.isArray(row)&&nonEmpty(row[1])&&nonEmpty(row[3]));
          return json(res,200,{ok:true,sheetFound:true,sampleLimit:100,sampledRows:rows.length,rowsWithLineUserId:withLineUserId.length,rowsWithEmployeeId:withEmployeeId.length,linkedRows:linked.length,missingEmployeeId:withLineUserId.length-linked.length,limitedToFirst100:true});
        } catch {
          return json(res,503,{ok:false,error:"link status check failed"});
        }
      }
      if (req.method==="GET" && url.pathname==="/health/sheets") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        const now=Date.now();
        if (now-lastPublicSheetsCheck<30000) return json(res,429,{ok:false,googleSheets:"check rate limited"});
        lastPublicSheetsCheck=now;
        try {
          const listed=await callSheets("listSheets");
          if (!Array.isArray(listed.sheets) || listed.sheets.length===0) {
            return json(res,200,{ok:true,googleSheets:"connected",sheetCount:0,readTest:"no sheets found"});
          }
          const targetSheet=listed.sheets[0];
          const read=await callSheets("readRows",{sheetName:targetSheet,startRow:1,numRows:1});
          const firstRow=Array.isArray(read.rows)&&Array.isArray(read.rows[0])?read.rows[0]:[];
          return json(res,200,{ok:true,googleSheets:"connected",sheetCount:listed.sheets.length,readTest:"success",rowsRead:Array.isArray(read.rows)?read.rows.length:0,columnsRead:firstRow.length});
        } catch {
          return json(res,503,{ok:false,googleSheets:"not connected",readTest:"failed"});
        }
      }
      if (req.method==="GET" && url.pathname==="/line-link") {
        return res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.line-scdn.net 'unsafe-inline'; connect-src 'self' https://api.line.me; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self' https://liff.line.me"}).end(lineLinkPage(liffId));
      }
      if (req.method==="POST" && (url.pathname==="/v1/line/employees" || url.pathname==="/v1/line/link")) {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        if (!lineLoginChannelId) return json(res,503,{ok:false,error:"LINE Login channel is not configured"});
        const d=await readJson(req);
        const identity=await verifyLineIdToken(d.idToken,lineLoginChannelId,fetchImpl);
        if (url.pathname==="/v1/line/employees") {
          const listed=await callSheets("listSheets");
          if (!Array.isArray(listed.sheets)||!listed.sheets.includes("01 従業員")) return json(res,503,{ok:false,error:"Employee sheet is unavailable"});
          const result=await callSheets("readRows",{sheetName:"01 従業員",startRow:1,numRows:100});
          const employees=(Array.isArray(result.rows)?result.rows.slice(1):[])
            .filter(row=>Array.isArray(row)&&String(row[0]||"").trim()&&String(row[1]||"").trim()&&String(row[9]||"有効").trim()!=="無効")
            .map(row=>({employeeId:String(row[0]).trim(),name:String(row[1]).trim()}));
          return json(res,200,{ok:true,employees});
        }
        const employeeId=typeof d.employeeId==="string"?d.employeeId.trim():"";
        if (!employeeId || employeeId.length>20) return json(res,400,{ok:false,error:"Invalid employee ID"});
        const listed=await callSheets("listSheets");
        if (!Array.isArray(listed.sheets)||!listed.sheets.includes("01 従業員")||!listed.sheets.includes("13 LINE連携")) return json(res,503,{ok:false,error:"Required sheets are unavailable"});
        const employees=await callSheets("readRows",{sheetName:"01 従業員",startRow:1,numRows:100});
        const employeeRows=Array.isArray(employees.rows)?employees.rows:[];
        const employee=employeeRows.slice(1).find(row=>Array.isArray(row)&&String(row[0]||"").trim()===employeeId);
        if (!employee) return json(res,404,{ok:false,error:"Employee ID not found"});
        const links=await callSheets("readRows",{sheetName:"13 LINE連携",startRow:1,numRows:100});
        const linkRows=Array.isArray(links.rows)?links.rows:[];
        const byLine=linkRows.slice(1).find(row=>Array.isArray(row)&&String(row[1]||"").trim()===identity.lineUserId);
        if (byLine) {
          if (String(byLine[3]||"").trim()===employeeId) return json(res,200,{ok:true,submitted:true,alreadySubmitted:true,status:String(byLine[7]||"確認待ち")});
          return json(res,409,{ok:false,error:"このLINEアカウントは別の従業員に登録済みです"});
        }
        const byEmployee=linkRows.slice(1).find(row=>Array.isArray(row)&&String(row[3]||"").trim()===employeeId);
        if (byEmployee) return json(res,409,{ok:false,error:"この従業員はすでに別のLINEアカウントで申請または登録されています。管理者に確認してください"});
        const row=["PENDING-"+crypto.randomUUID(),identity.lineUserId,identity.displayName,employeeId,String(employee[1]||"").trim(),"","一般","確認待ち",new Date().toISOString(),new Date().toISOString()];
        const appended=await callSheets("appendRows",{sheetName:"13 LINE連携",rows:[row]});
        return json(res,201,{ok:true,submitted:true,alreadySubmitted:false,status:"確認待ち",appended:appended.appended||1});
      }
      // 日報保存: LINE本人確認に加え、13 LINE連携で有効な本人の従業員IDを照合する。
      if (req.method==="POST" && url.pathname==="/v1/daily-report") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        if (!lineLoginChannelId) return json(res,503,{ok:false,error:"LINE Login channel is not configured"});
        const d=await readJson(req);
        const identity=await verifyLineIdToken(d.idToken,lineLoginChannelId,fetchImpl);
        const workDate=typeof d.workDate==="string"?d.workDate.trim():"";
        const siteName=typeof d.siteName==="string"?d.siteName.trim():"";
        const workDetails=typeof d.workDetails==="string"?d.workDetails.trim():"";
        const startTime=typeof d.startTime==="string"?d.startTime.trim():"";
        const endTime=typeof d.endTime==="string"?d.endTime.trim():"";
        const breakMinutes=Number(d.breakMinutes);
        const workerCount=Number(d.workerCount);
        const equipment=typeof d.equipment==="string"?d.equipment.trim():"";
        const materials=typeof d.materials==="string"?d.materials.trim():"";
        const notes=typeof d.notes==="string"?d.notes.trim():"";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)||Number.isNaN(Date.parse(workDate))||new Date(workDate+"T00:00:00Z").toISOString().slice(0,10)!==workDate||
            !siteName||siteName.length>100||!workDetails||workDetails.length>2000||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)||
            !Number.isInteger(breakMinutes)||breakMinutes<0||breakMinutes>600||
            !Number.isInteger(workerCount)||workerCount<1||workerCount>100||
            equipment.length>300||materials.length>500||notes.length>1000) {
          return json(res,400,{ok:false,error:"入力内容を確認してください"});
        }
        const linked=await callSheets("readRows",{sheetName:"13 LINE連携",startRow:1,numRows:100});
        const rows=Array.isArray(linked.rows)?linked.rows:[];
        const header=rows[0]||[];
        const lineCol=header.indexOf("LINEユーザーID"),employeeCol=header.indexOf("従業員ID"),nameCol=4,statusCol=header.indexOf("状態");
        if ([lineCol,employeeCol,nameCol,statusCol].some(i=>i<0)) return json(res,503,{ok:false,error:"LINE連携シートの見出しを確認してください"});
        const ownLink=rows.slice(1).find(row=>Array.isArray(row)&&String(row[lineCol]||"").trim()===identity.lineUserId&&String(row[statusCol]||"").trim()==="有効");
        if (!ownLink) return json(res,403,{ok:false,error:"有効な従業員LINE連携が必要です。管理者に確認してください。"});
        const employeeId=String(ownLink[employeeCol]||"").trim(),employeeName=String(ownLink[nameCol]||"").trim();
        if (!employeeId||!employeeName) return json(res,403,{ok:false,error:"従業員情報を確認できません。管理者に確認してください。"});
        const reportId="DR-"+crypto.randomUUID();
        const saved=await callSheets("appendDailyReport",{report:{
          reportId,recordedAt:new Date().toISOString(),workDate,employeeId,employeeName,siteName,workDetails,
          startTime,endTime,breakMinutes,workerCount,equipment,materials,notes
        }});
        return json(res,201,{ok:true,reportId,employeeName,workDate,saved:saved.saved===true});
      }
      // 初回管理者登録: LINE公式IDトークンで本人確認し、EMP003の本人の申請だけを対象にする。
      if (req.method==="POST" && url.pathname==="/v1/line/admin/bootstrap") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        if (!lineLoginChannelId) return json(res,503,{ok:false,error:"LINE Login channel is not configured"});
        const d=await readJson(req);
        const identity=await verifyLineIdToken(d.idToken,lineLoginChannelId,fetchImpl);
        const result=await callSheets("bootstrapAdmin",{lineUserId:identity.lineUserId,employeeId:"EMP003"});
        return json(res,200,{ok:true,status:result.status,role:result.role});
      }
      // 管理者本人をLINE IDトークンで検証し、13 LINE連携の承認待ち一覧だけを返す。
      if (req.method==="POST" && url.pathname==="/v1/line/admin/pending") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        if (!lineLoginChannelId) return json(res,503,{ok:false,error:"LINE Login channel is not configured"});
        const d=await readJson(req);
        const identity=await verifyLineIdToken(d.idToken,lineLoginChannelId,fetchImpl);
        const listed=await callSheets("listSheets");
        if (!Array.isArray(listed.sheets)||!listed.sheets.includes("13 LINE連携")) return json(res,503,{ok:false,error:"LINE link sheet is unavailable"});
        const read=await callSheets("readRows",{sheetName:"13 LINE連携",startRow:1,numRows:100});
        const rows=Array.isArray(read.rows)?read.rows:[];
        const isAdmin=rows.slice(1).some(row=>Array.isArray(row)&&String(row[1]||"").trim()===identity.lineUserId&&String(row[6]||"").trim()==="管理者"&&String(row[7]||"").trim()==="有効");
        if (!isAdmin) return json(res,403,{ok:false,error:"管理者権限が必要です"});
        const requests=rows.slice(1).filter(row=>Array.isArray(row)&&String(row[7]||"").trim()==="確認待ち"&&String(row[0]||"").trim()).map(row=>({linkId:String(row[0]).trim(),displayName:String(row[2]||"").trim(),employeeId:String(row[3]||"").trim(),employeeName:String(row[4]||"").trim(),createdAt:String(row[8]||"").trim()}));
        return json(res,200,{ok:true,requests});
      }
      // 審査: 管理者のLINE公式IDトークンを検証し、検証済みsubだけをApps Scriptへ渡す。
      if (req.method==="POST" && url.pathname==="/v1/line/admin/review") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        if (!lineLoginChannelId) return json(res,503,{ok:false,error:"LINE Login channel is not configured"});
        const d=await readJson(req);
        const identity=await verifyLineIdToken(d.idToken,lineLoginChannelId,fetchImpl);
        const linkId=typeof d.linkId==="string"?d.linkId.trim():"";
        const decision=typeof d.decision==="string"?d.decision.trim():"";
        if (!linkId || linkId.length>100 || !["approve","reject"].includes(decision)) return json(res,400,{ok:false,error:"Invalid review request"});
        const result=await callSheets("reviewLineLink",{adminLineUserId:identity.lineUserId,linkId,decision});
        return json(res,200,{ok:true,linkId:result.linkId,status:result.status});
      }
      const ownerApprovalRoute=url.pathname==="/v1/approvals" || /^\/v1\/approvals\/[0-9a-f-]{36}\/decision$/.test(url.pathname);
      if (!ownerApprovalRoute && !isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
      if (req.method==="POST" && url.pathname==="/v1/company/ask") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        if (!jobStore) return json(res,503,{ok:false,error:"Persistent job storage is not configured"});
        const d=await readJson(req);
        if (typeof d.request!=="string" || !d.request.trim() || d.request.length>4000 ||
            (d.idempotencyKey!==undefined && (typeof d.idempotencyKey!=="string" || d.idempotencyKey.length>128))) {
          return json(res,400,{ok:false,error:"Invalid company question"});
        }
        const listed=await callSheets("listSheets");
        if (!Array.isArray(listed.sheets) || !listed.sheets.includes(DAILY_REPORT_SHEET)) return json(res,503,{ok:false,error:"Daily report sheet is not available"});
        const daily=await callSheets("readRows",{sheetName:DAILY_REPORT_SHEET,startRow:1,numRows:100});
        const reports=readDailyReports(daily.rows);
        const companyContext={dailyReportAnalytics:buildDailyReportAnalytics(reports),source:"Google Sheets / 03 日報",sampleLimit:99};
        if (listed.sheets.includes(SALES_SHEET) && listed.sheets.includes(EXPENSE_SHEET)) {
          const [sales,expenses]=await Promise.all([
            callSheets("readRows",{sheetName:SALES_SHEET,startRow:1,numRows:100}),
            callSheets("readRows",{sheetName:EXPENSE_SHEET,startRow:1,numRows:100})
          ]);
          companyContext.financialSummary=readFinancialSheets({salesRows:sales.rows,expenseRows:expenses.rows});
          if (listed.sheets.includes(INVOICE_SHEET) && listed.sheets.includes(PAYMENT_SHEET)) {
            const [invoices,payments]=await Promise.all([
              callSheets("readRows",{sheetName:INVOICE_SHEET,startRow:1,numRows:100}),
              callSheets("readRows",{sheetName:PAYMENT_SHEET,startRow:1,numRows:100})
            ]);
            companyContext.receivablesSummary=readReceivablesSheets({invoiceRows:invoices.rows,paymentRows:payments.rows,asOfDate:now().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"})});
          }
        } else {
          companyContext.financialDataStatus="売上・経費シートが見つからないため、財務数値は回答対象外です。";
        }
        const created=await jobStore.create({type:"assistant.company_question",payload:{request:d.request.trim(),companyContext},idempotencyKey:d.idempotencyKey||""});
        return json(res,created.created?201:200,{ok:true,created:created.created,job:created.job});
      }
      if (url.pathname==="/v1/company/overview" || url.pathname==="/v1/company/daily-reports" || url.pathname==="/v1/company/employees" || url.pathname==="/v1/company/analytics" || url.pathname==="/v1/company/financials") {
        if (req.method!=="GET") return json(res,405,{ok:false,error:"Method Not Allowed"},{Allow:"GET"});
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        try {
          const listed=await callSheets("listSheets");
          if (!Array.isArray(listed.sheets)) return json(res,502,{ok:false,error:"Invalid sheet list"});
          if (url.pathname==="/v1/company/employees") {
            if (!listed.sheets.includes(EMPLOYEE_SHEET)) return json(res,404,{ok:false,error:"Employee sheet not found"});
            const read=await callSheets("readRows",{sheetName:EMPLOYEE_SHEET,startRow:1,numRows:100});
            return json(res,200,{ok:true,employees:readEmployees(read.rows),sampleLimit:99});
          }
          if (url.pathname==="/v1/company/financials") {
            if (!listed.sheets.includes(SALES_SHEET) || !listed.sheets.includes(EXPENSE_SHEET)) return json(res,404,{ok:false,error:"売上・経費シートが見つかりません",availableSheets:listed.sheets});
            const [sales,expenses]=await Promise.all([
              callSheets("readRows",{sheetName:SALES_SHEET,startRow:1,numRows:100}),
              callSheets("readRows",{sheetName:EXPENSE_SHEET,startRow:1,numRows:100})
            ]);
            const financials=readFinancialSheets({salesRows:sales.rows,expenseRows:expenses.rows});
            if (listed.sheets.includes(INVOICE_SHEET) && listed.sheets.includes(PAYMENT_SHEET)) {
              const [invoices,payments]=await Promise.all([
                callSheets("readRows",{sheetName:INVOICE_SHEET,startRow:1,numRows:100}),
                callSheets("readRows",{sheetName:PAYMENT_SHEET,startRow:1,numRows:100})
              ]);
              financials.receivables=readReceivablesSheets({invoiceRows:invoices.rows,paymentRows:payments.rows,asOfDate:now().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"})});
            } else {
              financials.receivablesStatus="請求・入金シートが見つからないため、未収金集計は未接続です。";
            }
            return json(res,200,{ok:true,financials});
          }
          if (!listed.sheets.includes(DAILY_REPORT_SHEET)) return json(res,404,{ok:false,error:"Daily report sheet not found"});
          const daily=await callSheets("readRows",{sheetName:DAILY_REPORT_SHEET,startRow:1,numRows:100});
          const reports=readDailyReports(daily.rows);
          if (url.pathname==="/v1/company/analytics") return json(res,200,{ok:true,analytics:buildDailyReportAnalytics(reports),sampleLimit:99});
          if (url.pathname==="/v1/company/daily-reports") {
            const rawLimit=url.searchParams.get("limit");
            const limit=rawLimit===null?20:Number(rawLimit);
            const from=url.searchParams.get("from")||undefined;
            const to=url.searchParams.get("to")||undefined;
            const filtered=filterDailyReports(reports,{from,to,limit});
            return json(res,200,{ok:true,reports:filtered,sampleLimit:99,returned:filtered.length});
          }
          if (!listed.sheets.includes(EMPLOYEE_SHEET)) return json(res,404,{ok:false,error:"Employee sheet not found"});
          const employees=await callSheets("readRows",{sheetName:EMPLOYEE_SHEET,startRow:1,numRows:100});
          return json(res,200,{ok:true,...buildCompanyOverview({employeeRows:employees.rows,dailyReportRows:daily.rows}),sampleLimit:99});
        } catch(error) {
          if (error.code==="INVALID_QUERY") return json(res,400,{ok:false,error:error.message});
          if (error.code==="SHEET_SCHEMA_MISMATCH" || error.code==="SHEET_DATA_UNAVAILABLE") return json(res,503,{ok:false,error:"Company sheet schema or data is not ready"});
          return json(res,503,{ok:false,error:"Company data is temporarily unavailable"});
        }
      }
      const departmentTaskMatch=/^\/v1\/departments\/([a-z]+)\/tasks$/.exec(url.pathname);
      if ((departmentTaskMatch && req.method==="POST") || (url.pathname==="/v1/content/tasks" && req.method==="POST")) {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!jobStore) return json(res,503,{ok:false,error:"Persistent job storage is not configured"});
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req), departmentId=url.pathname==="/v1/content/tasks"?"content":departmentTaskMatch[1];
        if (!DEPARTMENTS.some(item=>item.id===departmentId) || typeof d.request!=="string" || !d.request.trim() || d.request.length>4000 || (d.idempotencyKey!==undefined && (typeof d.idempotencyKey!=="string" || d.idempotencyKey.length>128))) return json(res,400,{ok:false,error:"Invalid department task"});
        let companyContext=null;
        if (departmentId==="construction" && /日報|現場|作業|稼働|人数|機械|重機/.test(d.request)) {
          try {
            const listed=await callSheets("listSheets");
            if (!Array.isArray(listed.sheets) || !listed.sheets.includes(DAILY_REPORT_SHEET)) {
              companyContext={dailyReportDataStatus:"日報シートが未接続。現場実績を推測しないでください。"};
            } else {
              const daily=await callSheets("readRows",{sheetName:DAILY_REPORT_SHEET,startRow:1,numRows:100});
              const reports=readDailyReports(daily.rows);
              companyContext={dailyReportAnalytics:buildDailyReportAnalytics(reports)};
            }
          } catch(error) {
            companyContext={dailyReportDataStatus:"日報の読み取りまたは見出し検証に失敗。実績値を推測しないでください。",schemaErrorCode:error.code||"UNAVAILABLE"};
          }
        }
        if ((departmentId==="tax"||departmentId==="management") && /売上|経費|請求|入金|利益|会計|税務|資金繰り/.test(d.request)) {
          try {
            const listed=await callSheets("listSheets");
            if (!Array.isArray(listed.sheets) || !listed.sheets.includes(SALES_SHEET) || !listed.sheets.includes(EXPENSE_SHEET)) {
              companyContext={financialDataStatus:"売上・経費シートが未接続。数値を推測せず、必要なデータを明示してください。"};
            } else {
              const sales=await callSheets("readRows",{sheetName:SALES_SHEET,startRow:1,numRows:100});
              const expenses=await callSheets("readRows",{sheetName:EXPENSE_SHEET,startRow:1,numRows:100});
              const financials=readFinancialSheets({salesRows:sales.rows,expenseRows:expenses.rows});
              companyContext={financials};
              if (listed.sheets.includes(INVOICE_SHEET)&&listed.sheets.includes(PAYMENT_SHEET)) {
                const invoices=await callSheets("readRows",{sheetName:INVOICE_SHEET,startRow:1,numRows:100});
                const payments=await callSheets("readRows",{sheetName:PAYMENT_SHEET,startRow:1,numRows:100});
                const asOfDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(now());
                companyContext.receivables=readReceivablesSheets({invoiceRows:invoices.rows,paymentRows:payments.rows,asOfDate});
              } else {
                companyContext.receivablesStatus="請求・入金シートは未接続。売上・経費集計とは分けて確認してください。";
              }
            }
          } catch(error) {
            companyContext={financialDataStatus:"財務シートの読み取りまたは見出し検証に失敗。数値を推測せず、管理者確認が必要です。",schemaErrorCode:error.code||"UNAVAILABLE"};
          }
        }
        const payload={request:d.request.trim(),departmentId};
        if(companyContext)payload.companyContext=companyContext;
        const result=await jobStore.create({type:"department."+departmentId,payload,idempotencyKey:d.idempotencyKey||""});
        return json(res,result.created?201:200,{ok:true,created:result.created,departmentId,job:result.job});
      }
      if (url.pathname==="/v1/approvals" || new RegExp("^/v1/approvals/[0-9a-f-]{36}/decision$").test(url.pathname)) {
        if (!approvalStore) return json(res,503,{ok:false,error:"Persistent approval storage is not configured"});
        if (req.method==="GET" && url.pathname==="/v1/approvals") {
          if (!isAuthorized(req,ownerToken)) return json(res,ownerToken?401:503,{ok:false,error:ownerToken?"Owner authentication required":"Owner authentication is not configured"},ownerToken?{"WWW-Authenticate":"Bearer"}:{});
          const status=url.searchParams.get("status")||undefined;
          const limit=Number(url.searchParams.get("limit")||50);
          if ((status&& !["pending","approved","rejected"].includes(status))||!Number.isInteger(limit)||limit<1||limit>200) return json(res,400,{ok:false,error:"Invalid approval list parameters"});
          const approvals=await approvalStore.list({status,limit});
          return json(res,200,{ok:true,approvals,executionEnabled:false});
        }
        if (req.method==="POST" && url.pathname==="/v1/approvals") {
          if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          if (typeof d.departmentId!=="string"||!DEPARTMENTS.some(item=>item.id===d.departmentId)||typeof d.actionClass!=="string"||
              typeof d.summary!=="string"||!d.summary.trim()||d.summary.length>300||
              (d.details!==undefined&&(typeof d.details!=="string"||d.details.length>8000))||
              (d.idempotencyKey!==undefined&&(typeof d.idempotencyKey!=="string"||d.idempotencyKey.length>128))) return json(res,400,{ok:false,error:"Invalid approval request"});
          if (!["external_submit","financial","contract","publish","delete","permission_change","unknown"].includes(d.actionClass)) return json(res,400,{ok:false,error:"This action class does not require owner approval"});
          const hasExecutionBinding=d.resourceId!==undefined||d.operationPayload!==undefined||d.expiresAt!==undefined;
          if(hasExecutionBinding&&(typeof d.resourceId!=="string"||!d.resourceId.trim()||d.resourceId.length>256||!d.operationPayload||typeof d.operationPayload!=="object"||Array.isArray(d.operationPayload)||Buffer.byteLength(JSON.stringify(d.operationPayload),"utf8")>16*1024||typeof d.expiresAt!=="string"||!Number.isFinite(Date.parse(d.expiresAt))||Date.parse(d.expiresAt)<=now().getTime()))return json(res,400,{ok:false,error:"Approval execution binding requires a resource ID, JSON payload under 16 KB, and future expiry"});
          const result=await approvalStore.create({departmentId:d.departmentId,actionClass:d.actionClass,summary:d.summary,details:d.details||"",idempotencyKey:d.idempotencyKey||"",resourceId:hasExecutionBinding?d.resourceId:"",operationPayload:hasExecutionBinding?d.operationPayload:null,expiresAt:hasExecutionBinding?d.expiresAt:null});
          return json(res,result.created?201:200,{ok:true,created:result.created,approval:result.approval,executionEnabled:false,message:"承認記録のみを保存しました。外部送信・公開・支払い等は実行していません。"});
        }
        const match=new RegExp("^/v1/approvals/([0-9a-f-]{36})/decision$").exec(url.pathname);
        if (req.method==="POST"&&match) {
          if (!isAuthorized(req,ownerToken)) return json(res,ownerToken?401:503,{ok:false,error:ownerToken?"Owner authentication required":"Owner authentication is not configured"},ownerToken?{"WWW-Authenticate":"Bearer"}:{});
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          if (!["approved","rejected"].includes(d.decision)||(d.reason!==undefined&&(typeof d.reason!=="string"||d.reason.length>1000))) return json(res,400,{ok:false,error:"Invalid approval decision"});
          const approval=await approvalStore.decide(match[1],d.decision,{reason:d.reason||"",actor:"owner-api"});
          if (!approval) return json(res,404,{ok:false,error:"Approval not found"});
          return json(res,200,{ok:true,approval,executionEnabled:false,message:d.decision==="approved"?"承認を記録しました。外部処理は別途接続・実行が必要です。":"却下を記録しました。外部処理は実行していません。"});
        }
        return json(res,404,{ok:false,error:"Not Found"});
      }
      if (url.pathname.startsWith("/v1/jobs")) {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!jobStore) return json(res,503,{ok:false,error:"Persistent job storage is not configured"});
        if (req.method==="GET" && url.pathname==="/v1/jobs") {
          const status=url.searchParams.get("status")||undefined;
          const limit=Number(url.searchParams.get("limit")||50);
          if ((status && !["queued","running","succeeded","failed","cancelled"].includes(status)) || !Number.isInteger(limit) || limit<1 || limit>200) {
            return json(res,400,{ok:false,error:"Invalid job list parameters"});
          }
          const jobs=await jobStore.list({status,limit});
          return json(res,200,{ok:true,jobs});
        }
        if (req.method==="POST" && url.pathname==="/v1/jobs") {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          if (d.type!=="assistant.request" || !d.payload || typeof d.payload!=="object" || Array.isArray(d.payload) ||
              typeof d.payload.request!=="string" || !d.payload.request.trim() || d.payload.request.length>4000 ||
              (d.idempotencyKey!==undefined && (typeof d.idempotencyKey!=="string" || d.idempotencyKey.length>128))) {
            return json(res,400,{ok:false,error:"Invalid job request"});
          }
          const result=await jobStore.create({type:d.type,payload:{request:d.payload.request.trim()},idempotencyKey:d.idempotencyKey||""});
          return json(res,result.created?201:200,{ok:true,created:result.created,job:result.job});
        }
        const match=/^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(cancel|retry))?$/.exec(url.pathname);
        if (match && req.method==="GET" && !match[2]) {
          const job=await jobStore.get(match[1]);
          return job?json(res,200,{ok:true,job}):json(res,404,{ok:false,error:"Job not found"});
        }
        if (match && req.method==="POST" && match[2]) {
          const job=await jobStore.get(match[1]);
          if (!job) return json(res,404,{ok:false,error:"Job not found"});
          if (match[2]==="cancel" && ["queued","failed"].includes(job.status)) {
            const updated=await jobStore.transition(job.id,"cancelled");
            return json(res,200,{ok:true,job:updated});
          }
          if (match[2]==="retry" && job.status==="failed") {
            const updated=await jobStore.transition(job.id,"queued");
            return json(res,200,{ok:true,job:updated});
          }
          return json(res,409,{ok:false,error:"Job cannot be changed from its current state"});
        }
        return json(res,404,{ok:false,error:"Not Found"});
      }
      if (url.pathname.startsWith("/v1/signals/influence")) {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!influenceEventStore) return json(res,503,{ok:false,error:"Persistent influence event storage is not configured"});
        if (req.method==="GET" && url.pathname==="/v1/signals/influence/events") {
          const limit=Number(url.searchParams.get("limit")||100),platform=url.searchParams.get("platform")||undefined,actor=url.searchParams.get("actor")||undefined,since=url.searchParams.get("since")||undefined;
          if (!Number.isInteger(limit)||limit<1||limit>500) return json(res,400,{ok:false,error:"Invalid event limit"});
          return json(res,200,{ok:true,mode:"archive-only",realMoneyTradingEnabled:false,events:await influenceEventStore.list({limit,platform,actor,since})});
        }
        if (req.method==="POST" && url.pathname==="/v1/signals/influence/events") {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          const result=await influenceEventStore.add({...d,verification:"unverified"});
          return json(res,result.created?201:200,{ok:true,created:result.created,event:result.event,analysisQueued:false,realMoneyTradingEnabled:false});
        }
        return json(res,404,{ok:false,error:"Not Found"});
      }
      if (await handleBinanceApi({req,res,url,client:binanceClient,executor:binanceOrderExecutor,approvalStore,token,ownerToken,json,readJson,isAuthorized,now,maxNotionalYen:binanceMaxNotionalYen})) return;
      if (url.pathname.startsWith("/v1/trading/")) {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!paperTradingStore) return json(res,503,{ok:false,error:"Persistent paper-trading storage is not configured"});
        if (req.method==="GET" && url.pathname==="/v1/trading/status") return json(res,200,{ok:true,mode:"paper-only",realMoneyTradingEnabled:false,brokerConnected:false,report:await paperTradingStore.analyze(),risk:await paperTradingStore.riskState()});
        if (req.method==="GET" && url.pathname==="/v1/trading/report") return json(res,200,{ok:true,report:await paperTradingStore.analyze()});
        if (req.method==="GET" && url.pathname==="/v1/trading/trades") {
          const status=url.searchParams.get("status")||undefined,limit=Number(url.searchParams.get("limit")||100);
          if ((status&&!["open","closed"].includes(status))||!Number.isInteger(limit)||limit<1||limit>1000) return json(res,400,{ok:false,error:"Invalid trade list parameters"});
          return json(res,200,{ok:true,trades:await paperTradingStore.listTrades({status,limit})});
        }
        if (req.method==="GET" && url.pathname==="/v1/trading/snapshots") {
          const symbol=url.searchParams.get("symbol")||undefined,limit=Number(url.searchParams.get("limit")||100);
          if (!Number.isInteger(limit)||limit<1||limit>1000) return json(res,400,{ok:false,error:"Invalid snapshot limit"});
          return json(res,200,{ok:true,snapshots:await paperTradingStore.listSnapshots({symbol,limit})});
        }
        if (req.method==="POST" && ["/v1/trading/snapshots","/v1/trading/trades","/v1/trading/lessons"].includes(url.pathname)) {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          if (url.pathname==="/v1/trading/snapshots") return json(res,201,{ok:true,snapshot:await paperTradingStore.recordSnapshot(d)});
          if (url.pathname==="/v1/trading/trades") return json(res,201,{ok:true,trade:await paperTradingStore.openPaperTrade(d)});
          return json(res,201,{ok:true,lesson:await paperTradingStore.recordLesson(d)});
        }
        const closeMatch=/^\/v1\/trading\/trades\/([A-Za-z0-9._:-]{1,100})\/close$/.exec(url.pathname);
        if (req.method==="POST"&&closeMatch) {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          return json(res,200,{ok:true,report:await paperTradingStore.closePaperTrade({...d,id:closeMatch[1]})});
        }
        return json(res,404,{ok:false,error:"Not Found"});
      }
      const videoDraftMatch=new RegExp("^/v1/content/videos/(V[0-9]{2,8})/draft$").exec(url.pathname);
      if(req.method==="POST"&&videoDraftMatch){
        if(!isAuthorized(req,token))return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if(!videoBatchStore||!jobStore)return json(res,503,{ok:false,error:"Persistent video and job storage are required"});
        if(!req.headers["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req);
        if(typeof d.jobId!=="string"||d.jobId.length>200)return json(res,400,{ok:false,error:"A valid draft job ID is required"});
        const job=await jobStore.get(d.jobId);
        if(!job||job.type!=="department.content"||job.payload?.videoId!==videoDraftMatch[1]||job.payload?.taskKind!=="video-batch-plan")return json(res,404,{ok:false,error:"Matching ONE CONTENT draft job not found"});
        if(job.status!=="succeeded"||typeof job.result?.answer!=="string")return json(res,409,{ok:false,error:"Draft job must succeed before its result can be saved"});
        const result=await videoBatchStore.saveDraft(videoDraftMatch[1],{script:job.result.answer,jobId:job.id});
        if(!result)return json(res,404,{ok:false,error:"Video not found"});
        return json(res,result.created?201:200,{ok:true,created:result.created,video:result.video,sourceVerificationStatus:"needs_source_review",externalActionsEnabled:false});
      }
      const videoPlanMatch=/^\/v1\/content\/videos\/(V[0-9]{2,8})\/plan$/.exec(url.pathname);
      if (videoPlanMatch && req.method==="GET") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!videoBatchStore || !jobStore) return json(res,503,{ok:false,error:"Persistent video and job storage are required"});
        const video=await videoBatchStore.get(videoPlanMatch[1]);
        if (!video) return json(res,404,{ok:false,error:"Video not found"});
        const job=await jobStore.getByIdempotencyKey("video-batch-plan-"+video.id);
        return json(res,200,{ok:true,videoId:video.id,job:job||null});
      }
      if (req.method==="POST" && videoPlanMatch) {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!videoBatchStore || !jobStore) return json(res,503,{ok:false,error:"Persistent video and job storage are required"});
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req);
        const video=await videoBatchStore.get(videoPlanMatch[1]);
        if (!video) return json(res,404,{ok:false,error:"Video not found"});
        if (video.stage!=="research" || video.status!=="planned") return json(res,409,{ok:false,error:"Only a planned video at the research stage can be sent to the content agent"});
        const request=[
          "ONE CONTENT 動画企画・台本下書きタスクです。",
          "動画ID："+video.id,
          "チャンネル："+(video.channelId==="history"?"時をかける日本史":"金融・投資解説（公開先未設定・公開禁止）"),
          "タイトル案："+video.title,
          "テーマ："+video.topic,
          "形式："+video.format,
          "目標尺：日本史チャンネルは8〜12分。内容に応じて構成と想定文字数を示す。",
          video.script?"既存台本案：\n"+video.script:"既存台本はありません。構成とナレーション原稿の初稿を作成してください。",
          "必須成果物：企画意図・視聴者像・冒頭フック・章立て・ナレーション原稿・字幕用テキスト・難読漢字/固有名詞の読み一覧・出典候補一覧（実在を確認できるURLのみ）・映像素材案・編集指示・タイトル/説明文案・未解決事項。",
          "重要：この実行環境で一次資料の本文を実際に閲覧していない場合、史実・年号・人物・金額を『検証済み』と書かない。各主張に『要一次資料確認』を付け、出典URLを捏造しない。既知の出典候補と確認済み事実を明確に分ける。",
          "YouTube収益化方針：各動画に固有の調査・論点・ナラティブ・独自解説・教育的価値を持たせる。題材名だけを差し替えたテンプレ大量生産や、他サイトの文章を読むだけの動画にしない。公式方針：https://support.google.com/youtube/answer/1311392?hl=ja",
          "AI開示方針：AIによる台本・構成・タイトル・サムネイル補助だけなら通常開示不要。一方、実在人物を偽装する、実在の場所や出来事に見える写実的なAI映像を生成・改変する、主題となるAI生成音楽を使う場合は投稿時の開示要否を確認する。再現映像を実際の記録映像として示さない。公式方針：https://support.google.com/youtube/answer/14328491?hl=ja",
          "禁止：有料音声/動画生成、外部アップロード、予約投稿、YouTube公開、購入、契約。台本・企画の下書きだけを作成し、外部操作は行わない。"
        ].join("\n");
        const result=await jobStore.create({type:"department.content",payload:{request,departmentId:"content",videoId:video.id,taskKind:"video-batch-plan"},idempotencyKey:"video-batch-plan-"+video.id});
        return json(res,result.created?201:200,{ok:true,created:result.created,videoId:video.id,job:result.job,workerEnabled:Boolean(worker),externalActionsEnabled:false});
      }
      const scriptMetricsMatch=/^\/v1\/content\/videos\/(V[0-9]{2,8})\/script-metrics$/.exec(url.pathname);
      if(req.method==="GET"&&scriptMetricsMatch){
        if(!isAuthorized(req,token))return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if(!videoBatchStore)return json(res,503,{ok:false,error:"Persistent video batch storage is not configured"});
        const video=await videoBatchStore.get(scriptMetricsMatch[1]);
        if(!video)return json(res,404,{ok:false,error:"Video not found"});
        return json(res,200,{ok:true,videoId:video.id,scriptMetrics:createScriptMetrics(video.script||"")});
      }
      if (url.pathname.startsWith("/v1/content/batches") || url.pathname.startsWith("/v1/content/approvals") || url.pathname.startsWith("/v1/content/videos/")) {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!videoBatchStore) return json(res,503,{ok:false,error:"Persistent video batch storage is not configured"});
        if (req.method==="GET" && url.pathname==="/v1/content/batches") {
          const limit=Number(url.searchParams.get("limit")||200),channelId=url.searchParams.get("channelId")||undefined,status=url.searchParams.get("status")||undefined;
          if (!Number.isInteger(limit)||limit<1||limit>200) return json(res,400,{ok:false,error:"Invalid video list limit"});
          const [videos,summary]=await Promise.all([videoBatchStore.list({limit,channelId,status}),videoBatchStore.summary()]);
          const withJobs=await Promise.all(videos.map(async video=>({...video,planJob:jobStore?await jobStore.getByIdempotencyKey("video-batch-plan-"+video.id):null,scriptMetrics:createScriptMetrics(video.script||"")})));
          return json(res,200,{ok:true,videos:withJobs,summary});
        }
        if (req.method==="POST" && url.pathname==="/v1/content/batches") {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          const result=await videoBatchStore.createBatch({items:d.items,idempotencyKey:d.idempotencyKey||""});
          return json(res,result.created?201:200,{ok:true,...result});
        }
        if (req.method==="GET" && url.pathname==="/v1/content/approvals") {
          const videos=await videoBatchStore.list({limit:200});
          const pending=videos.filter(p=>["awaiting_owner_review","on_hold"].includes(p.status));
          return json(res,200,{ok:true,pending,reviews:await videoBatchStore.listReviews(),actionApprovals:await videoBatchStore.listActionApprovals()});
        }
        const stageMatch=new RegExp("^/v1/content/videos/(V[0-9]{2,8})/stage$").exec(url.pathname);
        if (req.method==="POST" && stageMatch) {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req),updated=await videoBatchStore.updateStage(stageMatch[1],d.stage,{notes:d.notes||"",evidence:d.evidence||{}});
          return updated?json(res,200,{ok:true,video:updated}):json(res,404,{ok:false,error:"Video not found"});
        }
        const reviewMatch=new RegExp("^/v1/content/videos/(V[0-9]{2,8})/review$").exec(url.pathname);
        if (req.method==="POST" && reviewMatch) {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req),updated=await videoBatchStore.decideReview(reviewMatch[1],{decision:d.decision,note:d.note||"",actor:"owner-api"});
          return updated?json(res,200,{ok:true,video:updated}):json(res,404,{ok:false,error:"Video not found"});
        }
        const actionMatch=new RegExp("^/v1/content/videos/(V[0-9]{2,8})/action-approval$").exec(url.pathname);
        if (req.method==="POST" && actionMatch) {
          if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req),approval=await videoBatchStore.approveAction(actionMatch[1],{action:d.action,provider:d.provider,costEstimate:d.costEstimate,destination:d.destination,actor:"owner-api"});
          return approval?json(res,201,{ok:true,approval}):json(res,404,{ok:false,error:"Video not found"});
        }
        return json(res,404,{ok:false,error:"Not Found"});
      }
      if (req.method==="GET" && url.pathname==="/v1/content/workflow") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        return json(res,200,{ok:true,workflow:getVideoWorkflow({autoplanEnabled:Boolean(worker&&process.env.JARVIS_CONTENT_AUTOPLAN_ENABLED==="true")})});
      }
      if (req.method==="GET" && (url.pathname==="/v1/departments" || url.pathname==="/v1/subsidy/sources")) {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (url.pathname==="/v1/departments") return json(res,200,{ok:true,departments:DEPARTMENTS,approvalPolicy:APPROVAL});
        return json(res,200,{ok:true,sources:SUBSIDY_SOURCES,priorityTopics:PRIORITY_TOPICS,reportFields:REPORT_FIELDS,monitoringEnabled:Boolean(worker&&process.env.JARVIS_SUBSIDY_AUTOMONITOR_ENABLED==="true"),monitoringSchedule:"08:30 Asia/Tokyo",monitoringNote:worker&&process.env.JARVIS_SUBSIDY_AUTOMONITOR_ENABLED==="true"?"毎日公式サイトを取得し、担当AIが確認できる状態です。":"定期調査はJARVIS_WORKER_ENABLED=trueとJARVIS_SUBSIDY_AUTOMONITOR_ENABLED=trueの設定後に有効化されます。"});
      }
      if (url.pathname==="/v1/command-center" || url.pathname==="/v1/command-center/dispatch" || url.pathname==="/v1/command-center/plan") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        const commandCenter=createCommandCenter({jobStore,approvalStore,worker,departmentHandlers,departmentContextLoader,clock:()=>now().toISOString()});
        if(req.method==="GET"&&url.pathname==="/v1/command-center"){
          return json(res,200,{ok:true,...await commandCenter.snapshot()});
        }
        if(req.method==="POST"&&(url.pathname==="/v1/command-center/dispatch"||url.pathname==="/v1/command-center/plan")){
          if(!req.headers["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
          const d=await readJson(req);
          if(typeof d.request!=="string"||!d.request.trim()||d.request.length>4000||(d.idempotencyKey!==undefined&&(typeof d.idempotencyKey!=="string"||d.idempotencyKey.length>100)))return json(res,400,{ok:false,error:"Invalid command-center request"});
          try{
            if(url.pathname==="/v1/command-center/plan"){
              if(!commandPlanner)return json(res,503,{ok:false,error:"AI command planner is not configured"});
              const plan=await commandPlanner.plan({request:d.request});
              const result=await commandCenter.dispatch({request:d.request,departmentIds:plan.departmentIds,actionClass:plan.actionClass,idempotencyKey:d.idempotencyKey||""});
              return json(res,200,{...result,plan:{departmentIds:plan.departmentIds,actionClass:plan.actionClass,rationale:plan.rationale,model:plan.model||null}});
            }
            if(!Array.isArray(d.departmentIds)||(d.actionClass!==undefined&&typeof d.actionClass!=="string"))return json(res,400,{ok:false,error:"Invalid command-center dispatch request"});
            const result=await commandCenter.dispatch(d);
            return json(res,200,result);
          }catch(error){const status=Number.isInteger(error.statusCode)?error.statusCode:(url.pathname==="/v1/command-center/plan"?502:400);return json(res,status,{ok:false,error:error.message});}
        }
        return json(res,405,{ok:false,error:"Method Not Allowed"},{Allow:"GET, POST"});
      }
      if (req.method==="GET" && url.pathname==="/v1/status") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        return json(res,200,{ok:true,system:"ONE JARVIS",version:"1.3.0",mode:"read-only",googleSheetsConfigured:Boolean(sheetsUrl&&sheetsToken),jobQueueConfigured:Boolean(jobStore),workerEnabled:Boolean(worker),contentAutoplanEnabled:Boolean(worker&&process.env.JARVIS_CONTENT_AUTOPLAN_ENABLED==="true"),subsidyAutomonitorEnabled:Boolean(worker&&process.env.JARVIS_SUBSIDY_AUTOMONITOR_ENABLED==="true"),approvalsConfigured:Boolean(approvalStore)});
      }
      if (req.method==="GET" && url.pathname==="/v1/sheets/list") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        const r=await callSheets("listSheets"); return json(res,200,{ok:true,sheets:r.sheets});
      }
      if (req.method==="GET" && url.pathname==="/v1/sheets/read") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        const sheetName=url.searchParams.get("sheetName")||"", startRow=Number(url.searchParams.get("startRow")||1), numRows=Number(url.searchParams.get("numRows")||20);
        if (!validSheetName(sheetName) || !Number.isInteger(startRow) || startRow<1 || !Number.isInteger(numRows) || numRows<1 || numRows>100) return json(res,400,{ok:false,error:"Invalid read parameters"});
        const r=await callSheets("readRows",{sheetName,startRow,numRows}); return json(res,200,{ok:true,rows:r.rows});
      }
      if (req.method==="POST" && url.pathname==="/v1/sheets/append") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req);
        if (!validSheetName(d.sheetName)||!Array.isArray(d.rows)||d.rows.length<1||d.rows.length>50||!d.rows.every(row=>Array.isArray(row)&&row.length>=1&&row.length<=20&&row.every(v=>["string","number","boolean"].includes(typeof v)||v===null))) return json(res,400,{ok:false,error:"Invalid append payload"});
        const r=await callSheets("appendRows",{sheetName:d.sheetName,rows:d.rows}); return json(res,200,{ok:true,appended:r.appended});
      }
      if (req.method==="POST" && url.pathname==="/v1/command") {
        if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req), command=typeof d.command==="string"?d.command.trim().toLowerCase():"";
        if (command==="help") return json(res,200,{ok:true,message:"利用できるコマンド: help, status"});
        if (command==="status") return json(res,200,{ok:true,message:"ONE JARVIS is running.",mode:"read-only"});
        return json(res,400,{ok:false,message:"このコマンドはまだ利用できません。"});
      }
      if (req.method!=="GET"&&req.method!=="POST") return json(res,405,{ok:false,error:"Method Not Allowed"},{Allow:"GET, POST"});
      return json(res,404,{ok:false,error:"Not Found"});
    } catch(error) {
      if (Number.isInteger(error.statusCode) ? error.statusCode >= 500 : true) {
        try { monitoring.captureException(error); } catch (monitoringError) { console.error("GlitchTip capture failed."); }
      }
      if (res.headersSent) return res.destroy();
      const status=Number.isInteger(error.statusCode)?error.statusCode:500;
      return json(res,status,{ok:false,error:status===500?"Internal Server Error":error.message});
    }
  });
}
if (require.main===module) {
  (async()=>{
    if (!TOKEN||Buffer.byteLength(TOKEN,"utf8")<32) throw new Error("JARVIS_API_TOKEN must be configured with at least 32 bytes.");
    let postgresPool=null;
    let jobStore=null,approvalStore=null;
    if(process.env.JARVIS_STORAGE_MODE==="postgres"){
      if(!process.env.DATABASE_URL)throw new Error("PostgreSQL storage mode requires DATABASE_URL.");
      const {createNeonPool,createPostgresEventStore}=require("./core/postgres-event-store");
      const {createPostgresOperationalStores}=require("./core/postgres-operational-stores");
      postgresPool=createNeonPool({connectionString:process.env.DATABASE_URL});
      const eventStore=createPostgresEventStore({pool:postgresPool});
      await eventStore.migrate();
      const authorizeBinanceActor=actor=>actor===BINANCE_EXECUTOR_ACTOR&&process.env.JARVIS_BINANCE_LIVE_ORDERS_ENABLED==="true"&&Buffer.byteLength(process.env.JARVIS_OWNER_TOKEN||"","utf8")>=32;
      const operational=createPostgresOperationalStores({pool:postgresPool,authorizeActor:authorizeBinanceActor});
      jobStore=operational.jobs;approvalStore=operational.approvals;
      await jobStore.init();await approvalStore.init();
    }else{
      jobStore=JOB_STORE_PATH?createJobStore({filePath:JOB_STORE_PATH}):null;
      approvalStore=APPROVAL_STORE_PATH?createApprovalStore({filePath:APPROVAL_STORE_PATH,authorizeActor:actor=>actor===BINANCE_EXECUTOR_ACTOR&&process.env.JARVIS_BINANCE_LIVE_ORDERS_ENABLED==="true"&&Buffer.byteLength(process.env.JARVIS_OWNER_TOKEN||"","utf8")>=32}):null;
    }
    let taskRegistry=null,authorizeTaskRegistry=null;
    if(process.env.JARVIS_TASK_REGISTRY_API_ENABLED==="true"){
      if(!postgresPool)throw new Error("Task Registry API requires JARVIS_STORAGE_MODE=postgres.");
      const {createTaskRegistry}=require("./core/task-registry-store");
      const {createTaskRegistryAuthorizer}=require("./core/task-registry-auth");
      taskRegistry=createTaskRegistry({pool:postgresPool});
      await taskRegistry.init(); // Read-only schema check; migration 0004 is never applied here.
      authorizeTaskRegistry=createTaskRegistryAuthorizer();
    }
    const videoBatchStore=JOB_STORE_PATH?createVideoBatchStore({filePath:JOB_STORE_PATH+".video-batches.jsonl"}):null;
    const paperTradingStore=JOB_STORE_PATH?createPaperTradingStore({filePath:JOB_STORE_PATH+".paper-trading.jsonl"}):null;
    if(paperTradingStore)await paperTradingStore.init();
    const influenceEventStore=JOB_STORE_PATH?createInfluenceEventStore({filePath:JOB_STORE_PATH+".influence-events.jsonl"}):null;
    const binanceEnabled=process.env.JARVIS_BINANCE_ENABLED==="true";
    const binanceClient=binanceEnabled?createBinanceJapanSpotClient({apiKey:process.env.JARVIS_BINANCE_API_KEY||"",secret:process.env.JARVIS_BINANCE_API_SECRET||"",baseUrl:process.env.JARVIS_BINANCE_BASE_URL||"https://api.binance.com"}):null;
    const binanceMaxNotionalYen=Number(process.env.JARVIS_BINANCE_MAX_ORDER_JPY||5000);
    if(!Number.isSafeInteger(binanceMaxNotionalYen)||binanceMaxNotionalYen<1||binanceMaxNotionalYen>1000000)throw new Error("JARVIS_BINANCE_MAX_ORDER_JPY must be an integer between 1 and 1000000.");
    const binanceOrderExecutor=binanceClient&&approvalStore?createBinanceJapanOrderExecutor({
      client:binanceClient,approvalStore,
      enabled:process.env.JARVIS_BINANCE_LIVE_ORDERS_ENABLED==="true"&&process.env.JARVIS_BINANCE_RISK_GATE_ENABLED==="true"&&binanceClient.configured,
      ownerAuthReady:Buffer.byteLength(process.env.JARVIS_OWNER_TOKEN||"","utf8")>=32,
      maxNotionalYen:binanceMaxNotionalYen,
      authorizeRisk:async({notionalYen})=>{
        if(process.env.JARVIS_BINANCE_RISK_GATE_ENABLED!=="true")return{allowed:false,reason:"RISK_GATE_DISABLED"};
        const account=await binanceClient.account();
        const yen=(account.balances||[]).find(item=>item.asset==="JPY");
        const free=Number(yen?.free||0);
        return{allowed:Number.isFinite(free)&&free>=notionalYen*1.01,availableJpy:free,requiredJpy:Math.ceil(notionalYen*1.01)};
      }
    }):null;
    if(influenceEventStore)await influenceEventStore.init();
    if(videoBatchStore)await videoBatchStore.init();
    if(process.env.JARVIS_STORAGE_MODE!=="postgres"&&approvalStore)await approvalStore.init();
    const workerEnabled=process.env.JARVIS_WORKER_ENABLED==="true";
    if (workerEnabled && (!jobStore || !process.env.OPENAI_API_KEY)) throw new Error("Worker requires JARVIS_JOB_STORE_PATH and OPENAI_API_KEY.");
    const departmentContextLoader=createDepartmentContextLoader({sheetsUrl:SHEETS_URL,sheetsToken:SHEETS_TOKEN});
    const departmentHandlers=createDepartmentHandlers({store:jobStore,contextLoader:departmentContextLoader});
    if(videoBatchStore&&departmentHandlers["department.content"]) departmentHandlers["department.content"]=createVideoBatchContentHandler({contentHandler:departmentHandlers["department.content"],videoBatchStore});
    const worker=workerEnabled?createWorker({store:jobStore,handlers:{"assistant.request":createOpenAIHandler(),"assistant.company_question":createOpenAIHandler(),...departmentHandlers}}):null;
    if (worker) { await worker.start(); worker.startPolling({intervalMs:Number(process.env.JARVIS_WORKER_POLL_MS||1500)}); }
    const contentScheduler=worker&&process.env.JARVIS_CONTENT_AUTOPLAN_ENABLED==="true"?startDailyContentPlanner({store:jobStore}):null;
    const subsidyScheduler=worker&&process.env.JARVIS_SUBSIDY_AUTOMONITOR_ENABLED==="true"?startDailySubsidyMonitor({store:jobStore}):null;
    const commandPlanner=createCommandPlanner();
    const server=createServer({jobStore,approvalStore,videoBatchStore,paperTradingStore,influenceEventStore,binanceClient,binanceOrderExecutor,binanceMaxNotionalYen,worker,departmentHandlers,departmentContextLoader,commandPlanner,taskRegistry,authorizeTaskRegistry}); server.requestTimeout=15000; server.headersTimeout=10000; server.keepAliveTimeout=5000;
    const shutdown=signal=>{ console.log(`Received ${signal}; shutting down.`); if(subsidyScheduler)subsidyScheduler.stop(); if(contentScheduler)contentScheduler.stop(); if(worker)worker.stop(); server.close(async error=>{if(error){console.error("Graceful shutdown failed.");process.exit(1);}if(postgresPool){try{await postgresPool.end();}catch{console.error("Database pool shutdown failed.");}}process.exit(0);}); setTimeout(()=>process.exit(1),10000).unref(); };
    process.on("SIGTERM",()=>shutdown("SIGTERM")); process.on("SIGINT",()=>shutdown("SIGINT"));
    server.listen(PORT,"0.0.0.0",()=>console.log(`ONE JARVIS running on port ${PORT}`));
  })().catch(error=>{console.error(process.env.JARVIS_STORAGE_MODE==="postgres"?"ONE JARVIS startup failed; check PostgreSQL configuration and connectivity.":error.message);process.exit(1);});
}
module.exports={createServer,isAuthorized,readJson};
