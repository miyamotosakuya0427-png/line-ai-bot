"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const file=fs.readFileSync(path.join(__dirname,"finance-100-ideas.md"),"utf8");
const rows=file.split("\n").filter(line=>/^\| F\d{3} \|/.test(line));
test("finance idea backlog contains 100 unique research-first episodes",()=>{
 assert.equal(rows.length,100);
 const ids=rows.map(line=>line.split("|")[1].trim());
 const titles=rows.map(line=>line.split("|")[3].trim());
 assert.equal(new Set(ids).size,100);
 assert.equal(new Set(titles).size,100);
 assert.equal(ids[0],"F001");
 assert.equal(ids[99],"F100");
 assert.match(file,/未承認・未公開/);
 assert.match(file,/一次資料/);
 assert.match(file,/個別銘柄の売買推奨/);
});
