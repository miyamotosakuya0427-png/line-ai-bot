-- DRAFT ONLY. Do not apply to production.
-- Isolated schema avoids collisions with existing public.jarvis_* tables.
BEGIN;
CREATE SCHEMA IF NOT EXISTS jarvis_finance;
CREATE TABLE jarvis_finance.market_snapshots (
  id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, source_host TEXT NOT NULL,
  venue_compatibility TEXT NOT NULL DEFAULT 'UNVERIFIED_BINANCE_JAPAN_ACCOUNT',
  symbol TEXT NOT NULL CHECK (symbol IN ('BTCJPY','ETHJPY','SOLJPY')),
  observed_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(symbol, observed_at)
);
CREATE INDEX market_snapshots_symbol_time_idx ON jarvis_finance.market_snapshots(symbol, observed_at DESC);
CREATE TABLE jarvis_finance.technical_indicators (
  id BIGSERIAL PRIMARY KEY, snapshot_id BIGINT NOT NULL REFERENCES jarvis_finance.market_snapshots(id),
  observed_at TIMESTAMPTZ NOT NULL, indicators JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(snapshot_id)
);
CREATE TABLE jarvis_finance.capital_allocations (
  id BIGSERIAL PRIMARY KEY, portfolio_key TEXT NOT NULL, initial_capital_jpy BIGINT NOT NULL CHECK(initial_capital_jpy=50000),
  investment_cap_jpy BIGINT NOT NULL CHECK(investment_cap_jpy=35000), reserve_jpy BIGINT NOT NULL CHECK(reserve_jpy=15000),
  allocations JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE jarvis_finance.trade_proposals (
  id UUID PRIMARY KEY, symbol TEXT NOT NULL CHECK(symbol IN ('BTCJPY','ETHJPY','SOLJPY')),
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')), amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),
  status TEXT NOT NULL CHECK(status IN ('PAPER_ONLY','PENDING_REVIEW','REJECTED','EXPIRED')),
  rationale JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE jarvis_finance.risk_events (
  id BIGSERIAL PRIMARY KEY, event_code TEXT NOT NULL, severity TEXT NOT NULL,
  details JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE jarvis_finance.financial_audit_logs (
  id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  correlation_id TEXT NOT NULL, details JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(correlation_id, action)
);
COMMIT;
