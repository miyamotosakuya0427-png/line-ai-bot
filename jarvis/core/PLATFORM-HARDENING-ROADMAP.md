# 株式会社One / ONE JARVIS — Cross-project hardening roadmap

Review date: 2026-11-16

This document is an operational truth register, not a claim that every item is deployed. Status is based on the connected GitHub, Render, Descript, Metricool, and vidIQ records available during this review. Re-check before changing production.

## 1. Non-negotiable operating rules

- Keep the production LINE webhook service `line-ai-bot-4` and root `server.js` isolated from JARVIS feature development.
- Do not alter the existing Apps Script project or live Google Sheets tabs/headers without explicit owner approval.
- Do not merge or deploy stacked draft PRs until the exact head SHA passes both required test workflows and the diff is reviewed.
- No real-money trading, external submissions, payments, contracts, purchases, public posting, destructive actions, or permission changes without scoped owner approval.
- Never treat an AI claim, source URL, source fetch, transcript, or caller-supplied evidence as independently verified.
- Prefer idempotent, append-only, bounded operations. Fail closed on corruption, stale data, missing permissions, or schema drift.
- Never store credentials in prompts, browser local storage, source files, or ordinary logs. Use separate least-privilege credentials per provider.
- A system is not "complete" merely because a PR is open, a build passed, or a provider import succeeded.

## 2. Runtime and deployment

### Observed
- Render service `one-jarvis` exists at `https://one-jarvis.onrender.com`.
- Service is on the Free plan, with starter build plan, Singapore region, one instance, AutoDeploy off, and branch `one-jarvis-foundation`.
- The latest listed live deployment is the older foundation commit `f3d6203c236257fc1248d03d092d4202eaf8bd66`; the current feature PR stack is not deployed.
- Durable JSONL job, approval, video, trading, and influence journals require a persistent mounted disk. The current Free service has no verified persistent disk.
- The JARVIS worker and scheduled content/subsidy tasks are opt-in; they are not confirmed active in Render.

### Required before production activation
1. Select the intended paid Render workspace/resource only after the owner confirms billing and the exact workspace.
2. Attach and verify a persistent disk; test restart recovery, disk-full handling, and backup/restore.
3. Configure one worker instance for JSONL journals; do not horizontally scale a file-backed journal.
4. Configure a health/readiness split: liveness can pass while dependencies are degraded; readiness must fail when durable storage or required secrets are unavailable.
5. Add bounded graceful shutdown, worker lease recovery, dead-letter handling, retry backoff, and operational alerts.
6. Keep AutoDeploy disabled until a reviewed release process is approved.

## 3. Security and owner approvals

### Existing foundation
- JARVIS uses bearer authentication for protected APIs.
- The LINE initial administrator registration and employee link approval flow were implemented in the separate JARVIS service; EMP003 is the initial admin and no pending request was recorded in the earlier review.
- The approval ledger and scoped/expiring action approvals exist in the draft stack.

### Remaining hardening
- A shared bearer token proves possession of a token, not the human owner's identity. Add short-lived owner sessions tied to verified LINE LIFF identity, role, expiry, and audience.
- Separate owner, department-agent, read-only analytics, provider-ingestion, and worker credentials. Never reuse the same bearer token across agents.
- Require step-up owner confirmation for payment, publication, external submission, contract, account, permission, and deletion actions.
- Make approval scope immutable and bind it to exact action, provider, destination, content hash, amount/cost cap, and expiry. Any changed payload invalidates approval.
- Add replay protection, idempotency keys, request-size limits, rate limits, CSRF/origin controls for browser sessions, and audit events with redacted payloads.
- Add secret rotation procedures and ensure secrets are not returned by diagnostics.
- Add backup integrity checks and periodic restore drills.

## 4. Company operations and Google Sheets

### Existing foundation
- Schema-checked, read-only readers exist for `01 従業員` and `03 日報`.
- Read-only company analytics and privacy-filtered AI question context exist in the draft stack.
- Financial aggregation readers are drafted for `売上`, `経費`, and optional `09 請求` / `10 入金` schemas.
- Employee names, phone numbers, pay rates, notes, customer/payee names, receipt URLs, bank accounts, and payment methods are excluded from the finance/AI aggregate context.

### Remaining hardening
- The new context loader assumes the approved tab names `01 従業員`, `03 日報`, `04 売上`, `05 経費`, `09 請求`, and `10 入金`; these names and headers still require a live read-only audit against the deployed Apps Script endpoint. Finance and receivables context stays unavailable unless exact schemas validate.
- Current readers sample at most 99 rows. Replace with cursor-based bounded pagination and an explicit historical completeness watermark before using totals for decisions.
- Add reconciliation for duplicate IDs, missing dates, tax rounding, invoice/collection mismatches, deleted rows, late entries, and corrected records.
- Keep revenue, expenses, accounting profit, cash flow, receivables, and statutory tax figures separate; never label a partial sample as a full-period total.
- Add immutable daily snapshots and data-quality reports before any write automation.
- Service-account JSON keys are prohibited by the user's Google organization policy. Continue the approved Apps Script authorization model; do not try to bypass that policy.
- Do not modify existing Apps Script source or live sheet headers as part of this roadmap.

