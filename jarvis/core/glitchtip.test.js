"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { initGlitchTip } = require("./glitchtip");

test("monitoring stays disabled when no DSN is configured", () => {
  const monitoring = initGlitchTip({ env: {}, sdk: null });
  assert.equal(monitoring.enabled, false);
  assert.doesNotThrow(() => monitoring.captureException(new Error("test")));
});

test("initializes Sentry-compatible SDK with privacy-safe defaults", () => {
  let options;
  const captured = [];
  const sdk = {
    init(value) { options = value; },
    captureException(error) { captured.push(error); }
  };
  const monitoring = initGlitchTip({
    env: {
      GLITCHTIP_DSN: "https://public@example.invalid/1",
      JARVIS_ENVIRONMENT: "test",
      RENDER_GIT_COMMIT: "abc123"
    },
    sdk
  });

  assert.equal(monitoring.enabled, true);
  assert.equal(options.environment, "test");
  assert.equal(options.release, "one-jarvis@abc123");
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, 0);

  const event = {
    request: {
      url: "https://jarvis.example/v1/status?token=secret#fragment",
      headers: {
        authorization: "Bearer secret",
        Cookie: "session=secret",
        "x-api-key": "secret",
        "content-type": "application/json"
      },
      data: { private: "payload" },
      cookies: { session: "secret" }
    }
  };
  assert.equal(options.beforeSend(event), event);
  assert.equal(event.request.url, "https://jarvis.example/v1/status");
  assert.deepEqual(event.request.headers, { "content-type": "application/json" });
  assert.equal("data" in event.request, false);
  assert.equal("cookies" in event.request, false);

  const error = new Error("test exception");
  monitoring.captureException(error);
  assert.deepEqual(captured, [error]);
});
