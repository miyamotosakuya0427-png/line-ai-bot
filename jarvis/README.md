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
- `GET /v1/approvals` (authenticated approval journal; bearer-token access, without separate human identity proof)
- `POST /v1/approvals` (record an owner approval request)
- `POST /v1/approvals/:id/decision` (record approved/rejected decision; never executes external work)
- `GET /v1/jobs`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `POST /v1/jobs/:id/cancel`
- `POST /v1/jobs/:id/retry`

See [core design and deployment](./core/README.md) and [deployment checklist](./DEPLOYMENT.md).

## Not yet complete

This is a tested foundation, not a fully autonomous office system. Department role-scoped handlers and a durable task queue are implemented, but separate model instances, push notifications, persistent long-term research history, and multiple worker instances are not. Daily-report analytics and financial aggregates are limited to the first 99 rows per sheet returned by Apps Script; they are not complete historical financial or profitability reports. Tax/accounting adjustments, cost allocation, payroll analytics, arbitrary office actions, Google Sheets writes from the AI worker, desktop control, direct Descript/Metricool/vidIQ service integration, automatic video rendering, and external publishing are not implemented. The video batch queue and owner review inbox can register and manage up to 100 ideas, but they do not generate or publish media. Those integrations require separate allowlists, permissions, provider credentials, and end-to-end tests.

Production deployment remains intentionally disabled until the paid persistent disk and service configuration are approved.

The approval journal uses `JARVIS_APPROVAL_STORE_PATH`; if omitted while `JARVIS_JOB_STORE_PATH` is configured, it defaults to `<JARVIS_JOB_STORE_PATH>.approvals` on the same persistent volume. The authenticated approval API and dashboard persist pending/approved/rejected decisions. Approval is a recorded authorization state only: this release does not execute YouTube publishing, external submissions, payments, purchases, deletion, or permission changes. Each external integration must separately verify the approval record and implement its own execution safeguards. The dashboard labels approved requests as not executed.


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

The content department uses a staged workflow: research, script and source verification, Japanese kanji/name reading and pronunciation review, narration, authorized visual assets, edit/captions, final QA, owner review, publication, and post-publication analytics. QA checks cover historical sourcing, dates/names/amounts, spoken-vs-script alignment, audible completeness, subtitle accuracy and mobile readability, asset rights, black frames/audio loss/export integrity, and honest titles/thumbnails. Paid voice/video generation requires explicit approval for that generation; subscription/purchases require owner approval; publication and scheduling are owner-only actions. The current implementation exposes the workflow and checklist at authenticated `GET /v1/content/workflow`; the opt-in scheduler queues a daily planning task only; it does not yet provide automatic narration generation, video rendering/editing, or autonomous publishing. Existing Descript projects must be inspected before marking any stage complete. The channel is `https://www.youtube.com/@samurai-b6i` and the working project is `江戸大名、借金まみれの真実`.


### Researched video drafts

Two independently tracked 8–12 minute narration drafts are stored under `jarvis/content/`: `episode-001-kameyama-finance.md` and `episode-002-meireki-fire.md`. Each includes a source register, pronunciation checklist, visual plan, and explicit fact-check caveats. Their tests enforce key numerical/source claims and a target narration length. These are script drafts, not rendered or published videos.

The Descript registry records measured project media durations: the Edo-daimyo composition is 74 seconds with a 33.28-second audio file; the Edo-fire composition is 24 seconds with audio assets around 32.31 and 32.83 seconds, plus a separate 32.31-second pronunciation-check project. The existing audio names identify Kenichi and one transcript speaker label is Hayama, while the selected default preference is Hinata. These assets must not be treated as finished 8–12 minute videos or overwritten without review.

Descript, Metricool, and vidIQ connections available inside ChatGPT are not automatically available inside the Render-hosted JARVIS process. No server-side credentials/adapters for those ChatGPT connectors have been verified. Do not mark media editing, export, scheduling, or publishing as integrated until a separate supported server-side API connection and end-to-end test exist.

### Video agent execution and scheduler

The JARVIS worker registers an isolated role-scoped AI handler for each department (`department.<id>`). Authenticated `POST /v1/departments/:id/tasks` and `POST /v1/content/tasks` enqueue durable, idempotent tasks; results are visible in the job journal. ONE CONTENT has a dedicated Japanese-history prompt for 8–12 minute drafts, fact/source uncertainty handling, kanji readings, narration/subtitle alignment, and strict non-publication rules.

Important integration boundary: Descript, Metricool, and vidIQ connections available inside ChatGPT are not automatically available inside the Render-hosted JARVIS process. The current Render service has no verified server-side credentials/adapters for those ChatGPT connectors. JARVIS can prepare durable research and production tasks, but it cannot directly edit/export Descript projects, sync Metricool analytics, or schedule/publish YouTube posts until a supported server-side API integration is configured and tested. Do not copy ChatGPT connector secrets into the repository.