## 5. Department agents and subsidy research

### Existing foundation
- Role definitions cover JARVIS, management, tax/accounting, office/subsidies, construction, HR, procurement, recycling, safety/compliance, content, affiliate, investing, and trading.
- Department-specific handlers and authenticated durable task APIs exist in the draft stack.
- ONE OFFICE official-source catalog covers national, Okayama, Kurashiki, Tokushima, and Yoshinogawa sources.
- Daily ONE OFFICE subsidy research and ONE CONTENT planning are opt-in schedules, not confirmed active.

### Remaining hardening
- The role registry is not equivalent to separate always-on independent agent runtimes. Add per-department queues, budgets, tool allowlists, data scopes, and failure isolation.
- Add source freshness timestamps, changed-page fingerprints, deadline/eligibility evidence, and explicit "not found / unavailable / unverified" states.
- Verify each subsidy against the current official guideline and company/site eligibility before recommending application.
- Require owner approval for applications, submissions, contracts, payments, or representations to government agencies.
- Add a daily digest and escalation only after persistent storage and notification delivery are verified.

## 6. Video and YouTube automation

### Existing foundation
- ONE CONTENT supports long-form Japanese history workflow stages, a 100-item video batch, idempotent queueing, owner review, and evidence-gated transitions.
- Official-source fetching and source-review worker chaining are drafted in PR #23 and PR #24; fetched pages and snapshots remain explicitly unverified until claim-level human/source QA.
- PR #16's latest checked head and PR #23/#24 latest checked heads have both JARVIS test workflows passing.
- Metricool brand `8122722` is connected to the same YouTube channel ID reported by vidIQ: `UCtQYoMJ3ztAKI9WuQmac7jQ`, handle `@samurai-b6i`, timezone `Asia/Tokyo`.
- No Metricool scheduled posts were found in the reviewed date window.
- vidIQ reports 1 subscriber, 0 lifetime views, and 0 public videos at the time of review.
- Descript projects include a 74-second composition for `江戸大名、借金まみれの真実`, a 24-second scene-assets composition for `江戸の大火`, and a 32-second narration read-check. No project is a completed 8–12 minute episode; no publish record exists.
- Descript agent editing previously returned an insufficient-AI-credits error. Do not retry paid generation without explicit cost approval.

### Remaining hardening
- Produce a full 8–12 minute episode with a verified script, claim register, source excerpts, kanji readings, number pronunciation, voice audition, complete narration, licensed assets, full timeline, render, playback QA, and owner approval.
- Distinguish the actual selected voice from filenames/transcript speaker labels; audition before reuse.
- Add exact YouTube AI-disclosure, copyright, likeness, music-rights, thumbnail, title, description, chapters, end-screen, and child-safety checks before upload.
- A source fetch is not a factual verification. A generated evidence checklist is not factual verification. A caller-entered stage assertion is not independent provider evidence.
- Keep uploads private/unlisted for QA; publication and scheduling require scoped owner approval.
- Connect Metricool and vidIQ to the JARVIS service only through separate authorized server-side adapters; ChatGPT app connections do not automatically provision Render credentials.
- After publication, reconcile YouTube video IDs and Metricool analytics before replanning the next batch.

## 7. ONE TRADER and influence monitoring

### Existing foundation
- Paper-trading engine and persistent journal are simulation-only; there is no broker connection or live order route.
- Current paper defaults are research guardrails: 0.5% modeled risk per trade, 2% daily realized loss halt, 8% peak drawdown halt, and five open positions.
- Daily realized-loss halt now expires on the next market-local day; peak drawdown remains latched; open-position cap is an entry block, not a permanent halt.
- Influence event archive stores original text, author/handle, platform, source URL, post/observation timestamps, verification class, and deduplication key.
- API-submitted influence events are forced to `unverified`; API callers cannot self-assert official/ licensed provenance.
- The influence archive has authenticated, read-only listing and authenticated event intake; it does not analyze or trade from posts.

