# ONE TRADER — Market data and broker adapter research

Research snapshot: 2026-11-16. Re-check provider terms, coverage, pricing, account eligibility, and API versions before implementation or live use.

## Decision

Do not select a single "forever" trading platform. Keep JARVIS's strategy engine, historical-data store, paper simulator, and broker adapters independent. The first market-data adapter candidate for Japanese equities is JPX J-Quants. For a separate US-equities paper-execution test, Alpaca Paper Only is a candidate. Interactive Brokers is a later broker candidate when broad multi-market coverage and account/API complexity are justified. No provider is approved for live trading by this document.

## Provider comparison

### JPX J-Quants — Japanese equity historical data candidate
- Official JPX data service with API and plan-based historical coverage.
- Published plan matrix currently lists daily OHLC and related fundamentals; history varies by plan (Free delayed, Light 5 years, Standard 10 years, Premium 20 years).
- Minute bars and tick data are add-ons with up to two years of history.
- API rate limits are plan-based (published 5/60/120/500 requests per minute).
- Daily OHLC updates after market close; update timing differs by dataset.
- Adjusted prices can be recalculated back through the available history after splits/consolidations.
- Free plan has a 12-week delay for price data and should not be mistaken for live trading data.
- Verify plan pricing, redistribution/storage rights, exact universe coverage, survivorship and delisting handling, corporate actions, and commercial-use terms before choosing a paid tier.

Official references:
- https://jpx-jquants.com/ja/spec/data-spec
- https://jpx-jquants.com/ja/spec/rate-limits
- https://jpx-jquants.com/ja/help/about
- https://jpx-jquants.com/ja/help/data

### Alpaca — US-equity paper execution candidate
- Official docs say a Paper Only account can be opened globally and paper trading is available without live orders.
- Paper Only accounts are entitled to IEX market data; do not treat this as consolidated US market coverage.
- Simulator does not fully model market impact, information leakage, latency slippage, queue position, price improvement, regulatory fees, or dividends.
- Its paper environment is useful for API and operational integration tests, but its fills must not be treated as proof of live profitability.
- Verify current Japanese residency eligibility, supported instruments, account/data terms, and tax/currency handling before any account decision.

Official references:
- https://docs.alpaca.markets/us/docs/paper-trading
- https://docs.alpaca.markets/us/v1.1/docs/trading-api

### Interactive Brokers — later multi-market broker candidate
- Official APIs include Web API and TWS API; paper accounts can be used with API.
- TWS API is a TCP/socket integration intended for experienced developers; market-data entitlements and API acknowledgements apply.
- Paper accounts have simulator limitations.
- IBKR paper account availability is tied to an approved/funded regular account per official TWS API documentation; confirm current Japan onboarding and paper eligibility before selection.

Official references:
- https://www.interactivebrokers.com/docs/
- https://interactivebrokers.github.io/tws-api/introduction
- https://www.interactivebrokers.com/support/faq/articles/629297841

## Recommended architecture

1. Provider-neutral normalized data contract: instrument ID, venue, currency, event time, received time, timezone, OHLCV/bid/ask where licensed, adjustment state, source, license/entitlement, revision/version, and verification status.
2. Separate raw immutable source archive from normalized/revised data; record every correction and fetch watermark.
3. Independent adapters: J-Quants daily/history first; additional intraday/tick provider only after cost and license review; Alpaca paper adapter only as a separate US paper venue; IBKR adapter deferred.
4. Backtest engine must model fees, spread, slippage, partial fills, liquidity, trading calendar, corporate actions, delisted symbols, and point-in-time fundamentals. No look-ahead or survivorship leakage.
5. Walk-forward and untouched out-of-sample validation across bull, bear, sideways, volatile, and illiquid regimes; compare to passive benchmarks and cash.
6. Keep provider status, schema drift, missing bars, delayed feeds, rate limits, and stale timestamps under automated monitoring. A provider outage or stale feed must block new simulated/live orders.
7. The paper journal is the source of truth for simulated orders and lessons. Broker simulator records are reconciled separately.
8. Live trading remains disabled until explicit owner approval, independent security review, legal/tax review, and a successful extended paper-trading gate.

## Important constraints

- No promise of 20% daily returns or 50% monthly returns. Treat these only as hypotheses to falsify.
- The owner's proposed 20% stop-loss is not a safe default. Existing paper-only controls (0.5% modeled risk per trade, 2% daily loss halt, 8% peak drawdown halt, maximum five open positions) are simulation guardrails, not live policy.
- Do not automatically optimize against the same historical sample used to select strategies. Preserve a final holdout set.
- Do not add broker credentials or enable live trading through a general-purpose AI prompt.
- This research note does not create accounts, accept provider terms, subscribe to paid feeds, or enable external execution.

## Plugin research

The current ChatGPT plugin directory search did not surface a supported direct brokerage or exchange execution connector for Alpaca, Interactive Brokers, or JPX J-Quants. MotherDuck was suggested as an optional analytics/data-warehouse connection for large historical datasets; it is not a broker, market-data vendor, or trading executor. It must be explicitly connected by the owner before it can be used. A ChatGPT connector connection would not automatically install credentials into the Render-hosted JARVIS service.


## Implemented provider-neutral contract

The repository now includes `market-data-contract.js` and focused tests. The contract:
- Requires a server-configured source allowlist with provider and license reference; request payloads cannot create their own allowlist.
- Normalizes instrument, venue, currency, interval, OHLCV, event/received timestamps, adjustment state, and provider record ID.
- Rejects inconsistent OHLC ranges, invalid calendar timestamps, stale/future receipt times, unsupported intervals, and unauthorized venue/currency combinations.
- Always labels normalized records `verified=false` / `unverified`. An allowlist entry is not proof of source accuracy, licensing scope, or completeness.
- Does not connect to J-Quants or any other provider and does not store credentials. A separately reviewed adapter must fetch data under the owner's actual plan and map its official response into this contract.
