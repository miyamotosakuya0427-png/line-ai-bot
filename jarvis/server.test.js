"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./server");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {createVideoBatchStore,STAGES}=require("./core/video-batch-store");

const token = "test-token-that-is-at-least-32-bytes-long";
const STAGE_EVIDENCE={
 sourceQa:{status:"passed",allClaimsVerified:true,verifiedClaimCount:4,primarySourceCount:2,reviewedBy:"test-reviewer"},
 pronunciation:{status:"passed",readingsReviewed:true,termsChecked:8,reviewedBy:"test-reviewer"},
 narration:{status:"recorded",durationSeconds:600,voiceName:"Hinata",voiceConfirmed:true,recordedBy:"test-recorder"},
 assets:{status:"cleared",assetCount:5,rightsConfirmed:true,clearedBy:"test-editor"},
 edit:{status:"rendered",projectId:"072f8671-af62-480c-8072-bb253faf58b7",compositionId:"cd7b6796-23cc-43a7-ae7c-c2e3cfb50d32",durationSeconds:600},
 finalQa:{status:"passed",checklistPassed:true,openIssues:0,durationSeconds:600,checkedBy:"test-reviewer"}
};
async function advanceToOwnerReview(store,id,{fromSourceQa=false}={}){
 if(!fromSourceQa){await store.saveDraft(id,{script:"台本初稿。出典と読みを確認する。",jobId:"server-test-"+id});await store.updateStage(id,"source_qa");}
 await store.updateStage(id,"pronunciation",{evidence:{sourceQa:STAGE_EVIDENCE.sourceQa}});
 await store.updateStage(id,"narration",{evidence:{pronunciation:STAGE_EVIDENCE.pronunciation}});
 await store.updateStage(id,"assets",{evidence:{narration:STAGE_EVIDENCE.narration}});
 await store.updateStage(id,"edit",{evidence:{assets:STAGE_EVIDENCE.assets}});
 await store.updateStage(id,"final_qa",{evidence:{edit:STAGE_EVIDENCE.edit}});
 await store.updateStage(id,"owner_review",{evidence:{finalQa:STAGE_EVIDENCE.finalQa}});
}

let server;
let base;

test.before(async () => {
  server = createServer({ ownerToken: token, token });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
});

test("health endpoint is public and reports running", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "running");
});

test("protected status rejects missing token", async () => {
  const response = await fetch(`${base}/v1/status`);
  assert.equal(response.status, 401);
});

test("protected status accepts valid token", async () => {
  const response = await fetch(`${base}/v1/status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "read-only");
});


test("private Sheets and status endpoints reject unauthenticated requests", async () => {
  const cases = [
    ["GET", "/v1/status"],
    ["GET", "/v1/sheets/list"],
    ["GET", "/v1/sheets/read?sheetName=01%20%E5%BE%93%E6%A5%AD%E5%93%A1"],
    ["POST", "/v1/sheets/append"],
    ["GET", "/health/sheets"],
    ["POST", "/v1/command"]
  ];
  for (const [method, path] of cases) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify({ command: "status", sheetName: "01 従業員", rows: [["x"]] }) : undefined
    });
    assert.equal(response.status, 401, `${method} ${path} must require bearer auth`);
  }
});

test("command endpoint requires JSON", async () => {
  const response = await fetch(`${base}/v1/command`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: "command=status"
  });
  assert.equal(response.status, 415);
});

test("command endpoint accepts status command", async () => {
  const response = await fetch(`${base}/v1/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ command: "status" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "read-only");
});

