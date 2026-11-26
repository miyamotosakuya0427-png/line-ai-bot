"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const Voice=require("./voice-core");
const root=__dirname;

test("PWA manifest declares a standalone Japanese company app",()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,"manifest.webmanifest"),"utf8"));
  assert.equal(manifest.name,"ONE JARVIS｜株式会社One専用");
  assert.equal(manifest.lang,"ja");
  assert.equal(manifest.display,"standalone");
  assert.equal(manifest.start_url,"/private-app/");
  assert.equal(manifest.scope,"/private-app/");
  assert.ok(manifest.icons.some(icon=>icon.src==="./icons/icon.svg"));
});
test("wake word parser accepts Japanese and English aliases and extracts trailing command",()=>{
  assert.deepEqual(Voice.extractWakeCommand("ねえ、ジャービス。今日の予定を教えて"),{wakeDetected:true,command:"今日の予定を教えて",matchedWord:"ジャービス"});
  assert.equal(Voice.extractWakeCommand("Jarvis, check status").command,"check status");
  assert.equal(Voice.extractWakeCommand("今日はジャージを買う").wakeDetected,false);
});
test("wake word without a command is represented as an armed greeting",()=>{
  const result=Voice.extractWakeCommand("ジャービス");
  assert.equal(result.wakeDetected,true);assert.equal(result.command,"");
});
test("recognition constructor detection supports standard and WebKit implementations",()=>{
  function Standard(){} function WebKit(){}
  assert.equal(Voice.getSpeechRecognitionConstructor({SpeechRecognition:Standard,webkitSpeechRecognition:WebKit}),Standard);
  assert.equal(Voice.getSpeechRecognitionConstructor({webkitSpeechRecognition:WebKit}),WebKit);
  assert.equal(Voice.getSpeechRecognitionConstructor({}),null);
});
test("service worker caches only static app shell and excludes private API routes",()=>{
  const sw=fs.readFileSync(path.join(root,"service-worker.js"),"utf8");
  assert.match(sw,/\/private-app\/index\.html/);
  assert.match(sw,/url\.pathname\.startsWith\("\/v1\/"\)/);
  assert.match(sw,/url\.pathname\.startsWith\("\/health"\)/);
  assert.doesNotMatch(sw,/cache\.put\(request/);
});
test("prototype has no persistent browser token or conversation storage and no API submission",()=>{
  const app=fs.readFileSync(path.join(root,"app.js"),"utf8");
  assert.doesNotMatch(app,/localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(app,/fetch\s*\(/);
  assert.match(app,/document\.visibilitychange/);assert.match(app,/pagehide/);
});
test("microphone is not started automatically and the HTML explains provider-side speech processing",()=>{
  const app=fs.readFileSync(path.join(root,"app.js"),"utf8");
  const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
  assert.match(app,/startButton\.addEventListener\("click",startListening\)/);
  assert.doesNotMatch(app,/startListening\(\);\s*$/m);
  assert.match(html,/音声が端末外で処理される可能性/);
  assert.match(html,/Prototype only/);
});