### Remaining hardening
- Add official X and Truth Social access only after terms, cost, rate limits, data rights, and credential scopes are reviewed. Do not scrape or bypass platform controls.
- Add provider-specific adapters, cursor/watermark recovery, edit/delete/correction tracking, duplicate handling, and source outage alerts.
- Build claim extraction and analysis with source citations, event time vs received time, affected instruments, horizon, direction, confidence, uncertainty, counter-evidence, and explicit no-trade outcomes.
- Never allow sentiment alone to trigger an order. Verify claims against primary sources and independent market data.
- Add licensed market-data adapters, market calendars, corporate actions, delisted symbols, point-in-time fundamentals, spread/fees/slippage/partial-fill assumptions, and no-look-ahead protections.
- Use walk-forward, untouched out-of-sample, regime, stress, and Monte Carlo testing; retain benchmark comparisons and sample-size warnings.
- Paper engine currently does not mark open positions to market; daily loss checks are realized-P/L only. Add unrealized risk and gap/halts before considering any live-risk use.
- J-Quants is the first Japanese historical-data candidate; Alpaca Paper Only is a separate US paper API candidate; IBKR is deferred. No provider account or subscription is approved by this research.
- Live trading stays disabled until a separate legal/tax/security review, extended paper period, explicit owner approval, and broker-side risk controls are complete.

## 8. CI and release process

- CI workflows now declare `contents: read`, pin checkout/setup-node to verified full commit SHAs, use Node 24, disable unnecessary package-manager caching, and bound job time/concurrency.
- The repository has duplicate JARVIS test workflows. Preserve required checks until branch protection and downstream dependencies are reviewed; consolidate only in a dedicated change.
- The current paper-trading/influence PR head still requires a confirmed green result from both test workflows on its exact final SHA. Do not merge based on earlier green commits.
- Add syntax checks across every JavaScript file, dependency/license scanning, secret scanning, SBOM/provenance, and a reviewed release artifact before production rollout.
- Add a changelog and migration checklist for every schema/API change.

## 9. Current blockers and priority order

1. Confirm current paper/influence PR tests on the exact final head; fix all failures before any merge.
2. Keep PR #22 stacked on PR #16 and reconcile the base branch before merge; no force-push or merge without review.
3. Resolve Render plan + persistent-disk prerequisites only after the owner handles billing and confirms the intended workspace.
4. Verify live Apps Script sheet schemas read-only; expand beyond the 99-row sample only after pagination and reconciliation tests.
5. Complete video source QA and produce one full-length episode without spending more Descript credits until approved.
6. Implement licensed market-data and public-statement provider adapters; keep all signal output paper-only.
7. Add per-department queues, scoped credentials, owner identity, audit trail, and notifications.
8. Only after all previous gates, consider scheduled autonomous operation. Publication, money movement, submissions, and live trading remain owner-approved actions.

## 10. Change log for this review

- Added persistent market-influence event archive and authenticated API.
- Forced API event submissions to remain unverified until trusted provider adapters exist.
- Added strict timestamp, HTTPS URL, source-ID, event-count, and journal-byte validation.
- Fixed paper-trading daily-loss halt expiry and open-position-cap behavior.
- Fixed realized daily P/L calculation to exclude open trades.
- Added byte-cap enforcement before paper journal state mutation.
- Hardened GitHub Actions permissions, action pins, Node runtime, timeout, and concurrency.


## 11. JARVIS command-center integration (draft foundation)

- Added a provider-independent command-center core and authenticated `GET /v1/command-center` overview.
- Added authenticated `POST /v1/command-center/dispatch` to fan a bounded internal task out to explicitly selected department agents.
- Dispatch uses the existing department allowlist, durable job queue, idempotency keys, and worker registry.
- Safe internal classes (`read`, `analyze`, `draft`, `notify`, `internal_task`) are queued for department workers.
- Sensitive classes (external submission, financial action, contract, publication, deletion, permission change) are written to the owner approval ledger and are never queued for execution.
- Unknown departments fail closed. The endpoint reports queue/worker readiness, department-level recent activity, and a bounded recent-job sample.
- API tests cover authentication, department fan-out, idempotency, approval routing, and no-execution behavior for sensitive actions.
- This is a dispatch and visibility layer, not yet a self-directing autonomous CEO agent: no planner currently decomposes free-form company goals into department work, no department-specific recurring schedules are activated, and no cross-agent result synthesis loop is running.
- Runtime activation still requires the paid Render plan decision, persistent disk, worker enablement, scoped credentials, owner identity hardening, notification integration, and exact-head CI/release approval.

- Added an AI department planner that asks the configured OpenAI Responses API to choose from the fixed department allowlist and a fixed action-class enum. The response must parse as JSON and pass validation; malformed or unknown departments fail closed.
- Added authenticated `POST /v1/command-center/plan`: the planner proposes a small department fan-out, then the command center queues only internal work or records an owner approval. The model cannot directly invoke tools or external actions.
- Planner use is runtime-conditional on server-side `OPENAI_API_KEY`; no key is embedded in source. API use may incur normal model charges and must be covered by the owner's existing budget policy.
- Planner tests use a mocked provider response; they do not establish live OpenAI connectivity or autonomous production operation.
