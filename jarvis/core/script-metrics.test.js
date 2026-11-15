"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {extractSpokenText,createScriptMetrics}=require("./script-metrics");
test("extracts only spoken narration and excludes metadata and production notes",()=>{
 const source="# title\n- target 8-12 min\n\n## Narration script\n\n### Opening\n\n江戸の町に火が広がりました。\n\n## Pronunciation / narration checklist\n\n読み一覧";
 assert.equal(extractSpokenText(source),"江戸の町に火が広がりました。");
});
test("estimates Japanese runtime from character pace and requires recorded timing",()=>{
 const text="## ナレーション原稿\n"+ "あ".repeat(3360)+"\n## 出典\n出典メモ";
 const m=createScriptMetrics(text);
 assert.equal(m.characters,3360);
 assert.equal(m.status,"estimated_range_ok");
 assert.deepEqual(m.estimatedMinutes,{min:8.4,max:10.2});
 assert.equal(m.requiresRecordedTiming,true);
});
test("flags short, long, and ambiguous narration instead of claiming a finished runtime",()=>{
 assert.equal(createScriptMetrics("あ".repeat(1000)).status,"too_short");
 assert.equal(createScriptMetrics("あ".repeat(6000)).status,"too_long");
 assert.equal(createScriptMetrics("あ".repeat(3300)).status,"timing_review_required");
 assert.equal(createScriptMetrics("").status,"missing_script");
});
test("rejects invalid narration pace settings",()=>{
 assert.throws(()=>createScriptMetrics("あ",{charsPerMinuteSlow:500,charsPerMinuteFast:300}),/pace range/);
});
