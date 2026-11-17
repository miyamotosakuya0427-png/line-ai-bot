# Binance Japan Spot integration

## Scope and safety defaults

This adapter targets Binance Japan's Spot API only. It does not use Futures, Margin, leverage, withdrawals, transfers, or deposits. The API key and secret are server-side environment variables and must never be sent to a browser, LINE message, logs, source control, or an AI prompt.

The default deployment is read-only. Live order execution is disabled unless all of the following are true:

- `JARVIS_BINANCE_ENABLED=true`
- `JARVIS_BINANCE_LIVE_ORDERS_ENABLED=true`
- `JARVIS_BINANCE_RISK_GATE_ENABLED=true`
- `JARVIS_BINANCE_VALIDATION_PASSED=true`
- `JARVIS_OWNER_TOKEN` is configured with at least 32 bytes
- `JARVIS_BINANCE_API_KEY` and `JARVIS_BINANCE_API_SECRET` are configured
- The approval store has an execution authorizer for the internal `binance-japan-spot-executor` actor
- A separate risk callback approves the order

Use an API key with Spot read and Spot trading permissions only. Disable withdrawals and all transfer permissions in Binance. Use IP restrictions for the Render outbound IPs if the account/API configuration supports them. Never use a master key with wallet withdrawal permissions.

## Supported adapter operations

- Public: exchange information, ticker price, klines
- Signed read: account balances, open orders, recent trades, API-key permission audit
- Order: GTC limit orders only; no market orders, margin, futures, withdrawals, or transfers
- Reconciliation: query an order by its client order ID after an ambiguous network outcome

Only JPY-quoted symbols are accepted for the first live-order phase. Every order must pass Binance PRICE_FILTER, LOT_SIZE, minimum-notional checks, and a configurable notional cap. The initial cap defaults to JPY 5,000.

## Approval and uncertain outcomes

A live order is bound to a specific approval resource and immutable payload. The executor claims the approval exactly once before sending the order. A definitive Binance 4xx rejection is recorded as failed. A timeout, connection loss, malformed response, or server-side error is treated as `outcome_unknown`; the approval remains claimed and the system must reconcile by `clientOrderId`. An absent result is not permission to retry. This prevents duplicate orders after an uncertain network dispatch.

## Environment variables

- `JARVIS_BINANCE_ENABLED` — enables the adapter (default false)
- `JARVIS_BINANCE_API_KEY` — API key (secret)
- `JARVIS_BINANCE_API_SECRET` — API secret (secret)
- `JARVIS_BINANCE_BASE_URL` — optional, allowlisted Binance API host only
- `JARVIS_BINANCE_LIVE_ORDERS_ENABLED` — explicit live order kill switch (default false)
- `JARVIS_BINANCE_RISK_GATE_ENABLED` — explicit asset-balance risk gate (default false)
- `JARVIS_BINANCE_VALIDATION_PASSED` — explicit operator gate after testnet/demo and security validation (default false)
- `JARVIS_OWNER_TOKEN` — separate owner-only token required for account, open-order, and order execution routes
- `JARVIS_BINANCE_MAX_ORDER_JPY` — maximum notional per order (default 5000)

Account balances, open orders, trade history, and API-key permission audits require the separate owner token. The live risk gate independently checks Binance API restrictions and rejects keys that permit withdrawals, transfers, margin, futures, or options. The risk callback checks the available JPY balance for buys and base-asset balance for sells. There is not yet a production-grade daily realized-loss ledger or exchange reconciliation monitor, so the validation flag must remain false until those controls and a full demo rehearsal are independently completed.

Never set the live-order flag until the read-only account test, market-data freshness checks, risk-policy review, approval identity checks, and end-to-end testnet/demo rehearsal have passed. Do not assume a global Binance MCP endpoint is available to a Binance Japan account; verify account eligibility and product support separately.

## Official references

- Binance Japan API FAQ: https://www.binance.com/en-JP/support/faq/detail/360004492232
- Binance Spot API documentation: https://github.com/binance/binance-spot-api-docs
- Binance Japan Spot API update notice: https://www.binance.com/ja/support/announcement/detail/59e6832aa5d94322a7c15a4f80e6598e
