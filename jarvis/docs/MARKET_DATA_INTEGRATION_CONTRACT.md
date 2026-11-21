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

The provider's inclusive closeTime must be strictly earlier than the injected clock. Unconfirmed candles are excluded and reported. The normalizer retains original timestamp text/timezone and creates UTC timestamps plus independent normalized/raw payload SHA-256 hashes.

## Quality and persistence

The adapter returns quality findings but does not itself persist or mark data passed. Persistence must re-run the quality gate inside the same transaction, include findings discovered during revision handling, quarantine on any high/critical finding and only mark bars passed after a successful gate.

## CI

The Stage 6 workflow is separate from the existing PR #80 workflows. It runs from the `jarvis` working directory and does not connect to Neon. Database integration and Worker concurrency tests remain a separate isolated-environment gate.

## Safety

No account credentials, signed endpoints, orders, withdrawals, transfers, futures or margin operations are part of this contract.
