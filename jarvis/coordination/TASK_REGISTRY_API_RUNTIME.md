# Task Registry API runtime authentication

The API is opt-in and fails closed unless all runtime dependencies are configured.

## Required runtime flags

- `JARVIS_STORAGE_MODE=postgres`
- `JARVIS_TASK_REGISTRY_API_ENABLED=true`
- `JARVIS_TASK_REGISTRY_AGENT_TOKENS`: JSON object keyed by stable agent ID. Each entry contains a SHA-256 token hash, an expiry timestamp, an explicit scope list, project IDs, optional resource prefixes, an optional opaque conversation ID, and an optional revocation flag.

Example shape (replace the placeholder hash with a locally generated 64-character SHA-256 hex digest; never commit a raw token):

```json
{
  "worker-a": {
    "tokenHash": "REPLACE_WITH_64_HEX_SHA256",
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "revoked": false,
    "conversationId": "opaque-conversation-a",
    "projectIds": ["one-jarvis"],
    "resourcePrefixes": ["branch:one-jarvis:", "path:one-jarvis:"],
    "scopes": ["tasks:read", "tasks:claim", "tasks:lease", "tasks:transition", "resources:lease"]
  }
}
```

Generate the hash locally from a high-entropy bearer token; store the raw token only in the authorized secret manager and give it to the intended worker out-of-band. The server hashes each supplied bearer token and compares the digest using constant-time comparison. Expired or revoked tokens are rejected on every request. Set `revoked: true` to disable a token; rotate its hash and expiry when issuing a replacement. Entries with omitted project IDs are restricted to `one-jarvis`. Agents granted `resources:lease` must provide at least one explicit resource prefix. Agent IDs, conversation IDs, project IDs, resource prefixes, and scopes are returned to the API as the authenticated principal.

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

The API applies a default in-memory limit of 120 authenticated requests per agent per 60-second window and returns HTTP 429 with Retry-After when exceeded. This default is process-local; multi-instance deployments must inject a shared rate-limiter implementation through the server's `taskRegistryRateLimiter` option to enforce a cluster-wide quota.

This is bearer-token authentication for service agents, not end-user authentication. Rotate a compromised token by revoking its old entry and issuing a new high-entropy token hash with a bounded expiry. Resource prefixes use the form `resource-type:project-id:` and must be narrowly scoped.
