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
 sourceQa:{status:"passed",allClaimsVerified:true,verifiedClaimCount:4,primarySourceCount:1,reviewedBy:"test-reviewer",claims:Array.from({length:4},(_,i)=>({claim:"史実の主張"+(i+1),status:"verified",sourceUrl:"https://www.bousai.go.jp/report",sourceTitle:"公的資料",quote:"明暦三年に江戸で大火が起きた。"}))},
 pronunciation:{status:"passed",readingsReviewed:true,termsChecked:1,reviewedBy:"test-reviewer",terms:[{term:"明暦三年",reading:"めいれきさんねん",status:"confirmed",sourceUrl:"https://www.bousai.go.jp/report",sourceTitle:"公的資料",quote:"明暦三年に江戸で大火が起きた。",reviewedBy:"test-reviewer"}]},
 narration:{status:"recorded",durationSeconds:600,voiceName:"Hinata",voiceConfirmed:true,recordedBy:"test-recorder"},
 assets:{status:"cleared",assetCount:5,rightsConfirmed:true,clearedBy:"test-editor"},
 edit:{status:"rendered",projectId:"072f8671-af62-480c-8072-bb253faf58b7",compositionId:"cd7b6796-23cc-43a7-ae7c-c2e3cfb50d32",durationSeconds:600},
 finalQa:{status:"passed",checklistPassed:true,openIssues:0,durationSeconds:600,checkedBy:"test-reviewer"}
};
async function advanceToOwnerReview(store,id,{fromSourceQa=false}={}){
 if(!fromSourceQa){await store.saveDraft(id,{script:"明暦三年に江戸で大火が起きた。出典と読みを確認する。",jobId:"server-test-"+id});await store.saveSourceReview(id,{answer:"出典候補確認",jobId:"source-server-"+id,sourceSnapshots:[{requestedUrl:"https://www.bousai.go.jp/report",finalUrl:"https://www.bousai.go.jp/report",fetchedAt:"2026-11-16T00:00:00.000Z",httpStatus:200,title:"公的資料",contentSha256:"c".repeat(64),text:"明暦三年に江戸で大火が起きた。",error:""}]});await store.updateStage(id,"source_qa");}
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
  server = createServer({ token });
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
  const app=createServer({token, liffId:"1234567890-AbCdEfGh"});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/line-link`);
    const html=await response.text();
    assert.equal(response.status,200);
    assert.match(html,/株式会社One LINE連携/);
    assert.match(html,/1234567890-AbCdEfGh/);
    assert.doesNotMatch(html,/JARVIS_API_TOKEN|JARVIS_SHEETS_TOKEN/);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("LINE linking verifies ID token and stores only a pending approval", async () => {
  const sent=[];
  const app=createServer({
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
      return {ok:true,json:async()=>({ok:true,appended:1})};
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
    const write=sent.find(x=>x.action==="appendRows");
    assert.equal(write.rows[0][1],"U"+"a".repeat(32));
    assert.equal(write.rows[0][3],"EMP001");
    assert.equal(write.rows[0][7],"確認待ち");
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("daily report requires an active LINE link and appends a validated report", async () => {
  const sent=[];
  const app=createServer({
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
      body:JSON.stringify({idToken:"verified-test-token-123456",workDate:"2026-11-15",siteName:"岡山現場",workDetails:"掘削作業",startTime:"08:00",endTime:"17:00",breakMinutes:"60",workerCount:"3",equipment:"バックホウ",materials:"RC30",notes:""})
    });
    const result=await response.json();
    assert.equal(response.status,201);
    assert.equal(result.employeeName,"宮本朔也");
    const write=sent.find(x=>x.action==="appendDailyReport");
    assert.equal(write.report.employeeId,"EMP003");
    assert.equal(write.report.workDetails,"掘削作業");
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("LINE linking rejects an unverified ID token", async () => {
  const app=createServer({
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

test("LINE employee list verifies ID token without the JARVIS bearer token", async () => {
  const app=createServer({
    token,
    lineLoginChannelId:"1234567890",
    sheetsUrl:"https://script.google.com/macros/s/test-id/exec",
    sheetsToken:"h".repeat(128),
    fetchImpl:async(url,options)=>{
      if(url==="https://api.line.me/oauth2/v2.1/verify") {
        return {ok:true,json:async()=>({iss:"https://access.line.me",aud:"1234567890",sub:"U"+"b".repeat(32),exp:Math.floor(Date.now()/1000)+300})};
      }
      const body=JSON.parse(options.body);
      if(body.action==="listSheets") return {ok:true,json:async()=>({ok:true,sheets:["01 従業員"]})};
      return {ok:true,json:async()=>({ok:true,rows:[["従業員ID","氏名","","","","","","","","状態"],["EMP001","テスト従業員","","","","","","","","有効"],["EMP002","無効従業員","","","","","","","","無効"]]})};
    }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/employees`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"verified-test-token-1"})
    });
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).employees,[{employeeId:"EMP001",name:"テスト従業員"}]);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});

