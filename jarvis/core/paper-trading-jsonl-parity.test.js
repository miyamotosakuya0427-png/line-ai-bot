"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {inspectJsonl,compareJournalReplay}=require("./paper-trading-jsonl-parity");
test("hashes and counts existing JSONL without rewriting it",()=>{const raw='{"type":"snapshot","data":{"price":1}}\n';const x=inspectJsonl(raw);assert.equal(x.eventCount,1);assert.equal(x.sha256.length,64);});
test("requires event and replay parity before accepting a comparison",()=>{const raw='{"type":"snapshot","data":{"price":1}}\n';const events=inspectJsonl(raw).events;const r=compareJournalReplay({sourceRaw:raw,replayedEvents:events,sourceAnalysis:{equity:1},replayedAnalysis:{equity:1}});assert.equal(r.parity,true);const bad=compareJournalReplay({sourceRaw:raw,replayedEvents:[],sourceAnalysis:{},replayedAnalysis:{}});assert.equal(bad.parity,false);});
