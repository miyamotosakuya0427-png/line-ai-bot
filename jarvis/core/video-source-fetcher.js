"use strict";

const crypto = require("node:crypto");

const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function isAllowedOfficialHost(hostname, extraHosts = []) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || host === "localhost" || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) return false;
  if (extraHosts.some(value => host === String(value).toLowerCase())) return true;
  return [".go.jp", ".lg.jp", ".ac.jp", ".ed.jp"].some(suffix => host.endsWith(suffix));
}

function validateSourceUrl(value, extraHosts = []) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid source URL"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !isAllowedOfficialHost(url.hostname, extraHosts)) {
    throw new Error("Source URL is outside the approved HTTPS official-domain allowlist");
  }
  url.hash = "";
  return url;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Official source exceeds the maximum response size");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Official source exceeds the maximum response size");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchOfficialSource(urlValue, {
  fetchImpl = fetch,
  allowedHosts = [],
  maxBytes = MAX_BYTES,
  maxRedirects = MAX_REDIRECTS,
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 5 * MAX_BYTES) throw new Error("Invalid source size limit");
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) throw new Error("Invalid redirect limit");
  let url = validateSourceUrl(urlValue, allowedHosts);
  const requestedUrl = url.toString();
  let response;
  for (let redirectCount = 0; ; redirectCount++) {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "ONE-JARVIS-SourceReview/1.0" },
      signal: AbortSignal.timeout(10000)
    });
    if (!REDIRECTS.has(response.status)) break;
    if (redirectCount >= maxRedirects) throw new Error("Official source redirect limit exceeded");
    const location = response.headers?.get?.("location");
    if (!location) throw new Error("Official source redirect has no location");
    url = validateSourceUrl(new URL(location, url).toString(), allowedHosts);
  }
  if (!response.ok) throw new Error("Official source returned HTTP " + response.status);
  const contentType = response.headers?.get?.("content-type") || "";
  if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) throw new Error("Only HTML official sources are supported");
  const html = await readBoundedBody(response, maxBytes);
  const titleRaw = (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "";
  const text = htmlToText(html);
  if (!text) throw new Error("Official source contains no readable text");
  return {
    requestedUrl,
    finalUrl: url.toString(),
    fetchedAt: now().toISOString(),
    httpStatus: response.status,
    contentType,
    title: htmlToText(titleRaw).slice(0, 300),
    text: text.slice(0, 200000),
    contentSha256: crypto.createHash("sha256").update(text).digest("hex"),
    verification: "source_page_fetched_not_claim_verified"
  };
}

function exactQuoteMatches(snapshot, quote) {
  return Boolean(snapshot && typeof snapshot.text === "string" && typeof quote === "string" && quote.trim().length >= 12 && snapshot.text.includes(quote.trim()));
}

module.exports = { isAllowedOfficialHost, validateSourceUrl, htmlToText, fetchOfficialSource, exactQuoteMatches };
