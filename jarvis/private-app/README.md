# ONE JARVIS Private App — Stage 1 PWA shell

This is an isolated PWA/voice-interface prototype for the private company app.

## Current scope

- Responsive shell for iPhone, iPad, Android and Windows-sized screens.
- Installable PWA manifest and a service worker that caches only the static app shell.
- Japanese wake phrase parsing for 「ジャービス」 and Jarvis.
- Speech recognition starts only after a user presses the microphone button.
- Recognition stops when the document becomes hidden or the page is closed.
- Speech transcript is held in page memory only.
- No API calls, credentials, personal data, or conversation history are persisted.
- No production API, Task Registry, Neon, Google Sheets, or external action is connected.

## Important security boundary

This branch does not yet provide the private login/session lifecycle. The current Owner OIDC module is a verification primitive and the Owner session helpers are policy primitives; neither is a production HTTP login/session implementation. Do not expose or deploy this PWA shell as a private employee application until the next stage implements and tests server-side authentication, session persistence/revocation, CSRF protection, and server-side role authorization.

Do not place bearer tokens, Owner tokens, API keys, or connection strings in browser storage. Do not connect this prototype directly to /v1 APIs.

## Voice behavior

The microphone is not opened automatically. The user must tap the microphone button while the app is visible. The browser/OS speech recognition provider may process audio outside the device; the UI discloses this. Do not speak secrets or personal data into the prototype.

The current UI acknowledges a detected phrase locally. It intentionally does not send the transcript to JARVIS or execute tasks.

## Test

From jarvis/ run: npm test

The test file checks manifest metadata, wake phrase parsing, browser recognition constructor selection, cache boundaries, and the absence of persistent token storage/API submission.

## Not yet implemented

- Server-side OIDC authorization-code exchange and trusted live IdP configuration.
- Secure __Host- session cookie lifecycle and persistent/revocable session store.
- CSRF middleware, login/logout/session endpoints, employee account mapping and role enforcement.
- Authenticated JARVIS conversation/task APIs.
- Actual AI-generated voice responses.
- Physical device and install tests.
- Private hosting/domain and deployment.

No production environment has been changed by this branch.
