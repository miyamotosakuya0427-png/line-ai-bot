"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 10 * 1024;
const TOKEN = process.env.JARVIS_API_TOKEN || "";
const SHEETS_URL = process.env.JARVIS_SHEETS_URL || "";
const SHEETS_TOKEN = process.env.JARVIS_SHEETS_TOKEN || "";
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || "";
const LIFF_ID = process.env.LIFF_ID || "";

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
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>株式会社One LINE連携</title><style>body{font-family:system-ui,sans-serif;background:#f5f6f8;color:#17202a;margin:0;padding:24px}main{max-width:440px;margin:8vh auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 4px 24px #0001}h1{font-size:22px}p{line-height:1.7}.muted{color:#667085;font-size:14px}select,button{width:100%;padding:14px;margin-top:12px;border-radius:9px;border:1px solid #ccd2da;font-size:16px}button{background:#182b49;color:white;border:0}button:disabled{opacity:.45}#msg{white-space:pre-wrap;margin-top:16px}</style><script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script></head><body><main><h1>株式会社One LINE連携</h1><p>自分の氏名を選んで連携申請してください。申請後、管理者が本人確認して有効化します。</p><label for="employee">従業員名</label><select id="employee" disabled><option>読み込み中…</option></select><button id="send" disabled>連携を申請</button><p class="muted">LINEアカウント情報はLINE公式のIDトークンをサーバーで検証して取得します。</p><div id="msg" role="status"></div></main><script>
const LIFF_ID=${safeLiffId};
const msg=document.getElementById("msg"),select=document.getElementById("employee"),button=document.getElementById("send");
let idToken="";
async function api(path,body){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||"通信に失敗しました");return d;}
(async()=>{try{if(!LIFF_ID){msg.textContent="LIFF_IDがまだ設定されていません。";return;}await liff.init({liffId:LIFF_ID});if(!liff.isLoggedIn()){liff.login();return;}idToken=liff.getIDToken();if(!idToken)throw new Error("LINEの本人確認情報を取得できません。LIFFのopenid設定を確認してください。");const d=await api("/v1/line/employees",{idToken});select.innerHTML='<option value="">氏名を選択してください</option>';for(const e of d.employees){const o=document.createElement("option");o.value=e.employeeId;o.textContent=e.name;select.appendChild(o);}select.disabled=false;button.disabled=false;}catch(e){msg.textContent=e.message;}})();
button.addEventListener("click",async()=>{button.disabled=true;try{await api("/v1/line/link",{idToken,employeeId:select.value});msg.textContent="連携申請を受け付けました。管理者の本人確認後に利用できます。";}catch(e){msg.textContent=e.message;button.disabled=false;}});
</script></body></html>`;
}

function createServer({token=TOKEN,sheetsUrl=SHEETS_URL,sheetsToken=SHEETS_TOKEN,fetchImpl=fetch}={}) {
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
      if (req.method==="GET" && url.pathname==="/health") return json(res,200,{ok:true,service:"ONE JARVIS",status:"running"});
      if (req.method==="GET" && url.pathname==="/health/sheets/metadata") {
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
        return res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.line-scdn.net 'unsafe-inline'; connect-src 'self' https://api.line.me; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self' https://liff.line.me"}).end(lineLinkPage(LIFF_ID));
      }
      if (req.method==="POST" && (url.pathname==="/v1/line/employees" || url.pathname==="/v1/line/link")) {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        if (!LINE_LOGIN_CHANNEL_ID) return json(res,503,{ok:false,error:"LINE Login channel is not configured"});
        const d=await readJson(req);
        const identity=await verifyLineIdToken(d.idToken,LINE_LOGIN_CHANNEL_ID,fetchImpl);
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
      if (!isAuthorized(req,token)) return json(res,token?401:503,{ok:false,error:token?"Unauthorized":"Authentication is not configured"},token?{"WWW-Authenticate":"Bearer"}:{});
      if (req.method==="GET" && url.pathname==="/v1/status") return json(res,200,{ok:true,system:"ONE JARVIS",version:"1.2.0",mode:"read-only",googleSheetsConfigured:Boolean(sheetsUrl&&sheetsToken)});
      if (req.method==="GET" && url.pathname==="/v1/sheets/list") {
        const r=await callSheets("listSheets"); return json(res,200,{ok:true,sheets:r.sheets});
      }
      if (req.method==="GET" && url.pathname==="/v1/sheets/read") {
        const sheetName=url.searchParams.get("sheetName")||"", startRow=Number(url.searchParams.get("startRow")||1), numRows=Number(url.searchParams.get("numRows")||20);
        if (!validSheetName(sheetName) || !Number.isInteger(startRow) || startRow<1 || !Number.isInteger(numRows) || numRows<1 || numRows>100) return json(res,400,{ok:false,error:"Invalid read parameters"});
        const r=await callSheets("readRows",{sheetName,startRow,numRows}); return json(res,200,{ok:true,rows:r.rows});
      }
      if (req.method==="POST" && url.pathname==="/v1/sheets/append") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req);
        if (!validSheetName(d.sheetName)||!Array.isArray(d.rows)||d.rows.length<1||d.rows.length>50||!d.rows.every(row=>Array.isArray(row)&&row.length>=1&&row.length<=20&&row.every(v=>["string","number","boolean"].includes(typeof v)||v===null))) return json(res,400,{ok:false,error:"Invalid append payload"});
        const r=await callSheets("appendRows",{sheetName:d.sheetName,rows:d.rows}); return json(res,200,{ok:true,appended:r.appended});
      }
      if (req.method==="POST" && url.pathname==="/v1/command") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return json(res,415,{ok:false,error:"Content-Type must be application/json"});
        const d=await readJson(req), command=typeof d.command==="string"?d.command.trim().toLowerCase():"";
        if (command==="help") return json(res,200,{ok:true,message:"利用できるコマンド: help, status"});
        if (command==="status") return json(res,200,{ok:true,message:"ONE JARVIS is running.",mode:"read-only"});
        return json(res,400,{ok:false,message:"このコマンドはまだ利用できません。"});
      }
      if (req.method!=="GET"&&req.method!=="POST") return json(res,405,{ok:false,error:"Method Not Allowed"},{Allow:"GET, POST"});
      return json(res,404,{ok:false,error:"Not Found"});
    } catch(error) {
      if (res.headersSent) return res.destroy();
      const status=Number.isInteger(error.statusCode)?error.statusCode:500;
      return json(res,status,{ok:false,error:status===500?"Internal Server Error":error.message});
    }
  });
}
if (require.main===module) {
  if (!TOKEN||Buffer.byteLength(TOKEN,"utf8")<32) { console.error("JARVIS_API_TOKEN must be configured with at least 32 bytes."); process.exit(1); }
  const server=createServer(); server.requestTimeout=15000; server.headersTimeout=10000; server.keepAliveTimeout=5000;
  server.listen(PORT,"0.0.0.0",()=>console.log(`ONE JARVIS running on port ${PORT}`));
  const shutdown=signal=>{ console.log(`Received ${signal}; shutting down.`); server.close(error=>{if(error){console.error("Graceful shutdown failed.");process.exit(1);}process.exit(0);}); setTimeout(()=>process.exit(1),10000).unref(); };
  process.on("SIGTERM",()=>shutdown("SIGTERM")); process.on("SIGINT",()=>shutdown("SIGINT"));
}
module.exports={createServer,isAuthorized,readJson};
