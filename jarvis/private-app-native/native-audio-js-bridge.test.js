"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "App.js"), "utf8");

test("native audio screen does not register a JavaScript PCM callback", () => {
  assert.doesNotMatch(appSource, /onBuffer\s*[,}:]/);
  assert.doesNotMatch(appSource, /Int16Array|Float32Array|buffer\.data/);
});

test("native audio screen keeps only stream controls and status in JavaScript", () => {
  assert.match(appSource, /useAudioStream\(/);
  assert.match(appSource, /stream\.start\(/);
  assert.match(appSource, /stream\.stop\(/);
  assert.match(appSource, /PCMをJavaScriptへ転送しません/);
});

test("native audio screen has no network or file persistence path", () => {
  assert.doesNotMatch(appSource, /\bfetch\s*\(|XMLHttpRequest|FileSystem|writeAsStringAsync|uploadAsync/);
});
