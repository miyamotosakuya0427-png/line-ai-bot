# ONE JARVIS deployment checklist

This checklist is intentionally separate from the production LINE webhook service.

## Scope and current observed state

- Target Render service: `one-jarvis` (Singapore), not `line-ai-bot-4`.
- Observed service branch: `one-jarvis-foundation`.
- Intended code branch: `jarvis-paper-trading-learning`.
- Observed plan: Free, one instance, auto-deploy off.
- The integrated code includes owner-only approval authorization and GlitchTip-compatible error monitoring.
- PR #35 adds CI coverage for the integrated branch and remains a separate review/merge step.

Do not change the Render branch, plan, disk, environment, instance count, or deployment without explicit approval. Do not enable auto-deploy as part of this checklist.

## Persistent storage

Production job processing must use a Render persistent disk. Do not point JSONL stores at the application directory or an ephemeral filesystem.

- Suggested mount path: `/var/data`
- Suggested job journal: `/var/data/jobs.jsonl`
- Approval journal: `JARVIS_APPROVAL_STORE_PATH`, or the default `/var/data/jobs.jsonl.approvals`
- Other stores are created alongside the job journal:
  - `jobs.jsonl.video-batches.jsonl`
  - `jobs.jsonl.paper-trading.jsonl`
  - `jobs.jsonl.influence-events.jsonl`

The stores are append-only JSONL files with fsync-backed writes. The current implementation is single-process/single-instance: file locking and multi-instance coordination are not implemented. Keep exactly one service instance. Configure backups/retention appropriate to the business records before relying on this as the only copy.

A persistent disk is a paid-resource and deployment change. Confirm the current Render dashboard price, disk size, tax, and any other usage before approving. Do not rely on historical price estimates in old notes.

## Environment variables

Required for the API and queue:

- `JARVIS_API_TOKEN`: strong random secret, at least 32 bytes.
- `JARVIS_JOB_STORE_PATH=/var/data/jobs.jsonl`: absolute path on the persistent disk.

Required to enable the AI worker:

- `JARVIS_WORKER_ENABLED=true`
- `OPENAI_API_KEY`: user-managed OpenAI API key.

Required for owner-only approval review:

- `JARVIS_OWNER_TOKEN`: separate strong random secret, at least 32 bytes. Do not reuse `JARVIS_API_TOKEN` or any LINE production token.

Recommended / optional:

- `JARVIS_APPROVAL_STORE_PATH=/var/data/approvals.jsonl` (otherwise defaults to `<JARVIS_JOB_STORE_PATH>.approvals`).
- `GLITCHTIP_DSN`: GlitchTip project DSN; alternatively the code accepts `SENTRY_DSN`.
- `JARVIS_ENVIRONMENT=production`.
- `JARVIS_WORKER_POLL_MS=1500`.
- `JARVIS_OPENAI_MODEL`: optional model override; code default applies when omitted.
- `JARVIS_CONTENT_AUTOPLAN_ENABLED` and `JARVIS_SUBSIDY_AUTOMONITOR_ENABLED`: leave unset/false until their scheduled tasks have been separately reviewed and approved.

Never copy secrets into source code, PRs, logs, or chat. Set them directly in the Render environment UI. Do not reuse production LINE webhook credentials.

## Release sequence

1. Review the security and owner-only approval changes already integrated into `jarvis-paper-trading-learning`.
2. Review the GlitchTip integration already present on that branch; verify the DSN is stored only in Render environment settings.
3. Review and merge the CI-target-branch PR only after its latest checks pass and the change is approved.
4. Separately approve any paid Render plan/disk cost before provisioning persistent storage.
5. Attach the approved persistent disk to `one-jarvis` at `/var/data`.
6. Set the environment variables above without replacing unrelated existing values. Keep worker/autoplan flags off until the release test plan is approved.
7. Only after explicit deployment approval, change the `one-jarvis` service branch to `jarvis-paper-trading-learning` and deploy with auto-deploy still off.
8. Verify health, authenticated API access, owner-only approval access, queue creation, stored result recovery, interrupted-job recovery, journal permissions, GlitchTip error capture/redaction, and restart recovery.
9. Verify the production LINE webhook service and live Sheets remain unchanged.

## Execution and retry guarantees

- Owner approval records an authorization decision; it does not execute external publishing, submissions, payments, purchases, deletion, or permission changes.
- The worker is single-process and serial. Interrupted running jobs are re-queued at startup. A handler may therefore run again after an interruption.
- Any future external integration must independently verify the approval record and implement provider-side idempotency/reconciliation before side effects. Do not treat a persistent disk alone as an exactly-once execution guarantee.

## Explicit exclusions

Do not change `line-ai-bot-4`, root `server.js`, Apps Script, the production LINE webhook, live Google Sheets data/schema, or existing video projects as part of this JARVIS deployment. This document does not authorize deployment, paid resources, environment changes, or production data changes.
