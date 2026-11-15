const http = require("http");

const PORT = process.env.PORT || 3000;
const JARVIS_API_TOKEN = process.env.JARVIS_API_TOKEN;

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function authorized(req) {
  const token = req.headers.authorization || "";
  return Boolean(
    JARVIS_API_TOKEN &&
    token === `Bearer ${JARVIS_API_TOKEN}`
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, {
      ok: true,
      service: "ONE JARVIS",
      status: "running"
    });
  }

  if (!authorized(req)) {
    return send(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
  }

  if (req.method === "GET" && req.url === "/v1/status") {
    return send(res, 200, {
      ok: true,
      system: "ONE JARVIS",
      version: "1.0.0",
      mode: "read-only"
    });
  }

  if (req.method === "POST" && req.url === "/v1/command") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10000) {
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const command = String(data.command || "").toLowerCase();

        if (command === "help") {
          return send(res, 200, {
            ok: true,
            message: "利用できるコマンド: help, status"
          });
        }

        if (command === "status") {
          return send(res, 200, {
            ok: true,
            message: "ONE JARVIS is running."
          });
        }

        return send(res, 400, {
          ok: false,
          message: "このコマンドはまだ利用できません。"
        });
      } catch {
        return send(res, 400, {
          ok: false,
          error: "Invalid JSON"
        });
      }
    });

    return;
  }

  return send(res, 404, {
    ok: false,
    error: "Not Found"
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ONE JARVIS running on port ${PORT}`);
});
