# JARVIS durable job queue

The JARVIS core now includes an append-only, fsync-backed job journal, an allowlisted worker, and a text-only OpenAI assistant handler.

## Persistent storage

Set `JARVIS_JOB_STORE_PATH` to an absolute path on a persistent mounted disk. Do not use the application directory or an ephemeral filesystem in production. The service deliberately returns HTTP 503 for job endpoints if no job store is configured.

The journal uses append-only JSONL events and fsync before acknowledging writes. It supports idempotency keys, bounded payloads/results, recovery after restart, and fail-closed corruption detection. A single process must own the journal; multi-instance file locking is not implemented.

## API

All endpoints require the JARVIS bearer token:
- `POST /v1/jobs` creates an `assistant.request` job. JSON: `{"type":"assistant.request","payload":{"request":"..."}, "idempotencyKey":"optional"}`
- `GET /v1/jobs?status=queued&limit=50` lists jobs.
- `GET /v1/jobs/:uuid` reads status and stored result.
- `POST /v1/jobs/:uuid/cancel` cancels queued/failed jobs.
- `POST /v1/jobs/:uuid/retry` requeues a failed job.

The API only accepts a fixed assistant request type and bounded plain text. It does not accept arbitrary commands, code, tool names, or URLs.

## Worker

The worker processes one job at a time through an explicit handler allowlist. It stores the generated answer with the job result. Transient provider errors (HTTP 429/5xx) are retried up to three attempts; permanent errors are marked failed. Interrupted running jobs are returned to the queue at startup.

Worker activation is opt-in:
- `JARVIS_WORKER_ENABLED=true`
- `OPENAI_API_KEY` must be configured
- `JARVIS_JOB_STORE_PATH` must point to the mounted persistent disk
- Optional `JARVIS_WORKER_POLL_MS` (250–60000; default 1500)
- Optional `JARVIS_OPENAI_MODEL` (default `gpt-5.6-luna`)

If worker activation is false or storage is absent, the API can be tested with an injected temporary store in CI, but the deployed service will not execute jobs. The worker generates text answers only; it does not perform external actions or mutate Google Sheets.

## Deployment safety

This branch is not deployed. Before enabling the worker in production, provision and verify a persistent disk, ensure exactly one Render instance owns it, set the required environment variables, and run an approved end-to-end test. Do not modify the production LINE server, Apps Script, Google Sheets schema, or daily-report flow as part of this JARVIS core.
