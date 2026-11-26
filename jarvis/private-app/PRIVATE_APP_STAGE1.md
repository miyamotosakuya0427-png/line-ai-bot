# ONE JARVIS Private App — Stage 1 implementation record

## Branch
feature/one-jarvis-private-app-pwa-20261126

## Parent
PR #78 exact head at branch creation: f6120e0da0d959eadc009e4b069079be25443a14.

The branch is intentionally stacked on the latest unmerged Command Center branch because PR #78 is the dependency containing the Command Center UI, the 13 department handlers, the Task Registry and the OIDC/session security primitives. It does not modify PR #78.

## Implemented

- PWA shell under jarvis/private-app/.
- Responsive dark navy company-app UI.
- Standalone manifest and custom SVG app icon.
- Static-shell-only service worker cache. API, health and auth paths are excluded.
- Japanese wake-word parser and Web Speech API adapter.
- Explicit microphone start; no automatic or background recording.
- Recognition is stopped on hidden/pagehide.
- No localStorage, sessionStorage, IndexedDB, API fetch, token entry or transcript persistence.
- Unit/security-boundary tests and stage documentation.

## Not implemented / blocked

- No private employee authentication or production session lifecycle.
- No server route exposing the app shell.
- No authenticated JARVIS API integration.
- No live AI response or task execution.
- No real-device tests.

PR #78's existing OIDC code verifies signed ID tokens and PKCE state/nonce, while owner-session-security.js provides cookie/CSRF/session policy primitives. Neither currently implements the complete HTTP authorization-code exchange, trusted IdP transport, persistent session store, CSRF middleware, logout/revocation routes or employee role mapping. The app must remain unserved/unpublished until those are implemented and independently tested.

## Production impact

None. No Render, Neon, LINE, Google Sheets, billing, deployment or external integration was changed.
