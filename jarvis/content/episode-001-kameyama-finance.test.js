"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createScriptMetrics}=require("../core/script-metrics");
const file=path.join(__dirname,"episode-001-kameyama-finance.md");
const script=fs.readFileSync(file,"utf8");

test("Kameyama episode draft preserves primary-source figures and accounting caveats",()=>{
 assert.match(script,/2万4千石/);
 assert.match(script,/2,900両|2,900 ryo/);
 assert.match(script,/1万6,900両/);
 assert.match(script,/4万5,700両/);
 assert.match(script,/3万300両/);
 assert.match(script,/2万8,800両/);
 assert.match(script,/雑税/);
 assert.match(script,/推測/);
 assert.match(script,/https:\/\/www\.bunka\.pref\.mie\.lg\.jp\/rekishi\/kenshi\/asp\/hakken\/detail228\.html/);
 assert.doesNotMatch(script,/借金3万両の真相/);
});

test("Kameyama episode includes pronunciation, voice identity, and publication safeguards",()=>{
 assert.match(script,/御入用大積帳/);
 assert.match(script,/おにゅうようおおつもりちょう/);
 assert.match(script,/Hinata/);
 assert.match(script,/Kenichi/);
 assert.match(script,/Hayama/);
 assert.match(script,/publication|publishing/);
 assert.match(script,/No paid generation|有料生成/);
});


test("Kameyama narration draft is sized for an 8–12 minute spoken video",()=>{
 const metrics=createScriptMetrics(script);
 const characters=metrics.characters;
 assert.equal(metrics.status,"estimated_range_ok");
 assert.equal(metrics.requiresRecordedTiming,true);
 assert.ok(characters>=3360&&characters<=4200,"narration character count was "+characters);
});
