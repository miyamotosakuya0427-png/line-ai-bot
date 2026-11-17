# ONE JARVIS cross-system audit — 2026-11-17

Scope: read-only audit of connected GitHub, Render, and media-service connectors. No production configuration or data was changed.

## Status definitions
- `verified_live`: a live read-only connector/API call returned the current object or data.
- `code_present_unverified_runtime`: repository code exists, but the external service was not exercised.
- `not_connected_or_unavailable`: no usable connector/session was available.
- `blocked`: connector explicitly reported an account or policy block.
- `not_implemented`: no implementation was found in the inspected scope.

## Infrastructure

| Area | Status | Evidence / limitation |
|---|---|---|
| GitHub repository | verified_live | Branch and file APIs worked. |
| PR #49 base | verified_live | Compared exact SHA `56dde9b1f8b0b7913d093ba90d3868c7e49c7036` with `reliability/jarvis-worker-safe-retry-v2`; identical at branch creation. |
| PR #50 | verified_live | Draft PR opened from isolated branch; not merged. |
| Render `one-jarvis` | verified_live | Service exists; branch `one-jarvis-foundation`; auto-deploy off; Free plan; Singapore; latest observed successful deploy 2026-11-15. Initial `/health` probe returned 503 while the Free instance was waking; Render logs then showed startup at 2026-11-17T02:05:25Z, and a repeat `/health` probe returned `{ok:true,service:"ONE JARVIS",status:"running"}`. |
| Render `line-ai-bot-4` | verified_live | Service exists; branch `main`; auto-deploy on; Free plan; Oregon; latest observed successful deploy 2026-11-15; `/health` probe returned HTTP success and `株式会社One LINE AI Bot is running`. Webhook message round-trip was not tested. |
| Other Render services | verified_live | Additional legacy services `line-ai-bot`, `line-ai-bot-1`, `line-ai-bot-2`, `line-ai-bot-3` exist. Some have auto-deploy enabled. `line-ai-bot-2` and `line-ai-bot` show Ruby runtime/build configuration but Node start command; review before future changes. |
| Render-hosted Postgres | verified_live | Render account returned no Postgres instances. This says nothing about external Neon. |
| Neon production | not_connected_or_unavailable | No direct Neon SQL connector is installed/available in this audit. Do not infer schema or migration status. |
| GitHub Actions on PR #50 | not yet verified | The commit status API returned no statuses and the PR-filtered workflow-run lookup returned no runs. A dedicated workflow exists, but passing CI is not established. |

## Application integration

| Area | Status | Evidence / limitation |
|---|---|---|
| Google Sheets / Apps Script | code_present_unverified_runtime | JARVIS server code supports HTTPS Apps Script endpoint via `JARVIS_SHEETS_URL` and `JARVIS_SHEETS_TOKEN`; actual Script Properties, deployed version, permissions, and live read/write test were not verified. |
| LINE ID verification / LIFF | code_present_unverified_runtime | Server code contains LINE ID token verification and LIFF routes. Actual LINE Login/LIFF configuration and admin bootstrap were not exercised. |
| Existing LINE production service | verified_live_config_only | Render service `line-ai-bot-4` exists and remains untouched. This is not proof that webhook messaging was tested during this audit. |
| Google Drive / Sheets connector | not_connected_or_unavailable | Plugin search found Google Drive disabled by admin and unavailable for installation. |
| CapCut desktop | not_connected_or_unavailable | No direct CapCut connector was available in this environment. |

## Video and audience services

| Service | Status | Evidence / limitation |
|---|---|---|
| Metricool | verified_live | Brand connected; YouTube network is present. No scheduled posts returned for 2026-11-17 through 2026-12-17. |
| vidIQ | verified_live | Connected YouTube channel `@samurai-b6i`; 1 subscriber, 0 public views, 0 public videos at audit time. |
| YouTube analytics via Metricool | verified_live | Available metrics include subscribers, views, revenue, videos, gained/lost subscribers. Retrieved range showed subscriber count 1 on Nov 15–16; Nov 17 returned 0 for views/revenue/videos/gained/lost. |
| Descript | verified_live | Three projects found. `時をかける日本史｜江戸の大火` has 7 images, two narration audio files around 32 seconds, one 24-second video composition, and no publishes. Separate narration-check project has one 32-second audio composition and no publishes. Not a finished long-form episode. |
| HeyGen | verified_live_limited | Account is on Free plan; video library returned zero videos. No paid generation performed. |
| fal | blocked | Account status explicitly reports exhausted balance; browsing/pricing allowed, upload and generation unavailable. Do not retry or add credits automatically. |
| Canva | verified_live_limited | Brand Kit query returned no Brand Kits. This does not prove no designs exist. |

## Critical risks / next priorities
1. Do not deploy changes to Render: `line-ai-bot-4` and several legacy services auto-deploy from branches that must be protected.
2. Verify Neon production only through an authorized read-only connection; schema and migration state remain unknown.
3. Verify Apps Script deployed version, Script Properties, and Google Sheets schema using a non-production/test spreadsheet before any live action.
4. Add passing CI evidence for PR #50 and run the PostgreSQL 16 integration suite against an isolated disposable database.
5. Integrate Task Registry authentication and service routes only after the store and migration receive independent review. Do not auto-apply migration 0004 in production.
6. Resume video workflow from Descript project QA; do not publish or incur paid generation until exact asset, rights, pronunciation, and owner approval are confirmed.
7. Review redundant Render legacy services and runtime mismatches before any cleanup; do not delete or reconfigure them without explicit approval.

## Safety record
No production deploy, Neon connection/write/migration, LINE/Apps Script/Sheets write, PR merge, billing action, media upload, schedule, or publication occurred during this audit.
