"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 10 * 1024;
const TOKEN = process.env.JARVIS_API_TOKEN || "";
const SHEETS_URL = process.env.JARVIS_SHEETS_URL || "";
const SHEETS_TOKEN = process.env.JARVIS_SHEETS_TOKEN || "";

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
          let dailyReportHeaders=null;
          if (dailyName) {
            const read=await callSheets("readRows",{sheetName:dailyName,startRow:1,numRows:1});
            dailyReportHeaders=Array.isArray(read.rows)&&Array.isArray(read.rows[0])?read.rows[0]:[];
          }
          return json(res,200,{ok:true,sheets:listed.sheets,dailyReportSheetFound:Boolean(dailyName),dailyReportHeaders});
        } catch {
          return json(res,503,{ok:false,error:"metadata check failed"});
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
