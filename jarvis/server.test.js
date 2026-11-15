"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./server");

const token = "test-token-that-is-at-least-32-bytes-long";
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
        const isBootstrap=form.get("id_token")==="bootstrap-id-token";
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
      body:JSON.stringify({idToken:"bootstrap-id-token"})
    });
    assert.equal(bootstrap.status,200);
    assert.deepEqual(await bootstrap.json(),{ok:true,status:"有効",role:"管理者"});
    assert.deepEqual(sent[0],{
      token:"z".repeat(128),action:"bootstrapAdmin",
      lineUserId:"U"+"c".repeat(32),employeeId:"EMP003"
    });

    const review=await fetch(`http://127.0.0.1:${app.address().port}/v1/line/admin/review`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:"review-id-token",linkId:"PENDING-test",decision:"approve",adminLineUserId:"U"+"f".repeat(32)})
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
      body:JSON.stringify({idToken:"unverified-token"})
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
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/sheets/read?sheetName=missing`, {
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
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/metadata`);
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
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/metadata`);
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
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/link-status`);
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
    const response = await fetch(`http://127.0.0.1:${app.address().port}/health/sheets/record-counts`);
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
