# ONE JARVIS

株式会社One向けのクラウド業務アシスタントです。

## Current core

- Bearer-token protected API
- Independent department-agent registry (management, tax/accounting, office/subsidies, construction, HR, procurement, recycling, safety/compliance, content, affiliate, investment, trading)
- Explicit owner-approval policy for submissions, payments, contracts, publishing, deletion, and permission changes
- Video production workflow for the `時をかける日本史` channel, including script/source review, Japanese pronunciation checks, narration, assets, editing, QA, owner review, publishing approval, and analytics
- Official subsidy source registry for national, Okayama, Okayama City, Kurashiki, Tokushima, and Yoshinogawa programs
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
- Read-only financial sheet reader for the approved `売上` and `経費` tabs with exact header validation
- Optional invoice / collection reader for `09 請求` and `10 入金`, including outstanding and overdue balances
- Financial aggregates by project/month/category using tax-exclusive amounts, with revenue, expense, difference, and margin
- Dashboard financial summary and AI company Q&A context (financial fields only; no customer, payee, receipt URL, invoice ID, or notes)
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
- `GET /v1/company/financials` (read-only aggregate of up to 99 rows each from `売上` and `経費`; includes receivables when both invoice tabs exist)
- `POST /v1/company/ask` with `{request}` (queues an AI question grounded in daily-report aggregates)
- `GET /v1/departments` (authenticated department roles and approval policy)
- `GET /v1/content/workflow` (authenticated video production stages, quality checklist, and approval gates)
- `GET /v1/subsidy/sources` (authenticated official source catalog and One-specific priority topics)
- `GET /v1/status`
- `GET /v1/jobs`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `POST /v1/jobs/:id/cancel`
- `POST /v1/jobs/:id/retry`

See [core design and deployment](./core/README.md) and [deployment checklist](./DEPLOYMENT.md).

## Not yet complete

This is a tested foundation, not a fully autonomous office system. Department roles and read-only official-source catalog are implemented, but independent model instances, scheduled live research, push notifications, persistent research history, and per-department task queues are not yet connected. Daily-report analytics and aggregate-grounded AI Q&A are limited to the first 99 daily-report rows returned by Apps Script; they are not complete historical financial or profitability reports. Full-history sales/expense/invoice ingestion, tax/accounting adjustments, cost allocation, payroll analytics, arbitrary office actions, Google Sheets writes from the AI worker, desktop control, video generation/publishing, and multiple worker instances are not implemented. Those integrations require separate allowlists, permissions, and end-to-end tests.

Production deployment remains intentionally disabled until the paid persistent disk and service configuration are approved.


## Financial sheet schema

The read-only financial reader requires the exact existing headers below and fails closed if the schema differs. It reads at most 99 data rows per sheet, uses tax-exclusive amounts, and intentionally reads only `売上` and `経費` to avoid double counting separate `外注費` or `材料費` tabs.

- `売上`: `売上ID`, `日付`, `現場ID`, `現場名`, `得意先`, `内容`, `税抜売上`, `消費税`, `税込売上`, `請求ID`, `備考`, `登録日時`
- `経費`: `経費ID`, `日付`, `現場ID`, `現場名`, `区分`, `項目`, `支払先`, `税抜金額`, `消費税`, `税込金額`, `支払方法`, `領収書URL`, `備考`, `登録日時`

The optional invoice reader uses `09 請求` headers `請求ID`, `請求書番号`, `発行日`, `支払期限`, `現場ID`, `現場名`, `得意先`, `税抜金額`, `消費税`, `請求金額`, `入金済額`, `未入金額`, `状態`, `備考`; and `10 入金` headers `入金ID`, `入金日`, `請求ID`, `現場ID`, `現場名`, `得意先`, `入金額`, `入金方法`, `口座`, `備考`. It summarizes billed, received, outstanding, overdue, and reconciliation difference without returning customer names, invoice IDs, bank accounts, payment methods, or notes. The API does not return customer/payee names, invoice IDs, receipt URLs, bank accounts, or notes. The calculated difference is registered tax-exclusive sales minus registered tax-exclusive expenses, not statutory net income or cash profit. Invoice status, collections, receivables, unpaid expenses, separate cost tabs, and unregistered costs are not included.


- `09 請求` / `10 入金` are optional; when both are present with exact headers, JARVIS displays invoice balances, overdue totals, and the difference between payment records and the invoice sheet's recorded received amount. The difference is for reconciliation only and is never auto-corrected.


## Department agents and approvals

Each department has a separate role definition and task scope. Routine research, analysis, classification, internal task creation, and drafts may be prepared autonomously. External submissions, payments, tax filings, contracts, purchases, publishing, deletions, and permission changes require the owner's explicit approval. Department registry and policy are exposed via authenticated `GET /v1/departments`.

## Subsidy / grant monitoring sources

The source catalog prioritizes construction equipment and ICT, battery/solar/electrical work, energy efficiency and GX, recycling/resource circulation, hiring, qualifications and training, wage increases, workplace safety, succession, new business, and AI/DX. It tracks national sources and official Okayama Prefecture, Okayama City, Kurashiki City, Tokushima Prefecture, and Yoshinogawa City pages. Each opportunity should be reported with the official URL, issuer, geography, eligibility, eligible costs, subsidy rate, cap, opening/closing dates, required documents, contact, last verified timestamp, changes, and unresolved eligibility questions. Cached snippets alone are not evidence; verify current official pages and guidelines before presenting an opportunity as open. This repository currently exposes only the source catalog; scheduled research and notifications are not active yet.


## Video department: 時をかける日本史

The content department uses a staged workflow: research, script and source verification, Japanese kanji/name reading and pronunciation review, narration, authorized visual assets, edit/captions, final QA, owner review, publication, and post-publication analytics. QA checks cover historical sourcing, dates/names/amounts, spoken-vs-script alignment, audible completeness, subtitle accuracy and mobile readability, asset rights, black frames/audio loss/export integrity, and honest titles/thumbnails. Paid voice/video generation requires explicit approval for that generation; subscription/purchases require owner approval; publication and scheduling are owner-only actions. The current implementation exposes the workflow and checklist at authenticated `GET /v1/content/workflow`; it does not yet provide scheduled production or autonomous publishing. Existing Descript projects must be inspected before marking any stage complete. The channel is `https://www.youtube.com/@samurai-b6i` and the working project is `江戸大名、借金まみれの真実`.
