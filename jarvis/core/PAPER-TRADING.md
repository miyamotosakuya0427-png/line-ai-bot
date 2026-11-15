# ONE TRADER — paper-trading research foundation

This module is simulation-only. It has no broker adapter, exchange credentials, live market-data connector, or real-money order path.

## Research objectives (not promised returns)

The owner's research hypotheses are: 1,000,000 JPY starting capital, 500,000 JPY monthly profit (+50%), 20% daily return, and a proposed 20% stop-loss. These are targets to evaluate, not expected or guaranteed results. They must never be used to force trades or increase risk.

## Default paper risk guardrails

- Maximum modeled loss per trade: 0.5% of current simulated equity.
- Daily realized loss halt: 2% of starting capital.
- Peak-to-trough equity drawdown halt: 8%.
- Maximum five concurrent paper positions.
- A stop price is mandatory.
- Duplicate trade IDs are rejected.
- Fees and slippage are included in net P/L.
- A halt blocks new paper trades; it is not an instruction to reverse or liquidate any real position.

These are conservative research defaults, not personalized financial advice or a live trading policy. They should be stress-tested before any future deployment.

## Data and learning loop

1. Store each market snapshot with source, symbol, timestamp, currency, and an explicit unverified provenance flag.
2. Record each simulated entry/exit, strategy version, signal ID, stop, costs, and reason.
3. Calculate win rate, profit factor, average win/loss, return, and per-strategy results.
4. Attach a structured lesson to every reviewed failure: category, root cause, preventive rule, and evidence.
5. Flag repeated preventive rules so JARVIS can review why the same failure recurred.
6. Do not autonomously alter strategy code from a lesson. Proposed changes require a new strategy version and a fresh out-of-sample test.
7. Report sample size and limitations; do not call a strategy profitable based on a small sample.

## Validation gates before any real-money consideration

- Verified licensed/authorized market-data source, timestamps, corporate actions, delisted symbols, and missing-data handling.
- Separate training, validation, and untouched out-of-sample periods; walk-forward testing.
- Realistic spread, commissions, taxes where applicable, slippage, partial fills, liquidity, and market-hours simulation.
- Benchmark comparison, risk-adjusted returns, maximum drawdown, tail loss, consecutive losses, and regime analysis.
- Minimum sample and duration set before looking at results; no cherry-picking.
- Paper run over multiple market regimes with reconciled logs.
- Independent security review, broker permission scoping, kill switch, and explicit owner approval.

Passing a backtest or paper phase does not guarantee future performance. A 20% daily return and 50% monthly return are exceptionally aggressive and are not safe assumptions for planning. A 20% stop-loss may allow substantial capital loss; the default paper policy uses much tighter risk limits for research comparison.

## Current boundaries

This is an isolated in-memory simulation engine and unit-tested research foundation. It is not yet wired into the JARVIS HTTP API, persistent journal, live data providers, scheduled agent, dashboard, or any broker. No real order can be placed by this module.
