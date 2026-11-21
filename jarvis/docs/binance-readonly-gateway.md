# Binance read-only market-data gateway

## Scope and compatibility boundary

This adapter calls the documented public market-data host \`https://data-api.binance.vision\`. Binance's public documentation lists this host for unauthenticated market-data endpoints including exchangeInfo, ticker price, 24hr ticker, depth and klines. This does **not** establish that returned listings, JPY pairs, liquidity or trading rules are identical to a Binance Japan user's account or venue.

Every response is therefore marked \`UNVERIFIED_BINANCE_JAPAN_ACCOUNT\`. No account API, signed request, order endpoint, withdrawal, futures or margin endpoint exists in this adapter. Do not treat global market data as a Japan-account connectivity test.

## Supported symbols and intervals

Symbols are allowlisted to BTCJPY, ETHJPY and SOLJPY. Intervals: 1m, 5m, 15m, 1h, 4h and 1d. Pair availability is read from exchangeInfo and is never assumed. A missing pair fails closed.

## Data quality

Requests have an 8-second timeout and a 2 MB response cap. Only fixed HTTPS host and fixed public GET endpoints are accepted. Snapshots carry source, source host, quote asset, observed timestamp and stale flag. The caller must reject stale snapshots before generating proposals.

## Local tests

From the \`jarvis\` directory run:

\`\`\`sh
npm test
\`\`\`

This branch has no live order path. Tests must be run in CI or a Node 20+ environment before claiming pass.

## Neon migration

The SQL and rollback files under \`migrations/drafts\` are design artifacts only. They create an isolated \`jarvis_finance\` schema. They have not been applied to any Neon branch. Validate on the audit branch only after separate approval.
