"use strict";

function initGlitchTip({ env = process.env, sdk } = {}) {
  const dsn = env.GLITCHTIP_DSN || env.SENTRY_DSN || "";
  if (!dsn) return { enabled: false, captureException() {} };

  const sentry = sdk || require("@sentry/node");
  sentry.init({
    dsn,
    environment: env.JARVIS_ENVIRONMENT || env.NODE_ENV || "production",
    release: env.RENDER_GIT_COMMIT ? `one-jarvis@${env.RENDER_GIT_COMMIT}` : undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        if (event.request.headers && typeof event.request.headers === "object") {
          for (const key of Object.keys(event.request.headers)) {
            if (/^(authorization|cookie|set-cookie|x-api-key)$/i.test(key)) {
              delete event.request.headers[key];
            }
          }
        }
        if (typeof event.request.url === "string") {
          try {
            const url = new URL(event.request.url);
            url.search = "";
            url.hash = "";
            event.request.url = url.toString();
          } catch {
            event.request.url = "[redacted]";
          }
        }
        delete event.request.data;
        delete event.request.cookies;
      }
      return event;
    }
  });

  return {
    enabled: true,
    captureException(error) {
      sentry.captureException(error);
    }
  };
}

module.exports = { initGlitchTip };
