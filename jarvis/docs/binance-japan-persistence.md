# ONE JARVIS Binance Japan rules and finance persistence

## Compatibility boundary
The public adapter at data-api.binance.vision is global public market data, not proof of Binance Japan account access. No Binance Japan-specific API base URL/account venue mapping was established from the official material reviewed. Until the account's official API host and a read-only account-context check are verified, rules must remain UNVERIFIED and order-intent validation fails closed. No API key is created here.

## Dynamic trading filters
Normalize PRICE_FILTER, LOT_SIZE, MARKET_LOT_SIZE and MIN_NOTIONAL/NOTIONAL from an explicitly verified Binance Japan exchangeInfo source. Use LOT_SIZE for limit quantities and MARKET_LOT_SIZE for market quantities. Never hardcode min quantity, tick size, step size or min notional. Missing required filters are rejected. The validator is a simulation/validation helper only; it has no order transport.

## Persistence
finance-persistence.js accepts an injected PostgreSQL pool and uses transactions. Database errors roll back and raise PERSISTENCE_UNAVAILABLE; there is no in-memory success fallback. Proposal idempotency collisions with different payloads fail closed. Paper proposals are restricted to PAPER_ONLY and are written with the shared public.jarvis_audit_events ledger. Market snapshots preserve UNVERIFIED_BINANCE_JAPAN_ACCOUNT provenance.

## Neon migration
Draft migration uses jarvis_finance and references existing public.jarvis_jobs, public.jarvis_approvals, public.jarvis_audit_events and public.schema_migrations. The migration is not applied. Rollback deletes the migration ledger row and drops finance data; this is destructive and requires explicit approval and backup. Existing migration ledger currently contains 001; draft version is 002-finance-persistence.

## Run tests
From jarvis: npm test (Node.js >=20).