test("admin bootstrap and review routes pass only LINE-verified identities to Apps Script", async () => {
  const sent=[];
  const app=createServer({
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
  const app=createServer({
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
  const app = createServer({
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

test("Google Sheets routes reject invalid sheet names", async () => {
  const app = createServer({ token, sheetsUrl: "https://script.google.com/macros/s/test-id/exec", sheetsToken: "b".repeat(128) });
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


test("public Sheets health check verifies Apps Script without exposing secrets", async () => {
  const sent = [];
  const app = createServer({
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
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets`);
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
  const app = createServer({
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
  const app = createServer({
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
  const app = createServer({
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
  const app = createServer({
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
  const app=createServer({
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
  const app=createServer({token,jobStore:store});
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
  const app=createServer({token});
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
  const app=createServer({token,jobStore:store,worker});
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
  const app=createServer({token});
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
  const app=createServer({token,jobStore,videoBatchStore,worker});
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

    const sourceReview=await fetch(root+"/v1/content/videos/V01/source-review",{method:"POST",headers,body:JSON.stringify({})});
    assert.equal(sourceReview.status,201);
    const sourceReviewTask=await sourceReview.json();
    assert.equal(sourceReviewTask.verificationStatus,"not_verified");
    assert.match(sourceReviewTask.job.payload.request,/台本全文：\n/);
    assert.doesNotMatch(sourceReviewTask.job.payload.request,/台本全文：\\n/);
    const sourceReviewRun=await worker.runNext();
    assert.equal(sourceReviewRun.job.status,"succeeded");
    assert.equal(sourceReviewRun.job.result.verified,false);
    const reviewedVideo=await videoBatchStore.get("V01");
    assert.equal(reviewedVideo.sourceReview.verified,false);
    const sourceReviewDuplicate=await fetch(root+"/v1/content/videos/V01/source-review",{method:"POST",headers,body:JSON.stringify({})});
    assert.equal(sourceReviewDuplicate.status,200);
    assert.equal((await sourceReviewDuplicate.json()).created,false);
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
  const app=createServer({token,videoBatchStore});
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
    await videoBatchStore.saveDraft("V01",{script:"明暦三年に江戸で大火が起きた。出典と読みを確認する。",jobId:"api-test-V01"});
    await videoBatchStore.saveSourceReview("V01",{answer:"出典候補確認",jobId:"source-api-V01",sourceSnapshots:[{requestedUrl:"https://www.bousai.go.jp/report",finalUrl:"https://www.bousai.go.jp/report",fetchedAt:"2026-11-16T00:00:00.000Z",httpStatus:200,title:"公的資料",contentSha256:"d".repeat(64),text:"明暦三年に江戸で大火が起きた。",error:""}]});
    const stage=await fetch(root+"/v1/content/videos/V01/stage",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({stage:"source_qa",notes:"台本保存済み"})});
    assert.equal(stage.status,200);
    assert.equal((await stage.json()).video.stage,"source_qa");
    const sourceQa={status:"passed",allClaimsVerified:true,verifiedClaimCount:1,primarySourceCount:1,reviewedBy:"api-reviewer",claims:[{claim:"明暦三年の大火",status:"verified",sourceUrl:"https://www.bousai.go.jp/report",sourceTitle:"公的資料",quote:"明暦三年に江戸で大火が起きた。"}]};
    const toPronunciation=await fetch(root+"/v1/content/videos/V01/stage",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({stage:"pronunciation",evidence:{sourceQa}})});
    assert.equal(toPronunciation.status,200);
    const pronunciation={status:"passed",readingsReviewed:true,termsChecked:1,reviewedBy:"api-reviewer",terms:[{term:"明暦三年",reading:"めいれきさんねん",status:"confirmed",sourceUrl:"https://www.bousai.go.jp/report",sourceTitle:"公的資料",quote:"明暦三年に江戸で大火が起きた。",reviewedBy:"api-reviewer"}]};
    const toNarration=await fetch(root+"/v1/content/videos/V01/stage",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({stage:"narration",evidence:{pronunciation}})});
    assert.equal(toNarration.status,200);
    const audio=await fetch(root+"/v1/content/videos/V01/narration-asset",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({fileName:"narration.wav",mimeType:"audio/wav",durationSeconds:32.8,sha256:"f".repeat(64),voiceName:"Kenichi",provider:"heygen",jobId:"api-audio-1"})});
    assert.equal(audio.status,201);
    assert.equal((await audio.json()).video.narrationAsset.audioListened,false);
    const listed=await fetch(root+"/v1/content/batches?limit=200",{headers:{Authorization:"Bearer "+token}});
    assert.equal((await listed.json()).summary.total,100);
    await videoBatchStore.updateStage("V01","assets",{evidence:{narration:STAGE_EVIDENCE.narration}});
    await videoBatchStore.updateStage("V01","edit",{evidence:{assets:STAGE_EVIDENCE.assets}});
    await videoBatchStore.updateStage("V01","final_qa",{evidence:{edit:STAGE_EVIDENCE.edit}});
    await videoBatchStore.updateStage("V01","owner_review",{evidence:{finalQa:STAGE_EVIDENCE.finalQa}});
    const inbox=await fetch(root+"/v1/content/approvals",{headers:{Authorization:"Bearer "+token}});
    assert.equal((await inbox.json()).pending.length,1);
    await advanceToOwnerReview(videoBatchStore,"V02");
    await videoBatchStore.decideReview("V02",{decision:"hold",note:"確認待ち",actor:"owner"});
    const heldInbox=await fetch(root+"/v1/content/approvals",{headers:{Authorization:"Bearer "+token}});
    assert.equal((await heldInbox.json()).pending.some(v=>v.id==="V02"),true);
    const review=await fetch(root+"/v1/content/videos/V01/review",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({decision:"approve",note:"確認済"})});
    assert.equal(review.status,200);
    const approved=await fetch(root+"/v1/content/videos/V01/action-approval",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({action:"publish",provider:"youtube",costEstimate:0,destination:"history-channel"})});
    assert.equal(approved.status,201);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});
