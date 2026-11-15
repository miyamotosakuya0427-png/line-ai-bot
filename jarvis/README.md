# ONE JARVIS

株式会社One向けのクラウド業務アシスタントです。

## Current core

- Bearer-token protected API
- Persistent JSONL job journal with fsync
- Idempotent job submission
- Queue listing, detail, cancellation, and retry
- Single-process FIFO worker
- OpenAI Responses API text assistant
- Stored AI results and transient-error retries
- Mobile-friendly web dashboard at `/`
- Optional read-only Google Sheets API routes already present in the service
- Authenticated read-only company APIs for approved employee and daily-report sheets
- Daily-report aggregation (site counts, worker-days, estimated person-hours, equipment counts)
- Company-context AI Q&A job that sends aggregate data only, not employee personal data
- Validated financial aggregation primitives for revenue, expenses, project/month/category totals, profit, and margin (not connected to live sheets until their schema is confirmed)
- Schema validation and field filtering (employee pay, phone, and notes are excluded from the employee API)

## Run locally

Node.js 20 or later is required.

```sh
cd jarvis
npm install
JARVIS_API_TOKEN='a-long-random-secret-at-least-32-bytes' npm start
```

For local queue testing, use a temporary absolute path:
```sh
JARVIS_JOB_STORE_PATH=/tmp/jarvis/jobs.jsonl
```

To enable the AI worker locally, also set `OPENAI_API_KEY` and `JARVIS_WORKER_ENABLED=true`. Never commit secrets.

## Use the dashboard

Open the service root URL, enter the JARVIS API token, connect, and submit a request. The dashboard checks the job status and displays the stored answer. The token stays in page memory and is not written to browser storage.

## API overview

All API endpoints except `GET /health` and the dashboard shell require `Authorization: Bearer <token>`.

- `GET /v1/company/overview` (read-only counts and five recent reports)
- `GET /v1/company/employees` (approved non-sensitive employee fields)
- `GET /v1/company/daily-reports?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=20`
- `GET /v1/company/analytics` (aggregate sample of up to 99 daily reports)
- `POST /v1/company/ask` with `{request}` (queues an AI question grounded in daily-report aggregates)
- `GET /v1/status`
- `GET /v1/jobs`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `POST /v1/jobs/:id/cancel`
- `POST /v1/jobs/:id/retry`

See [core design and deployment](./core/README.md) and [deployment checklist](./DEPLOYMENT.md).

## Not yet complete

This is a tested foundation, not a fully autonomous office system. Daily-report analytics and aggregate-grounded AI Q&A are limited to the first 99 daily-report rows returned by Apps Script; they are not complete historical financial or profitability reports. Live sales/expense sheet ingestion, invoicing/receivables, tax/accounting adjustments, cost allocation, payroll analytics, arbitrary office actions, Google Sheets writes from the AI worker, desktop control, video generation/publishing, and multiple worker instances are not implemented. Those integrations require separate allowlists, permissions, and end-to-end tests.

Production deployment remains intentionally disabled until the paid persistent disk and service configuration are approved.
