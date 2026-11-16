# ONE JARVIS deployment checklist

This checklist is intentionally separate from the production LINE webhook service.

## Render service

Target service: `one-jarvis` (Singapore), not `line-ai-bot-4`.

Current observed configuration: Free plan, one instance, auto-deploy off, branch `one-jarvis-foundation`. Do not change it until the code PRs are reviewed and merged in order.

Persistent job storage requires a paid Render web service with a persistent disk. Verify the current plan, disk pricing, region, and total monthly cost directly in the Render dashboard immediately before any purchase or configuration change; do not rely on old price estimates.

## Disk

- Mount path: `/var/data`
- Initial disk size: 1 GB
- Journal path: `/var/data/jobs.jsonl`

Render persistent disks are available only on paid web services, survive restarts/deploys, and are attached to a single service instance. Disk-backed services cannot scale horizontally and disk attachment causes a redeploy with a brief interruption.

## Required environment

- `JARVIS_API_TOKEN`: service-to-service API secret, at least 32 bytes
- `JARVIS_OWNER_TOKEN`: separate owner credential, at least 32 bytes; required for company data, raw Sheets reads/diagnostics, approvals, and video owner review/action approvals
- `JARVIS_JOB_STORE_PATH=/var/data/jobs.jsonl`
- `JARVIS_WORKER_ENABLED=true`
- `OPENAI_API_KEY`: user-managed OpenAI API key
- `JARVIS_SHEETS_URL`: HTTPS Apps Script Web App URL (when Sheets integration is enabled)
- `JARVIS_SHEETS_TOKEN`: server-only Apps Script shared secret; never expose to LIFF/browser clients
- `LINE_LOGIN_CHANNEL_ID` and `LIFF_ID`: only when the LINE LIFF identity and daily-report interface is enabled
- Optional `JARVIS_APPROVAL_STORE_PATH=/var/data/approvals.jsonl`
- Optional `GLITCHTIP_DSN` or `SENTRY_DSN` for error monitoring
- Optional `JARVIS_OPENAI_MODEL=gpt-5.6-luna`
- Optional `JARVIS_WORKER_POLL_MS=1500`

For initial administrator bootstrap, set the Script Property `JARVIS_INITIAL_ADMIN_LINE_USER_ID` manually to the intended verified LINE user ID in the test deployment first. Never place this value in source code.

Never copy or print API secrets into source code, PRs, logs, or chat. Do not reuse the production LINE webhook token.


## Identity and access boundary

- The general API token is not a human identity. Sensitive company/financial data, raw Sheets reads, and approval inbox/decisions require `JARVIS_OWNER_TOKEN`.
- LINE user-facing operations use verified LINE ID tokens. Employee directory enumeration is disabled; the employee must enter an ID provided by the company.
- Apps Script's shared token is server-only. Generic `appendRows` writes are disabled; each supported write must use a dedicated validated action.
- The Apps Script mock tests and Node tests do not replace a real test deployment. Validate Script Properties, the LINE Login channel, LIFF configuration, LockService concurrency, spreadsheet permissions, and exact headers against a disposable test spreadsheet before production.
- The application audit sheet is append-only by application behavior, not immutable against a Google Sheets editor with sufficient privileges. Restrict editors and maintain an independent backup/audit copy.

## Release order

1. Review the current Draft PR stack and dependencies (#37–#42, plus the CI/docs PRs) against `jarvis-paper-trading-learning`; verify combined CI after the intended merge order is established.
2. Merge only the explicitly approved code PRs, preserving the separate owner-token and LINE identity boundaries.
3. Obtain separate explicit approval before changing the `one-jarvis` Render plan, adding a persistent disk, changing environment variables, or deploying.
4. Before any deploy, verify the current Render plan/cost, branch, root directory, build/start commands, disk mount, and environment variables.
5. Keep instance count at one and auto-deploy off until a planned deploy is approved.
6. Use a disposable Google spreadsheet and Apps Script test deployment to validate the real Google runtime before touching production.
7. After an approved deploy, verify health, owner-only access, LIFF identity, daily-report idempotency, job persistence, restart recovery, and error retry.
8. Do not change `line-ai-bot-4`, the production LINE webhook, live Google Sheets, or production Apps Script without separate explicit authorization.

No deployment, paid resource, environment change, or production data change is authorized by this document.