The daily content planner is opt-in via `JARVIS_CONTENT_AUTOPLAN_ENABLED=true` and requires the persistent job store, `JARVIS_WORKER_ENABLED=true`, and a running service. It enqueues one idempotent planning task per Japan-local date at 08:45 JST. It creates a concept/outline/source-checklist draft only; it does not generate paid audio/video or publish. The flag is not enabled in the current Render environment and this PR is not deployed.

Verified Descript projects are tracked separately: `072f8671-af62-480c-8072-bb253faf58b7` is `江戸大名、借金まみれの真実` (74-second composition, no publishes), and `5b28e058-e58b-41a7-9a26-0164aaea9ca6` is the separate `江戸の大火` project. The selected default voice preference is Hinata; the Edo-daimyo project's existing audio filename identifies Kenichi, so voice consistency remains a review item. Existing media is never overwritten automatically.


### Daily subsidy monitoring

ONE OFFICE has an official-source fetcher with an HTTPS host allowlist derived from the curated source catalog. It strips scripts/styles, captures bounded page excerpts and timestamps, labels fetch failures as unavailable (not as program closure), and asks the role-specific AI to distinguish source landing pages from verified program guidelines. The daily scheduler is opt-in via `JARVIS_SUBSIDY_AUTOMONITOR_ENABLED=true`; it queues one idempotent office task per Japan-local date at 08:30 JST and requires the persistent job store plus active worker. The environment flag is not enabled in Render yet. The independent ChatGPT daily report automation is separate from this JARVIS scheduler.


### Tax and management agent context

When a tax or management task asks about sales, expenses, invoices, collections, profit, accounting, tax, or cash flow, JARVIS attempts a read-only fetch of the allowlisted financial tabs. It validates exact headers, uses the bounded 99-row sample, and attaches only aggregates to the department task. Customer/payee names, site names, expense item descriptions, invoice identifiers, receipt URLs, bank accounts, employee personal data, and free-text notes are not attached; project aggregates use only the internal site ID and expense categories use only the structured `区分` field. If the tabs are missing or fail schema validation, the task receives an explicit unavailable status rather than invented figures. Invoice/collection reconciliation is included only when both optional invoice and payment tabs pass validation. The optional tab names `09 請求` and `10 入金` and their exact headers are implementation assumptions from the proposed sheet design, not a verified live spreadsheet schema; the reader fails closed if they are absent or differ. Do not treat receivables figures as live until the actual sheet names and headers are confirmed.


The subsidy monitor also stores bounded SHA-256 fingerprints for successfully fetched official pages in each completed job result and compares them with the previous completed run. It classifies each source as new, changed, unchanged, or unverified; an unavailable page is never interpreted as a closed subsidy. Only source metadata/fingerprints are retained for comparison, not full page dumps.


### Department-specific company context

Construction tasks about site activity or daily reports receive read-only aggregate analytics from `03 日報` (maximum 99 sampled rows): site counts, worker-days, estimated person-hours, equipment, and recent work dates. Employee names, IDs, phone numbers, pay, free-text notes, and row-level reports are not passed to the construction agent. Missing or invalid sheet data is reported as unavailable rather than estimated.
- `GET /v1/content/batches` and `POST /v1/content/batches` (authenticated persistent video queue, up to 100 ideas per batch)
- `GET /v1/content/approvals` (video owner-review inbox)
- `GET /v1/content/videos/:id/plan` (read the associated ONE CONTENT draft-job status/result)
- `POST /v1/content/videos/:id/plan` (enqueue an authenticated ONE CONTENT research/script draft job; completed output is shown in the video queue but is not automatically saved into the script field or advanced to the next stage)
- `POST /v1/content/videos/:id/draft` (save the matching successful ONE CONTENT result into the video script field and mark it `needs_source_review`; this does not mark the sources as verified)
- `POST /v1/content/videos/:id/stage`, `/review`, and `/action-approval` (ordered stage updates, review decisions, and scoped expiring action-approval records)

### Video batch queue

The video batch journal is stored at `<JARVIS_JOB_STORE_PATH>.video-batches.jsonl` and is initialized alongside the job journal. It supports up to 100 ideas per batch, separate channel identifiers, ordered production stages, owner review decisions (approve / request changes / hold), and scoped action-approval records with provider, cost estimate, destination, and expiry. Finance-channel bulk registration is blocked in both the dashboard and store/API until a verified destination and financial controls are configured. Queue registration only creates ideas; it does not start research, paid generation, editing, uploads, scheduling, or publication. A provider executor is not connected. Approval actions are verified records only and must not be treated as completed external work.

The general approval journal and video-specific review inbox are separate: `/v1/approvals` handles cross-department authorization records, while `/v1/content/approvals` is the video-batch review inbox. Both use the shared JARVIS bearer token. This authenticates API access but does not independently prove the human owner's identity. Add a separate owner identity control before enabling consequential external execution.
