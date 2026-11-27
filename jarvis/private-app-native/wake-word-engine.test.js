"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWakeWordEngine, DEFAULT_KEYWORD } = require("./wake-word-engine");
const { summarizeWakeWordTrials } = require("./wake-word-benchmark");
const manifest = { status:"verified", keyword:DEFAULT_KEYWORD,
  modelPath:"models/jarvis-kws/model.onnx", sha256:"a".repeat(64), license:"Apache-2.0" };
function nativeStub() {
  const events=[]; let starts=0, stops=0;
  return { events, get starts(){return starts;}, get stops(){return stops;},
    addListener(name, callback) { const e={name,callback}; events.push(e);
      return {remove(){const i=events.indexOf(e); if(i>=0) events.splice(i,1);}}; },
    async start(config){starts+=1; this.lastConfig=config;},
    async stop(){stops+=1;} };
}
test("engine unavailable if native module or verified model is missing",()=>{
  assert.equal(createWakeWordEngine().getStatus().ready,false);
  assert.equal(createWakeWordEngine({nativeModule:nativeStub()}).getStatus().ready,false);
});
test("start requires explicit consent",async()=>{
  const e=createWakeWordEngine({nativeModule:nativeStub(),modelManifest:manifest});
  await assert.rejects(e.start({explicitConsent:false,permissionGranted:true}),/CONSENT_OR_PERMISSION/);
});
test("start requires OS microphone permission",async()=>{
  const e=createWakeWordEngine({nativeModule:nativeStub(),modelManifest:manifest});
  await assert.rejects(e.start({explicitConsent:true,permissionGranted:false}),/CONSENT_OR_PERMISSION/);
});
test("missing model never starts native microphone engine",async()=>{
  const n=nativeStub(), e=createWakeWordEngine({nativeModule:n,modelManifest:{status:"pending"}});
  await assert.rejects(e.start({explicitConsent:true,permissionGranted:true}),/UNAVAILABLE/);
  assert.equal(n.starts,0);
});
test("verified engine starts with local-only and no-persistence flags",async()=>{
  const n=nativeStub(), e=createWakeWordEngine({nativeModule:n,modelManifest:manifest});
  assert.equal((await e.start({explicitConsent:true,permissionGranted:true})).state,"listening");
  assert.equal(n.lastConfig.keyword,"ジャービス");
  assert.equal(n.lastConfig.localOnly,true);
  assert.equal(n.lastConfig.persistAudio,false);
  assert.equal(n.lastConfig.uploadAudio,false);
});
test("only exact wake word event is surfaced without audio payload",async()=>{
  const n=nativeStub(), e=createWakeWordEngine({nativeModule:n,modelManifest:manifest}), found=[];
  await e.start({explicitConsent:true,permissionGranted:true,onDetected:x=>found.push(x)});
  n.events[0].callback({keyword:"other",audio:"must-not-forward"});
  n.events[0].callback({keyword:"ジャービス",detectedAtMonotonicMs:1200});
  assert.equal(found.length,1);
  assert.deepEqual(found[0],{keyword:"ジャービス",detectedAtMonotonicMs:1200});
  assert.equal(Object.hasOwn(found[0],"audio"),false);
});
test("stop removes listener and releases native engine",async()=>{
  const n=nativeStub(), e=createWakeWordEngine({nativeModule:n,modelManifest:manifest});
  await e.start({explicitConsent:true,permissionGranted:true}); await e.stop();
  assert.equal(n.stops,1); assert.equal(n.events.length,0); assert.equal(e.getStatus().state,"idle");
});
test("benchmark reports classification and latency without audio samples",()=>{
  const r=summarizeWakeWordTrials([
    {expectedWake:true,detected:true,latencyMs:100},
    {expectedWake:true,detected:false},
    {expectedWake:false,detected:true},
    {expectedWake:false,detected:false}],2);
  assert.equal(r.trialCount,4); assert.equal(r.truePositive,1); assert.equal(r.falseNegative,1);
  assert.equal(r.falsePositive,1); assert.equal(r.trueNegative,1);
  assert.equal(r.recall,0.5); assert.equal(r.falseActivationsPerHour,0.5);
  assert.equal(r.meanDetectionLatencyMs,100); assert.equal(r.audioStored,false);
});
test("benchmark rejects invalid windows and malformed labels",()=>{
  assert.throws(()=>summarizeWakeWordTrials([],0),/OBSERVATION_HOURS/);
  assert.throws(()=>summarizeWakeWordTrials([{detected:true}],1),/INVALID_TRIAL/);
});

test("duplicate wake-word events inside the cooldown are suppressed",async()=>{
  const n=nativeStub(), e=createWakeWordEngine({nativeModule:n,modelManifest:manifest,cooldownMs:1500}), found=[];
  await e.start({explicitConsent:true,permissionGranted:true,onDetected:x=>found.push(x)});
  n.events[0].callback({keyword:"ジャービス",detectedAtMonotonicMs:1000});
  n.events[0].callback({keyword:"ジャービス",detectedAtMonotonicMs:1200});
  n.events[0].callback({keyword:"ジャービス",detectedAtMonotonicMs:2600});
  assert.equal(found.length,2);
  assert.equal(found[0].detectedAtMonotonicMs,1000);
  assert.equal(found[1].detectedAtMonotonicMs,2600);
});

test("wake-word cooldown rejects invalid values",()=>{
  assert.throws(()=>createWakeWordEngine({cooldownMs:-1}),/COOLDOWN_INVALID/);
});
