# ONE JARVIS Binance Japan rules and finance persistence

## Compatibility boundary
Binance Japan announcements instruct API users to query GET /api/v3/exchangeInfo for current step sizes and minimum quantities. The official general Spot API documentation lists https://api.binance.com and alternatives, while the public-only data host is https://data-api.binance.vision. The Japan-specific materials reviewed here do not establish that the global account API hostname is the correct authenticated endpoint for every Binance Japan account. No account host/venue mapping was verified in this stage.

The existing market-data adapter uses the global public-only host and marks every snapshot UNVERIFIED_BINANCE_JAPAN_ACCOUNT. The rule validator requires explicit verified Binance Japan account provenance. Without it, all order-intent validation fails closed. This is validation-only; no order transport exists and no API key was created.

## Dynamic trading filters
Normalize PRICE_FILTER, LOT_SIZE, MARKET_LOT_SIZE and MIN_NOTIONAL/NOTIONAL from a trusted, explicitly verified Binance Japan exchangeInfo source. Use LOT_SIZE for limit quantities and MARKET_LOT_SIZE for market quantities. Zero max bounds are treated as disabled/unbounded; step sizes must remain positive. Never hardcode min quantity, tick size, step size or min notional. Missing required filters are rejected. Market notional validation requires a reference price when the filter applies to market orders.

## Neon persistence
The audit branch has existing public.jarvis_jobs, public.jarvis_approvals, public.jarvis_audit_events, public.jarvis_job_attempts and public.schema_migrations (version 001). The adapter accepts an injected PostgreSQL pool and does not add a database dependency or connect itself. The current jarvis/server.js does not instantiate pg Pool or wire this adapter; integration must be separately reviewed and tested before runtime use.

The adapter:
- Saves snapshots and indicators in a transaction.
- Saves only PAPER_ONLY proposals, checks a locked portfolio row, and reserves BUY budgets atomically.
- Uses idempotency keys and payload hashes; a reused key with different content fails closed.
- Writes financial audit events to public.jarvis_audit_events.
- Rolls back and raises PERSISTENCE_UNAVAILABLE on database failures; it has no in-memory success fallback.
- Persists a sticky loss halt at JPY 2,500 net loss including fees.
- Enforces JPY 50,000 initial capital, JPY 35,000 investment cap, JPY 15,000 reserve, BTC/ETH/SOL allocation caps and stage budgets.

## Draft migration
finance-persistence-002.sql creates the isolated jarvis_finance schema and references existing public job, approval, audit and migration ledgers. The rollback is destructive and drops all finance data and the migration row. Neither SQL file has been applied. No Neon schema was changed.

## Tests
From jarvis: npm test (Node.js >=20). GitHub Actions runs the same command in CI. Mocked PostgreSQL tests do not replace integration testing against a disposable database branch.
