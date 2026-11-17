# Task Registry API runtime authentication

The API is opt-in and fails closed unless all runtime dependencies are configured.

## Required runtime flags

- `JARVIS_STORAGE_MODE=postgres`
- `JARVIS_TASK_REGISTRY_API_ENABLED=true`
- `JARVIS_TASK_REGISTRY_AGENT_TOKENS`: JSON object keyed by stable agent ID. Each entry contains a SHA-256 token hash, an explicit scope list, and an optional opaque conversation ID.

Example shape (replace the placeholder hash with a locally generated 64-character SHA-256 hex digest; never commit a raw token):

```json
{
  "worker-a": {
    "tokenHash": "REPLACE_WITH_64_HEX_SHA256",
    "conversationId": "opaque-conversation-a",
    "scopes": ["tasks:read", "tasks:claim", "tasks:lease", "tasks:transition"]
  }
}
```

Generate the hash locally from a high-entropy bearer token; store the raw token only in the authorized secret manager and give it to the intended worker out-of-band. The server hashes each supplied bearer token and compares the digest using constant-time comparison. Agent IDs, conversation IDs, and scopes are returned to the API as the authenticated principal.

## Fail-closed startup

When the feature flag is off, Task Registry routes remain unavailable (503). When enabled, startup requires PostgreSQL mode, a valid agent-token map, and an already-applied Task Registry migration 0004. `createTaskRegistry.init()` only checks the required tables; it does not apply migration 0004. No Render environment variable, Neon schema, or production deployment is changed by this code.

Scopes:
- `tasks:read`
- `tasks:write`
- `tasks:dispatch`
- `tasks:claim`
- `tasks:lease`
- `tasks:transition`
- `resources:lease`

This is bearer-token authentication for service agents, not end-user authentication. Rotate a compromised token by replacing its hash in the secret configuration and revoking the old token.
