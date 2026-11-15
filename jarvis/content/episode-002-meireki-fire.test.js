"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createScriptMetrics}=require("../core/script-metrics");
const script=fs.readFileSync(path.join(__dirname,"episode-002-meireki-fire.md"),"utf8");

test("Meireki fire episode attributes casualty and date claims to official disaster report",()=>{
 assert.match(script,/明暦3年/);
 assert.match(script,/1657年/);
 assert.match(script,/6万8千人余り/);
 assert.match(script,/内閣府/);
 assert.match(script,/三つの大規模火災/);
 assert.match(script,/破壊消防/);
 assert.match(script,/「江戸の全域が焼けた」と表現するのは正確ではありません/);
 assert.doesNotMatch(script,/江戸の全域が焼けた(?:のです|とされています)/);
 assert.match(script,/https:\/\/www\.bousai\.go\.jp\/kyoiku\/kyokun\/kyoukunnokeishou\/rep\/1657_meireki_edotaika\//);
});

test("Meireki fire script distinguishes firefighter command systems and includes reading safeguards",()=>{
 assert.match(script,/定火消/);
 assert.match(script,/大名火消/);
 assert.match(script,/町火消/);
 assert.match(script,/指揮系統/);
 assert.match(script,/いろは組/);
 assert.match(script,/じょうびけし/);
 assert.match(script,/ひよけち/);
 assert.match(script,/与力/);
 assert.match(script,/同心/);
 assert.match(script,/Kenichi/);
 assert.match(script,/Hinata/);
 assert.match(script,/No paid generation/);
});

test("Meireki fire narration is sized for an 8–12 minute spoken video",()=>{
 const metrics=createScriptMetrics(script);
 const characters=metrics.characters;
 assert.equal(metrics.status,"estimated_range_ok");
 assert.equal(metrics.requiresRecordedTiming,true);
 assert.ok(characters>=3360&&characters<=4200,"narration character count was "+characters);
});
