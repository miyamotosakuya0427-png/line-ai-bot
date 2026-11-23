# Market Data Integration Contract (Stage 6)

## Ownership boundaries

- PR #79 owns public unauthenticated market-data HTTP retrieval.
- Stage 6 owns snapshot validation, mapping, UTC normalization, quality evaluation and the persistence boundary.
- PR #72 owns Binance Japan account/Spot API and any approval-bound execution interfaces.
- Public global market-data responses are not proof of Binance Japan account availability, tradability, liquidity or execution conditions.

## Gateway adapter

`market-data-gateway-adapter.js` performs no HTTP request and imports no PR #79 implementation. The caller supplies a snapshot produced by PR #79. This avoids duplicating its HTTP client and keeps the branch dependency explicit until PR #79 is reviewed/merged.

The adapter accepts only:
- host `data-api.binance.vision`
- symbols BTCJPY, ETHJPY, SOLJPY
- intervals 1m, 5m, 15m, 1h, 4h, 1d
- quote currency JPY
- venue label `BINANCE_PUBLIC`, which identifies the public data endpoint, not a Japan account venue.

## Source enablement

The source configuration must explicitly provide:
- stable source id and source key
- provider name
- license id
- license evidence reference
- enabled=true
- venue allowlist containing BINANCE_PUBLIC
- currency allowlist containing JPY

A placeholder license id or evidence reference is not proof that legal review is complete. Production enablement requires an actual approved license record. The adapter never invents license permission.

## Candle semantics

The provider's inclusive closeTime must be strictly earlier than the injected clock. Unconfirmed candles are excluded and reported. The adapter retains the provider's original millisecond epoch in `sourceTimestampRaw`, labels its source encoding `UTC_UNIX_MILLISECONDS`, and creates UTC timestamps. The raw-payload hash is calculated from the parsed candle object delivered by PR #79 (not the original HTTP response bytes, which PR #79 does not expose); the normalized hash is calculated separately from canonical normalized fields.

## Quality and persistence

The adapter returns quality findings but does not itself persist or mark data passed. Persistence re-runs the quality gate inside the same transaction, includes unresolved findings from prior ingests, and quarantines on any active high/critical finding. Finding corrections are accepted only for unresolved findings attached to bars in the current batch; the resolution metadata, re-evaluation, bar status, batch status and audit event commit or roll back together. Bars are marked passed only after that gate succeeds.

## CI

The Stage 6 workflow is separate from the existing PR #80 workflows. It runs from the `jarvis` working directory, uses a disposable localhost PostgreSQL 16 service for migration, rollback, idempotency, revision, append-only audit and 2/5-Worker concurrency integration tests, and does not connect to Neon. JSONL parity remains fixture-only; no production JSONL is imported or modified.

## Safety

No account credentials, signed endpoints, orders, withdrawals, transfers, futures or margin operations are part of this contract.
