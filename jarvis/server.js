"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 10 * 1024;
const TOKEN = process.env.JARVIS_API_TOKEN || "";

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req, token = TOKEN) {
  if (!token || Buffer.byteLength(token, "utf8") < 32) return false;
  const header = req.headers.authorization || "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match) return false;

  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON body must be an object");
    }
    return value;
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function createServer({ token = TOKEN } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          service: "ONE JARVIS",
          status: "running"
        });
      }

      if (!isAuthorized(req, token)) {
        return json(res, token ? 401 : 503, {
          ok: false,
          error: token ? "Unauthorized" : "Authentication is not configured"
        }, token ? { "WWW-Authenticate": "Bearer" } : {});
      }

      if (req.method === "GET" && url.pathname === "/v1/status") {
        return json(res, 200, {
          ok: true,
          system: "ONE JARVIS",
          version: "1.1.0",
          mode: "read-only"
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/command") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          return json(res, 415, { ok: false, error: "Content-Type must be application/json" });
        }

        const data = await readJson(req);
        const command = typeof data.command === "string"
          ? data.command.trim().toLowerCase()
          : "";

        if (command === "help") {
          return json(res, 200, {
            ok: true,
            message: "利用できるコマンド: help, status"
          });
        }
        if (command === "status") {
          return json(res, 200, {
            ok: true,
            message: "ONE JARVIS is running.",
            mode: "read-only"
          });
        }
        return json(res, 400, {
          ok: false,
          message: "このコマンドはまだ利用できません。"
        });
      }

      if (req.method !== "GET" && req.method !== "POST") {
        return json(res, 405, { ok: false, error: "Method Not Allowed" }, { Allow: "GET, POST" });
      }
      return json(res, 404, { ok: false, error: "Not Found" });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return json(res, status, {
        ok: false,
        error: status === 500 ? "Internal Server Error" : error.message
      });
    }
  });
}

if (require.main === module) {
  if (!TOKEN || Buffer.byteLength(TOKEN, "utf8") < 32) {
    console.error("JARVIS_API_TOKEN must be configured with at least 32 bytes.");
    process.exit(1);
  }

  const server = createServer();
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ONE JARVIS running on port ${PORT}`);
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down.`);
    server.close((error) => {
      if (error) {
        console.error("Graceful shutdown failed.");
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { createServer, isAuthorized, readJson };