test("unknown commands are rejected", async () => {
  const response = await fetch(`${base}/v1/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ command: "delete-everything" })
  });
  assert.equal(response.status, 400);
});

test("unknown routes are not found", async () => {
  const response = await fetch(`${base}/missing`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 404);
});


test("LIFF page is served without exposing server credentials", async () => {
  const app=createServer({ ownerToken: token,token, liffId:"1234567890-AbCdEfGh"});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/line-link`);
    const html=await response.text();
    assert.equal(response.status,200);
    assert.match(html,/株式会社One LINE連携/);
    assert.match(html,/employee-id/);
    assert.match(html,/pendingDailyReportId/);
    assert.doesNotMatch(html,/\/v1\/line\/employees/);
    assert.match(html,/1234567890-AbCdEfGh/);
    assert.doesNotMatch(html,/JARVIS_API_TOKEN|JARVIS_SHEETS_TOKEN/);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("LINE linking verifies ID token and stores only a pending approval", async () => {
  const sent=[];
  const app=createServer({ ownerToken: token,
    token,
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"h".repeat(128),
    fetchImpl:async(url,options)=>{
      if(url==="https://api.line.me/oauth2/v2.1/verify") {
        assert.equal(options.method,"POST");
        const form=new URLSearchParams(options.body);
        assert.equal(form.get("id_token"),"verified-test-token-1");
        assert.equal(form.get("client_id"),"1234567890");
        return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:"U"+"a".repeat(32),exp:Math.floor(Date.now()/1000)+300,name:"テスト利用者"})};
      }
      const body=JSON.parse(options.body); sent.push(body);
      if(body.action==="listSheets") return {ok:true,json:async()=>({ok:true,sheets:["01 従業員","13 LINE連携"]})};
      if(body.action==="readRows"&&body.sheetName==="01 従業員") return {ok:true,json:async()=>({ok:true,rows:[["従業員ID","氏名"],["EMP001","信原 晴"]]})};
      if(body.action==="readRows"&&body.sheetName==="13 LINE連携") return {ok:true,json:async()=>({ok:true,rows:[["連携ID","LINEユーザーID","LINE表示名","従業員ID"]]})};
      if(body.action==="appendLineLink") return {ok:true,json:async()=>({ok:true,appended:1,status:"確認待ち"})};
      return {ok:true,json:async()=>({ok:false,error:"unexpected action"})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/link`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"verified-test-token-1",employeeId:"EMP001"})
    });
    const result=await response.json();
    assert.equal(response.status,201);
    assert.equal(result.status,"確認待ち");
    const write=sent.find(x=>x.action==="appendLineLink");
    assert.equal(write.lineUserId,"U"+"a".repeat(32));
    assert.equal(write.employeeId,"EMP001");
    assert.equal(write.employeeName,"信原 晴");
    assert.equal(write.role,undefined);
    assert.equal(write.status,undefined);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("daily report requires an active LINE link and appends a validated report", async () => {
  const sent=[];
  const app=createServer({ ownerToken: token,
    token,lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",sheetsToken:"r".repeat(128),
    fetchImpl:async(url,options)=>{
      if(url==="https://api.line.me/oauth2/v2.1/verify") return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:"U"+"a".repeat(32),exp:Math.floor(Date.now()/1000)+300,name:"テスト"})};
      const body=JSON.parse(options.body);sent.push(body);
      if(body.action==="readRows") return {ok:true,json:async()=>({ok:true,rows:[
        ["連携ID","LINEユーザーID","LINE表示名","従業員ID","氏名","","権限","状態"],
        ["LINK-1","U"+"a".repeat(32),"テスト","EMP003","宮本朔也","","管理者","有効"]
      ]})};
      if(body.action==="appendDailyReport") return {ok:true,json:async()=>({ok:true,saved:true})};
      throw new Error("unexpected action");
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/daily-report`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"verified-test-token-123456",reportId:"DR-123e4567-e89b-12d3-a456-426614174000",workDate:"2026-11-15",siteName:"岡山現場",workDetails:"掘削作業",startTime:"08:00",endTime:"17:00",breakMinutes:"60",workerCount:"3",equipment:"バックホウ",materials:"RC30",notes:""})
    });
    const result=await response.json();
    assert.equal(response.status,201);
    assert.equal(result.employeeName,"宮本朔也");
    const write=sent.find(x=>x.action==="appendDailyReport");
    assert.equal(write.report.employeeId,"EMP003");
    assert.equal(write.report.reportId,"DR-123e4567-e89b-12d3-a456-426614174000");
    assert.equal(write.report.lineUserId,"U"+"a".repeat(32));
    assert.equal(write.report.workDetails,"掘削作業");
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("LINE linking rejects an unverified ID token", async () => {
  const app=createServer({ ownerToken: token,
    token,lineLoginChannelId:"1234567890",
    fetchImpl:async()=>({ok:false,json:async()=>({})})
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/link`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"unverified-test-token-1",employeeId:"EMP001"})
    });
    assert.equal(response.status,401);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("LINE ID token verification rejects wrong issuer, audience, and expired claims", async () => {
  let claims={iss:"https://access.line.me",aud:"1234567890",sub:"U"+"c".repeat(32),exp:Math.floor(Date.now()/1000)+300};
  const app=createServer({
    token,
    lineLoginChannelId:"1234567890",
    fetchImpl:async()=>({ok:true,json:async()=>({...claims})})
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    for (const patch of [
      {iss:"https://attacker.example"},
      {aud:"9999999999"},
      {exp:Math.floor(Date.now()/1000)-1}
    ]) {
      claims={iss:"https://access.line.me",aud:"1234567890",sub:"U"+"c".repeat(32),exp:Math.floor(Date.now()/1000)+300,...patch};
      const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/link`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({idToken:"untrusted-test-id-token",employeeId:"EMP001"})
      });
      assert.equal(response.status,401);
    }
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("LINE employee directory endpoint is disabled to prevent employee enumeration", async () => {
  let sheetsCalls=0;
  const app=createServer({ ownerToken: token, token,
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"h".repeat(128),
    fetchImpl:async(url,options)=> {
      if(url==="https://api.line.me/oauth2/v2.1/verify") return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:"U"+"b".repeat(32),exp:Math.floor(Date.now()/1000)+300})};
      sheetsCalls+=1;
      return {ok:true,json:async()=>({ok:true,rows:[]})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/employees`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"verified-test-token-1"})
    });
    assert.equal(response.status,410);
    assert.equal(sheetsCalls,0);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("admin bootstrap and review routes pass only LINE-verified identities to Apps Script", async () => {
  const sent=[];
  const app=createServer({ ownerToken: token,
    token,
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"z".repeat(128),
    fetchImpl:async(url,options)=>{
      if(url==="https://api.line.me/oauth2/v2.1/verify") {
        const form=new URLSearchParams(options.body);
        const isBootstrap=form.get("id_token")==="bootstrap-id-token-valid-length";
        return {ok:true,json:async()=>({
          iss:"https://access.line.me",
          aud:"1234567890",
          sub:"U"+(isBootstrap?"c":"d").repeat(32),
          exp:Math.floor(Date.now()/1000)+300
        })};
      }
      const body=JSON.parse(options.body); sent.push(body);
      if(body.action==="bootstrapAdmin") return {ok:true,json:async()=>({ok:true,status:"有効",role:"管理者"})};
      if(body.action==="reviewLineLink") return {ok:true,json:async()=>({ok:true,linkId:"PENDING-test",status:"有効"})};
      return {ok:false,json:async()=>({ok:false})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const bootstrap=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/admin/bootstrap`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"bootstrap-id-token-valid-length"})
    });
    assert.equal(bootstrap.status,200);
    assert.deepEqual(await bootstrap.json(),{ok:true,status:"有効",role:"管理者"});
    assert.deepEqual(sent[0],{
      token:"z".repeat(128),action:"bootstrapAdmin",
      lineUserId:"U"+"c".repeat(32),employeeId:"EMP003"
    });

    const review=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/admin/review`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"review-id-token-valid-length",linkId:"PENDING-test",decision:"approve",adminLineUserId:"U"+"f".repeat(32)})
    });
    assert.equal(review.status,200);
    assert.deepEqual(await review.json(),{ok:true,linkId:"PENDING-test",status:"有効"});
    assert.deepEqual(sent[1],{
      token:"z".repeat(128),action:"reviewLineLink",
      adminLineUserId:"U"+"d".repeat(32),linkId:"PENDING-test",decision:"approve"
    });
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("admin bootstrap rejects an unverified LINE identity", async () => {
  const app=createServer({ ownerToken: token,
    token,lineLoginChannelId:"1234567890",
    fetchImpl:async()=>({ok:false,json:async()=>({})})
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/admin/bootstrap`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"unverified-token-valid-length"})
    });
    assert.equal(response.status,401);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("Google Sheets list route forwards authenticated request to Apps Script", async () => {
  let sent;
  const sheetsUrl = "https://script.google.com/macros/s/test-id/exec";
  const app = createServer({ ownerToken: token,
    token,
    sheetsUrl,
    sheetsToken: "a".repeat(128),
    fetchImpl: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ ok: true, sheets: ["01従業員", "日報"] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/sheets/list`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).sheets, ["01従業員", "日報"]);
    assert.equal(sent.url, sheetsUrl);
    assert.equal(sent.body.action, "listSheets");
    assert.equal(sent.body.token, "a".repeat(128));
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});

test("raw Google Sheets reads require the separate owner token", async () => {
  let calls = 0;
  const separateOwnerToken = "o".repeat(64);
  const app = createServer({
    token,
    ownerToken: separateOwnerToken,
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "a".repeat(128),
    fetchImpl: async () => { calls += 1; return { ok:true, json:async()=>({ok:true,rows:[["private"]]}) }; }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${app.address().port}/v1/sheets/read?sheetName=01%20%E5%BE%93%E6%A5%AD%E5%93%A1`;
    const denied = await fetch(url, { headers:{Authorization:`Bearer ${token}`} });
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);
    const allowed = await fetch(url, { headers:{Authorization:"Bearer " + separateOwnerToken} });
    assert.equal(allowed.status, 200);
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test("Sheets diagnostics accept the owner token without requiring the general API token", async () => {
  let calls = 0;
  const app = createServer({
    token: "g".repeat(64),
    ownerToken: "o".repeat(64),
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "s".repeat(128),
    fetchImpl: async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      if (request.action === "listSheets") return { ok:true, json:async()=>({ok:true,sheets:["03 日報","01 従業員","13 LINE連携"]}) };
      assert.equal(request.action, "readRows");
      return { ok:true, json:async()=>({ok:true,rows:[["見出し"]]}) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/metadata`, {
      headers:{Authorization:"Bearer " + "o".repeat(64)}
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 4);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test("company financial and employee records require owner authorization", async () => {
  let calls = 0;
  const app = createServer({ ownerToken: token,
    token,
    ownerToken: "o".repeat(64),
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "b".repeat(128),
    fetchImpl: async () => { calls += 1; return { ok:true, json:async()=>({ok:true,sheets:[]}) }; }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    for (const route of ["/v1/company/employees", "/v1/company/financials"]) {
      const denied = await fetch(`http://127.0.0.1:${app.address().port}${route}`, { headers:{Authorization:`Bearer ${token}`} });
      assert.equal(denied.status, 401);
    }
    assert.equal(calls, 0);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test("Google Sheets routes reject invalid sheet names", async () => {
  const app = createServer({ ownerToken: token, token, sheetsUrl: "https://script.google.com/macros/s/test-id/exec", sheetsToken: "b".repeat(128) });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/sheets/read?sheetName=`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});


test("protected Sheets health check verifies Apps Script without exposing secrets", async () => {
  const sent = [];
  const app = createServer({ ownerToken: token,
    token,
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "c".repeat(128),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      return { ok: true, json: async () => body.action === "listSheets"
        ? ({ ok: true, sheets: ["01従業員", "15設定"] })
        : ({ ok: true, rows: [["設定項目"]] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets`, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result, { ok: true, googleSheets: "connected", sheetCount: 2, readTest: "success", rowsRead: 1, columnsRead: 1 });
    assert.deepEqual(sent.map(x => x.action), ["listSheets", "readRows"]);
    assert.equal(sent[1].sheetName, "01従業員");
    assert.equal(sent[0].token, "c".repeat(128));
    assert.equal(JSON.stringify(result).includes("cccc"), false);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});

test("public metadata check includes employee sheet headers without exposing row data", async () => {
  const sent = [];
  const app = createServer({ ownerToken: token,
    token,
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "d".repeat(128),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      if (body.action === "listSheets") {
        return { ok: true, json: async () => ({ ok: true, sheets: ["01 従業員", "日報", "03 日報"] }) };
      }
      const headers = body.sheetName === "01 従業員"
        ? ["従業員ID", "従業員名", "LINE User ID"]
        : body.sheetName === "日報"
          ? ["日報ID", "日付"]
          : ["日報ID", "日付", "従業員ID"];
      return { ok: true, json: async () => ({ ok: true, rows: [headers] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/metadata`, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.employeeHeaders, ["従業員ID", "従業員名", "LINE User ID"]);
    assert.equal(result.employeeSheetFound, true);
    assert.deepEqual(sent.map(x => x.action), ["listSheets", "readRows", "readRows", "readRows"]);
    assert.deepEqual(sent.slice(1).map(x => x.sheetName), ["日報", "03 日報", "01 従業員"]);
    assert.equal(JSON.stringify(result).includes("dddd"), false);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});

test("metadata check includes LINE link sheet headers only", async () => {
  const sent = [];
  const app = createServer({ ownerToken: token,
    token,
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "e".repeat(128),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      if (body.action === "listSheets") {
        return { ok: true, json: async () => ({ ok: true, sheets: ["01 従業員", "日報", "03 日報", "13 LINE連携"] }) };
      }
      const headers = body.sheetName === "13 LINE連携"
        ? ["LINE User ID", "従業員ID", "LINE表示名", "連携状態"]
        : ["見出し"];
      return { ok: true, json: async () => ({ ok: true, rows: [headers] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/metadata`, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.lineLinkSheetFound, true);
    assert.deepEqual(result.lineLinkHeaders, ["LINE User ID", "従業員ID", "LINE表示名", "連携状態"]);
    assert.deepEqual(sent.slice(1).map(x => x.sheetName), ["日報", "03 日報", "01 従業員", "13 LINE連携"]);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});

test("public LINE link status reports counts without exposing row values", async () => {
  const app = createServer({ ownerToken: token,
    token,
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "f".repeat(128),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.action === "listSheets") return { ok: true, json: async () => ({ ok: true, sheets: ["13 LINE連携"] }) };
      return { ok: true, json: async () => ({ ok: true, rows: [
        ["連携-1", "U-secret-1", "表示名A", "EMP-1", "氏名A", "", "一般", "有効"],
        ["連携-2", "U-secret-2", "表示名B", "", "", "", "一般", "未連携"],
        ["連携-3", "", "表示名C", "EMP-3", "氏名C", "", "一般", "有効"]
      ] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/link-status`, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result, { ok:true, sheetFound:true, sampleLimit:100, sampledRows:3, rowsWithLineUserId:2, rowsWithEmployeeId:2, linkedRows:1, missingEmployeeId:1, limitedToFirst100:true });
    assert.equal(JSON.stringify(result).includes("U-secret"), false);
    assert.equal(JSON.stringify(result).includes("EMP-"), false);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});


test("public record counts report employee and daily report totals without exposing values", async () => {
  const app = createServer({ ownerToken: token,
    token,
    sheetsUrl: "https://script.google.com/macros/s/test-id/exec",
    sheetsToken: "g".repeat(128),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.action === "listSheets") {
        return { ok: true, json: async () => ({ ok: true, sheets: ["01 従業員", "03 日報"] }) };
      }
      if (body.sheetName === "01 従業員") {
        return { ok: true, json: async () => ({ ok: true, rows: [
          ["EMP-secret", "氏名A"], ["EMP-secret-2", "氏名B"], ["", ""]
        ] }) };
      }
      return { ok: true, json: async () => ({ ok: true, rows: [
        ["REPORT-secret", "2026-11-01"], ["", ""]
      ] }) };
    }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/record-counts`, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result, {
      ok: true,
      employee: { sheetFound: true, sampledRows: 3, populatedRows: 2, sampleLimit: 100, limitedToFirst100: true },
      dailyReport: { sheetFound: true, sampledRows: 2, populatedRows: 1, sampleLimit: 100, limitedToFirst100: true }
    });
    assert.equal(JSON.stringify(result).includes("EMP-secret"), false);
    assert.equal(JSON.stringify(result).includes("REPORT-secret"), false);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});


test("LINE admin pending endpoint only exposes pending requests to an active verified admin", async () => {
  const adminId="U"+"a".repeat(32);
  const pendingId="U"+"b".repeat(32);
  const app=createServer({ ownerToken: token,
    token,
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"p".repeat(128),
    fetchImpl:async(url,options)=>{
      if(url==="https://api.line.me/oauth2/v2.1/verify"){
        const form=new URLSearchParams(options.body);
        const isAdmin=form.get("id_token")==="admin-id-token-valid-length";
        return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:isAdmin?adminId:pendingId,exp:Math.floor(Date.now()/1000)+300,name:"テスト"})};
      }
      const body=JSON.parse(options.body);
      if(body.action==="listSheets") return {ok:true,json:async()=>({ok:true,sheets:["13 LINE連携"]})};
      return {ok:true,json:async()=>({ok:true,rows:[
        ["連携ID","LINEユーザーID","LINE表示名","従業員ID","氏名","","権限","状態","申請日時"],
        ["ADMIN-1",adminId,"管理者LINE","EMP003","宮本朔也","","管理者","有効",""],
        ["PENDING-1",pendingId,"申請者LINE","EMP004","従業員A","","一般","確認待ち","2026-11-15"]
      ]})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const url=`http://127.0.0.1:${app.address().port}/v1/line/admin/pending`;
    const allowed=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken:"admin-id-token-valid-length"})});
    assert.equal(allowed.status,200);
    const result=await allowed.json();
    assert.equal(result.requests.length,1);
    assert.deepEqual(result.requests[0],{linkId:"PENDING-1",displayName:"申請者LINE",employeeId:"EMP004",employeeName:"従業員A",createdAt:"2026-11-15"});
    assert.equal(JSON.stringify(result).includes(pendingId),false);
    const denied=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken:"not-admin-token-valid-length"})});
    assert.equal(denied.status,403);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("job API requires configured persistent storage and supports authenticated queue operations", async () => {
  const fs=require("node:fs/promises"), os=require("node:os"), path=require("node:path");
  const { createJobStore }=require("./core/job-store");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-api-jobs-"));
  const store=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
  const app=createServer({ ownerToken: token,token,jobStore:store});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root=`http://127.0.0.1:${app.address().port}`;
  const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  try {
    const created=await fetch(root+"/v1/jobs",{method:"POST",headers,body:JSON.stringify({type:"assistant.request",payload:{request:"今日の売上を確認して"}})});
    assert.equal(created.status,201);
    const data=await created.json();
    assert.equal(data.job.status,"queued");
    const listed=await fetch(root+"/v1/jobs?status=queued",{headers:{Authorization:headers.Authorization}});
    assert.equal((await listed.json()).jobs.length,1);
    const detail=await fetch(root+"/v1/jobs/"+data.job.id,{headers:{Authorization:headers.Authorization}});
    assert.equal((await detail.json()).job.id,data.job.id);
    const cancelled=await fetch(root+"/v1/jobs/"+data.job.id+"/cancel",{method:"POST",headers});
    assert.equal((await cancelled.json()).job.status,"cancelled");
    const invalid=await fetch(root+"/v1/jobs",{method:"POST",headers,body:JSON.stringify({type:"arbitrary.shell",payload:{request:"bad"}})});
    assert.equal(invalid.status,400);
  } finally {
    await new Promise(resolve=>app.close(resolve));
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test("job API stays unavailable when persistent storage is not configured", async () => {
  const app=createServer({ ownerToken: token,token});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/jobs`,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(response.status,503);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("end-to-end job API queues, executes, and returns a persisted assistant answer", async () => {
  const fs=require("node:fs/promises"), os=require("node:os"), path=require("node:path");
  const { createJobStore }=require("./core/job-store");
  const { createWorker }=require("./core/worker");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-e2e-"));
  const store=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
  const worker=createWorker({store,handlers:{"assistant.request":async payload=>({answer:"確認結果："+payload.request})}});
  await worker.start();
  const app=createServer({ ownerToken: token,token,jobStore:store,worker});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root=`http://127.0.0.1:${app.address().port}`;
  const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  try {
    const body=JSON.stringify({type:"assistant.request",payload:{request:"今日の予定"} ,idempotencyKey:"e2e-test-001"});
    const first=await fetch(root+"/v1/jobs",{method:"POST",headers,body});
    assert.equal(first.status,201);
    const created=(await first.json()).job;
    const duplicate=await fetch(root+"/v1/jobs",{method:"POST",headers,body});
    assert.equal(duplicate.status,200);
    assert.equal((await duplicate.json()).created,false);
    const execution=await worker.runNext();
    assert.equal(execution.job.status,"succeeded");
    const detail=await fetch(root+"/v1/jobs/"+created.id,{headers:{Authorization:headers.Authorization}});
    const saved=(await detail.json()).job;
    assert.deepEqual(saved.result,{answer:"確認結果：今日の予定"});
    const status=await fetch(root+"/v1/status",{headers:{Authorization:headers.Authorization}});
    assert.equal((await status.json()).workerEnabled,true);
  } finally {
    worker.stop();
    await new Promise(resolve=>app.close(resolve));
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test("JARVIS dashboard is served with restrictive security headers and no server token", async () => {
  const app=createServer({ ownerToken: token,token});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/`);
    const html=await response.text();
    assert.equal(response.status,200);
    assert.match(response.headers.get("content-security-policy"),/default-src 'self'/);
    assert.equal(response.headers.get("x-frame-options"),"DENY");
    assert.match(html,/ONE JARVIS/);
    assert.match(html,/メモリ内だけ/);
    assert.doesNotMatch(html,new RegExp(token));
  } finally { await new Promise(resolve=>app.close(resolve)); }
});


test("video batch plan endpoint queues an idempotent ONE CONTENT draft task without external actions", async t => {
  const {createJobStore}=require("./core/job-store");
  const {createWorker}=require("./core/worker");
  const {createVideoBatchContentHandler}=require("./core/video-batch-runner");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-video-plan-e2e-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
  const videoBatchStore=createVideoBatchStore({filePath:path.join(dir,"videos.jsonl")});
  await videoBatchStore.createBatch({items:[{id:"V01",title:"江戸の町を変えた大火",topic:"明暦の大火と江戸の都市改造"}]});
  const contentHandler=async payload=>({draft:true,videoId:payload.videoId,request:payload.request,answer:"台本初稿："+payload.request});
  const worker=createWorker({store:jobStore,handlers:{"department.content":createVideoBatchContentHandler({contentHandler,videoBatchStore})}});
  await worker.start();
  const app=createServer({ ownerToken: token,token,jobStore,videoBatchStore,worker});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.address().port;
  const headers={Authorization:"Bearer "+token,"Content-Type":"application/json"};
  try {
    const first=await fetch(root+"/v1/content/videos/V01/plan",{method:"POST",headers,body:JSON.stringify({})});
    assert.equal(first.status,201);
    const result=await first.json();
    assert.equal(result.created,true);
    assert.equal(result.job.type,"department.content");
    assert.equal(result.job.payload.videoId,"V01");
    assert.match(result.job.payload.request,/要一次資料確認/);
    assert.match(result.job.payload.request,/YouTube公開/);
    assert.match(result.job.payload.request,/テンプレ大量生産/);
    assert.match(result.job.payload.request,/AI開示方針/);
    assert.equal(result.externalActionsEnabled,false);
    const duplicate=await fetch(root+"/v1/content/videos/V01/plan",{method:"POST",headers,body:JSON.stringify({})});
    assert.equal(duplicate.status,200);
    assert.equal((await duplicate.json()).created,false);
    const run=await worker.runNext();
    assert.equal(run.job.status,"succeeded");
    assert.equal(run.job.result.videoId,"V01");
    const taskStatus=await fetch(root+"/v1/content/videos/V01/plan",{headers:{Authorization:headers.Authorization}});
    const taskStatusData=await taskStatus.json();
    assert.equal(taskStatus.status,200);
    assert.equal(taskStatusData.job.status,"succeeded");
    const batchStatus=await fetch(root+"/v1/content/batches?limit=10",{headers:{Authorization:headers.Authorization}});
    const batchStatusData=await batchStatus.json();
    assert.equal(batchStatusData.videos[0].planJob.result.draft,true);
    assert.equal(batchStatusData.videos[0].scriptMetrics.status,"too_short");
    assert.equal(batchStatusData.videos[0].scriptMetrics.requiresRecordedTiming,true);
    const metricsResponse=await fetch(root+"/v1/content/videos/V01/script-metrics",{headers:{Authorization:headers.Authorization}});
    assert.equal(metricsResponse.status,200);
    const metricsData=await metricsResponse.json();
    assert.equal(metricsData.scriptMetrics.characters,batchStatusData.videos[0].scriptMetrics.characters);
    assert.equal(metricsData.scriptMetrics.status,"too_short");
    const metricsDenied=await fetch(root+"/v1/content/videos/V01/script-metrics");
    assert.equal(metricsDenied.status,401);
    const autoSaved=await videoBatchStore.get("V01");
    assert.equal(autoSaved.stage,"script");
    assert.equal(autoSaved.status,"in_progress");
    assert.equal(autoSaved.draftStatus,"needs_source_review");
    assert.equal(autoSaved.script,run.job.result.answer);
    const saveDraft=await fetch(root+"/v1/content/videos/V01/draft",{method:"POST",headers,body:JSON.stringify({jobId:run.job.id})});
    assert.equal(saveDraft.status,200);
    const savedDraft=await saveDraft.json();
    assert.equal(savedDraft.created,false);
    assert.equal(savedDraft.video.stage,"script");
    assert.equal(savedDraft.video.draftStatus,"needs_source_review");
    assert.equal(savedDraft.video.script,run.job.result.answer);
    const duplicateSave=await fetch(root+"/v1/content/videos/V01/draft",{method:"POST",headers,body:JSON.stringify({jobId:run.job.id})});
    assert.equal(duplicateSave.status,200);
    assert.equal((await duplicateSave.json()).created,false);

    const denied=await fetch(root+"/v1/content/videos/V01/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    assert.equal(denied.status,401);
  } finally {
    worker.stop();
    await new Promise(resolve=>app.close(resolve));
  }
});

test("video batch APIs require auth, persist 100-item queues, and expose owner review", async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-video-api-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const videoBatchStore=createVideoBatchStore({filePath:path.join(dir,"videos.jsonl")});
  const ownerToken="o".repeat(64);
  const ownerHeaders={Authorization:"Bearer "+ownerToken,"Content-Type":"application/json"};
  const app=createServer({token,ownerToken,videoBatchStore});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.address().port;
  try {
    const denied=await fetch(root+"/v1/content/batches");
    assert.equal(denied.status,401);
    const items=Array.from({length:100},(_,i)=>({id:"V"+String(i+1).padStart(2,"0"),title:"企画"+(i+1),topic:"歴史テーマ"+(i+1)}));
    const created=await fetch(root+"/v1/content/batches",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({items,idempotencyKey:"api-batch-100"})});
    assert.equal(created.status,201);
    const result=await created.json();
    assert.equal(result.videos.length,100);
    await videoBatchStore.saveDraft("V01",{script:"台本初稿。出典と読みを確認する。",jobId:"api-test-V01"});
    const stage=await fetch(root+"/v1/content/videos/V01/stage",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({stage:"source_qa",notes:"台本保存済み"})});
    assert.equal(stage.status,200);
    assert.equal((await stage.json()).video.stage,"source_qa");
    const listed=await fetch(root+"/v1/content/batches?limit=200",{headers:{Authorization:"Bearer "+token}});
    assert.equal((await listed.json()).summary.total,100);
    await advanceToOwnerReview(videoBatchStore,"V01",{fromSourceQa:true});
    const regularInbox=await fetch(root+"/v1/content/approvals",{headers:{Authorization:"Bearer "+token}});
    assert.equal(regularInbox.status,401);
    const inbox=await fetch(root+"/v1/content/approvals",{headers:{Authorization:"Bearer "+ownerToken}});
    assert.equal((await inbox.json()).pending.length,1);
    await advanceToOwnerReview(videoBatchStore,"V02");
    await videoBatchStore.decideReview("V02",{decision:"hold",note:"確認待ち",actor:"owner"});
    const heldInbox=await fetch(root+"/v1/content/approvals",{headers:{Authorization:"Bearer "+ownerToken}});
    assert.equal((await heldInbox.json()).pending.some(v=>v.id==="V02"),true);
    const regularReview=await fetch(root+"/v1/content/videos/V01/review",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({decision:"approve",note:"通常トークンでは不可"})});
    assert.equal(regularReview.status,401);
    const review=await fetch(root+"/v1/content/videos/V01/review",{method:"POST",headers:ownerHeaders,body:JSON.stringify({decision:"approve",note:"確認済"})});
    assert.equal(review.status,200);
    const regularAction=await fetch(root+"/v1/content/videos/V01/action-approval",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({action:"publish",provider:"youtube",costEstimate:0,destination:"history-channel"})});
    assert.equal(regularAction.status,401);
    const approved=await fetch(root+"/v1/content/videos/V01/action-approval",{method:"POST",headers:ownerHeaders,body:JSON.stringify({action:"publish",provider:"youtube",costEstimate:0,destination:"history-channel"})});
    assert.equal(approved.status,201);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});


test("video approval inbox fails closed when the separate owner token is missing", async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-video-owner-token-missing-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const videoBatchStore=createVideoBatchStore({filePath:path.join(dir,"videos.jsonl")});
  const app=createServer({token,ownerToken:"",videoBatchStore});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/content/approvals`,{
      headers:{Authorization:"Bearer "+token}
    });
    assert.equal(response.status,503);
    assert.equal((await response.json()).error,"Owner authentication is not configured");
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("command center API exposes authenticated department overview and safe dispatch", async t => {
  const {createJobStore}=require("./core/job-store");
  const {createApprovalStore}=require("./core/approval-store");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-command-center-api-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
  const approvalStore=createApprovalStore({filePath:path.join(dir,"approvals.jsonl")});
  const app=createServer({ ownerToken: token,token,jobStore,approvalStore,worker:{},departmentHandlers:{"department.management":async()=>({}),"department.tax":async()=>({})}});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.address().port;
  const headers={Authorization:"Bearer "+token,"Content-Type":"application/json"};
  try {
    const denied=await fetch(root+"/v1/command-center");
    assert.equal(denied.status,401);
    const overview=await fetch(root+"/v1/command-center",{headers:{Authorization:headers.Authorization}});
    assert.equal(overview.status,200);
    const status=await overview.json();
    assert.equal(status.system,"ONE JARVIS COMMAND CENTER");
    assert.equal(status.departments.length,13);
    assert.equal(status.execution.externalActionsEnabled,false);
    const dispatched=await fetch(root+"/v1/command-center/dispatch",{method:"POST",headers,body:JSON.stringify({
      request:"今月の経営数値と会計データを照合",
      departmentIds:["management","tax"],
      actionClass:"analyze",
      idempotencyKey:"api-monthly-review"
    })});
    assert.equal(dispatched.status,200);
    const result=await dispatched.json();
    assert.equal(result.results.length,2);
    assert.equal(result.results.every(x=>x.status==="queued"&&x.created),true);
    const duplicate=await fetch(root+"/v1/command-center/dispatch",{method:"POST",headers,body:JSON.stringify({
      request:"今月の経営数値と会計データを照合",
      departmentIds:["management","tax"],
      actionClass:"analyze",
      idempotencyKey:"api-monthly-review"
    })});
    assert.equal((await duplicate.json()).results.every(x=>x.created===false),true);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("command center API stores external actions as owner approvals without queueing them", async t => {
  const {createJobStore}=require("./core/job-store");
  const {createApprovalStore}=require("./core/approval-store");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-command-center-approval-api-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
  const approvalStore=createApprovalStore({filePath:path.join(dir,"approvals.jsonl")});
  const app=createServer({ ownerToken: token,token,jobStore,approvalStore});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.address().port;
  const headers={Authorization:"Bearer "+token,"Content-Type":"application/json"};
  try {
    const response=await fetch(root+"/v1/command-center/dispatch",{method:"POST",headers,body:JSON.stringify({
      request:"補助金の申請を提出",
      departmentIds:["office"],
      actionClass:"external_submit",
      idempotencyKey:"api-subsidy-submit"
    })});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.results[0].status,"awaiting_owner_approval");
    assert.equal(result.externalActionsEnabled,false);
    assert.equal((await jobStore.list({limit:20})).length,0);
    assert.equal((await approvalStore.list({status:"pending"})).length,1);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});


test("command center AI plan endpoint validates planner output and dispatches safe tasks", async t => {
  const {createJobStore}=require("./core/job-store");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-command-planner-api-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const jobStore=createJobStore({filePath:path.join(dir,"jobs.jsonl")});
  const commandPlanner={plan:async({request})=>({departmentIds:["management","tax"],actionClass:"analyze",rationale:"経営数値と会計の照合",model:"test-model"})};
  const app=createServer({ ownerToken: token,token,jobStore,worker:{},departmentHandlers:{"department.management":async()=>({}),"department.tax":async()=>({})},commandPlanner});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.address().port;
  try {
    const response=await fetch(root+"/v1/command-center/plan",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({request:"今月の経営状況を分析して",idempotencyKey:"ai-plan-test"})});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.deepEqual(result.plan.departmentIds,["management","tax"]);
    assert.equal(result.results.length,2);
    assert.equal(result.results.every(x=>x.status==="queued"),true);
    assert.equal(result.externalActionsEnabled,false);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("command center AI plan endpoint is unavailable when planner is not configured", async () => {
  const app=createServer({ ownerToken: token,token});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch("http://127.0.0.1:"+app.address().port+"/v1/command-center/plan",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({request:"分析して"})});
    assert.equal(response.status,503);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("approval decisions and inbox require a separate owner token", async t => {
  const ownerToken="o".repeat(64);
  const {createApprovalStore}=require("./core/approval-store");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-owner-approval-auth-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const approvalStore=createApprovalStore({filePath:path.join(dir,"approvals.jsonl")});
  const app=createServer({ ownerToken: token,token,ownerToken,approvalStore});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.address().port;
  const regularHeaders={Authorization:"Bearer "+token,"Content-Type":"application/json"};
  const ownerHeaders={Authorization:"Bearer "+ownerToken,"Content-Type":"application/json"};
  try {
    const created=await fetch(root+"/v1/approvals",{method:"POST",headers:regularHeaders,body:JSON.stringify({
      departmentId:"office",actionClass:"external_submit",summary:"補助金申請の提出承認"
    })});
    assert.equal(created.status,201);
    const item=(await created.json()).approval;
    const regularList=await fetch(root+"/v1/approvals",{headers:{Authorization:"Bearer "+token}});
    assert.equal(regularList.status,401);
    const regularDecision=await fetch(root+"/v1/approvals/"+item.id+"/decision",{method:"POST",headers:regularHeaders,body:JSON.stringify({decision:"approved"})});
    assert.equal(regularDecision.status,401);
    const ownerDecision=await fetch(root+"/v1/approvals/"+item.id+"/decision",{method:"POST",headers:ownerHeaders,body:JSON.stringify({decision:"approved",reason:"代表者確認"})});
    const ownerDecisionResult=await ownerDecision.json();
    assert.equal(ownerDecision.status,200,JSON.stringify(ownerDecisionResult));
    assert.equal(ownerDecisionResult.approval.status,"approved");
    const ownerList=await fetch(root+"/v1/approvals?status=approved",{headers:{Authorization:"Bearer "+ownerToken}});
    assert.equal(ownerList.status,200);
    assert.equal((await ownerList.json()).approvals.length,1);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("approval decision fails closed when owner token is not configured", async t => {
  const {createApprovalStore}=require("./core/approval-store");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"jarvis-owner-approval-unconfigured-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const approvalStore=createApprovalStore({filePath:path.join(dir,"approvals.jsonl")});
  const app=createServer({ ownerToken: token,token,ownerToken:"",approvalStore});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.address().port;
  try {
    const created=await fetch(root+"/v1/approvals",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({
      departmentId:"office",actionClass:"external_submit",summary:"owner-token-not-configured"
    })});
    assert.equal(created.status,201);
    const item=(await created.json()).approval;
    const response=await fetch(root+"/v1/approvals/"+item.id+"/decision",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({decision:"approved"})});
    assert.equal(response.status,503);
    assert.equal((await approvalStore.get(item.id)).status,"pending");
  } finally { await new Promise(resolve=>app.close(resolve)); }
});


test("Apps Script JSON internal errors map to an upstream failure instead of client input errors", async () => {
  const app=createServer({
    token,
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"k".repeat(128),
    fetchImpl:async(url,options)=>{
      if(url==="https://api.line.me/oauth2/v2.1/verify") return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:"U"+"a".repeat(32),exp:Math.floor(Date.now()/1000)+300})};
      return {ok:true,json:async()=>({ok:false,error:"Internal error"})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/link`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"verified-test-token-123456",employeeId:"EMP001"})
    });
    assert.equal(response.status,502);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});


test("LINE link requests use uniform acknowledgements for unknown and already-linked employee IDs", async () => {
  const lineUserId="U"+"a".repeat(32);
  const app=createServer({
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"s".repeat(128),
    fetchImpl:async(url)=> {
      if(url==="https://api.line.me/oauth2/v2.1/verify") return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:lineUserId,exp:Math.floor(Date.now()/1000)+300})};
      const body=JSON.parse(options.body);
      if(body.action==="listSheets") return {ok:true,json:async()=>({ok:true,sheets:["01 従業員","13 LINE連携"]})};
      if(body.action==="readRows" && body.sheetName==="01 従業員") return {ok:true,json:async()=>({ok:true,rows:[["従業員ID","氏名","状態"],["EMP001","社員A","有効"]]})};
      if(body.action==="readRows" && body.sheetName==="13 LINE連携") return {ok:true,json:async()=>({ok:true,rows:[["連携ID","LINEユーザーID","LINE表示名","従業員ID","氏名","権限","状態"],["L1",lineUserId,"LINE","EMP001","社員A","一般","有効"]]})};
      return {ok:true,json:async()=>({ok:true,appended:1})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const root="http://127.0.0.1:"+app.address().port+"/v1/line/link";
    const request=employeeId=>fetch(root,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken:"verified-test-token-123456",employeeId})});
    const unknown=await request("EMP999");
    const known=await request("EMP001");
    assert.equal(unknown.status,202);
    assert.equal(known.status,202);
    assert.deepEqual(await unknown.json(),await known.json());
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("LINE link endpoint rate-limits repeated requests by verified LINE subject", async () => {
  const lineUserId="U"+"c".repeat(32);
  const app=createServer({
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"s".repeat(128),
    fetchImpl:async(url,options)=> {
      if(url==="https://api.line.me/oauth2/v2.1/verify") return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:lineUserId,exp:Math.floor(Date.now()/1000)+300})};
      const body=JSON.parse(options.body);
      if(body.action==="listSheets") return {ok:true,json:async()=>({ok:true,sheets:["01 従業員","13 LINE連携"]})};
      if(body.action==="readRows" && body.sheetName==="01 従業員") return {ok:true,json:async()=>({ok:true,rows:[["従業員ID","氏名"],["EMP001","社員A"]]})};
      if(body.action==="readRows") return {ok:true,json:async()=>({ok:true,rows:[["連携ID","LINEユーザーID","LINE表示名","従業員ID","氏名","権限","状態"]]})};
      return {ok:true,json:async()=>({ok:true,appended:1})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const root="http://127.0.0.1:"+app.address().port+"/v1/line/link";
    const request=()=>fetch(root,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken:"verified-test-token-123456",employeeId:"EMP001"})});
    for(let i=0;i<5;i++) assert.equal((await request()).status,202);
    const limited=await request();
    assert.equal(limited.status,429);
    assert.equal(limited.headers.get("retry-after"),"900");
  } finally { await new Promise(resolve=>app.close(resolve)); }
});
