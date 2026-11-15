"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedOfficialHost, validateSourceUrl, htmlToText, fetchOfficialSource, exactQuoteMatches } = require("./video-source-fetcher");

test("only HTTPS official government, local government, university, or explicitly allowed hosts pass", () => {
  assert.equal(isAllowedOfficialHost("www.bousai.go.jp"), true);
  assert.equal(isAllowedOfficialHost("www.city.okayama.lg.jp"), true);
  assert.equal(isAllowedOfficialHost("museum.example.jp"), false);
  assert.equal(isAllowedOfficialHost("example.go.jp.attacker.test"), false);
  assert.equal(isAllowedOfficialHost("127.0.0.1"), false);
  assert.equal(isAllowedOfficialHost("museum.example.jp", ["museum.example.jp"]), true);
  assert.throws(() => validateSourceUrl("http://www.bousai.go.jp/"));
  assert.throws(() => validateSourceUrl("https://user:pass@www.bousai.go.jp/"));
  assert.throws(() => validateSourceUrl("https://www.bousai.go.jp:8443/"));
});

test("HTML is reduced to readable text and script/style content is excluded", () => {
  const text = htmlToText("<html><head><title>資料 &amp; 記録</title></head><body><script>secret()</script><p>江戸の町</p><style>.x{}</style><p>火除地</p></body></html>");
  assert.match(text, /江戸の町/);
  assert.match(text, /火除地/);
  assert.doesNotMatch(text, /secret|資料/);
});

test("fetches official HTML, records a content hash, and supports exact quotation checks", async () => {
  const html = "<html><head><title>公的資料</title></head><body><p>明暦三年、江戸で大火が発生した。</p></body></html>";
  const snapshot = await fetchOfficialSource("https://www.bousai.go.jp/report", {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://www.bousai.go.jp/report");
      assert.equal(options.redirect, "manual");
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    now: () => new Date("2026-11-16T00:00:00.000Z")
  });
  assert.equal(snapshot.title, "公的資料");
  assert.equal(snapshot.verification, "source_page_fetched_not_claim_verified");
  assert.match(snapshot.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(exactQuoteMatches(snapshot, "明暦三年、江戸で大火が発生した。"), true);
  assert.equal(exactQuoteMatches(snapshot, "根拠のない引用文です。"), false);
});

test("redirects are revalidated and cannot escape the official-domain allowlist", async () => {
  let calls = 0;
  await assert.rejects(fetchOfficialSource("https://www.bousai.go.jp/start", {
    fetchImpl: async () => {
      calls++;
      return new Response("", { status: 302, headers: { location: "https://attacker.example/steal" } });
    }
  }), /allowlist/);
  assert.equal(calls, 1);
});

test("rejects non-HTML and unsuccessful responses", async () => {
  await assert.rejects(fetchOfficialSource("https://www.bousai.go.jp/file", {
    fetchImpl: async () => new Response("PDF", { status: 200, headers: { "content-type": "application/pdf" } })
  }), /Only HTML/);
  await assert.rejects(fetchOfficialSource("https://www.bousai.go.jp/missing", {
    fetchImpl: async () => new Response("missing", { status: 404, headers: { "content-type": "text/html" } })
  }), /HTTP 404/);
});
