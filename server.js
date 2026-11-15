"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;
const OPENAI_TIMEOUT_MS = 20_000;
const LINE_TIMEOUT_MS = 10_000;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 10_000;
const recentEvents = new Map();

function verifySignature(body, signature, secret = process.env.LINE_CHANNEL_SECRET) {
  if (!secret || typeof signature !== "string" || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  const supplied = Buffer.from(signature, "base64");
  if (supplied.toString("base64") !== signature) return false;
  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
}

async function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }
  return "";
}

async function getAIReply(message) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI is not configured");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      input: [{
        role: "user",
        content: [{ type: "input_text", text: message }]
      }]
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
  });

  if (!response.ok) {
    console.error("OpenAI API request failed", { status: response.status });
    throw new Error("OpenAI API request failed");
  }

  const data = await response.json();
  const answer = extractOutputText(data);
  if (!answer) throw new Error("OpenAI returned no text");
  return answer;
}

async function replyToLINE(replyToken, text) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) throw new Error("LINE is not configured");

  const replyText = String(text || "").trim().slice(0, 5000) ||
    "申し訳ありません。回答を取得できませんでした。";

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + accessToken
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: replyText }]
    }),
    signal: AbortSignal.timeout(LINE_TIMEOUT_MS)
  });

  if (!response.ok) {
    console.error("LINE reply failed", { status: response.status });
    throw new Error("LINE reply failed");
  }
}

function claimEvent(eventId, now = Date.now()) {
  if (!eventId) return true;
  for (const [key, expiresAt] of recentEvents) {
    if (expiresAt <= now) recentEvents.delete(key);
  }
  if (recentEvents.has(eventId)) return false;
  if (recentEvents.size >= MAX_DEDUPE_ENTRIES) {
    const oldest = recentEvents.keys().next().value;
    if (oldest) recentEvents.delete(oldest);
  }
  recentEvents.set(eventId, now + DEDUPE_TTL_MS);
  return true;
}

async function processEvents(events) {
  for (const event of events) {
    if (event?.type !== "message" || event?.message?.type !== "text" || !event.replyToken) {
      continue;
    }

    const eventId = event.webhookEventId;
    if (!claimEvent(eventId)) {
      console.info("Duplicate LINE event ignored");
      continue;
    }

    try {
      const message = String(event.message.text || "").trim();
      if (!message) continue;
      const answer = await getAIReply(message);
      await replyToLINE(event.replyToken, answer);
      console.info("LINE event processed", { type: event.type });
    } catch (error) {
      if (eventId) recentEvents.delete(eventId);
      console.error("LINE event processing failed", {
        name: error?.name || "Error"
      });
      try {
        await replyToLINE(
          event.replyToken,
          "申し訳ありません。AIの回答処理中にエラーが発生しました。時間をおいて再度お試しください。"
        );
      } catch (replyError) {
        console.error("LINE fallback reply failed", {
          name: replyError?.name || "Error"
        });
      }
    }
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("株式会社One LINE AI Bot is running");
      return;
    }

    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    try {
      const body = await readRequestBody(req);
      const signature = req.headers["x-line-signature"];
      if (!verifySignature(body, signature)) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }

      if (!payload || !Array.isArray(payload.events)) {
        res.writeHead(400);
        res.end("Invalid webhook payload");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");

      console.info("LINE webhook accepted", {
        eventCount: payload.events.length
      });

      void processEvents(payload.events).catch((error) => {
        console.error("Webhook background processing failed", {
          name: error?.name || "Error"
        });
      });
    } catch (error) {
      if (res.headersSent) return;
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(status === 413 ? "Payload Too Large" : "Request Failed");
      console.error("Webhook request rejected", { status });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, "0.0.0.0", () => {
    console.info("LINE AI Bot running on port " + PORT);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = {
  createServer,
  verifySignature,
  readRequestBody,
  extractOutputText,
  claimEvent
};
