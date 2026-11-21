-- DRAFT ONLY. Do not apply without separate explicit approval.
-- Uses existing public JARVIS job/approval/audit ledgers; no duplicate audit table.
BEGIN;
CREATE SCHEMA IF NOT EXISTS jarvis_finance;
CREATE TABLE jarvis_finance.market_snapshots (
 id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, source_host TEXT NOT NULL,
 venue_compatibility TEXT NOT NULL DEFAULT 'UNVERIFIED_BINANCE_JAPAN_ACCOUNT',
 symbol TEXT NOT NULL CHECK(symbol IN ('BTCJPY','ETHJPY','SOLJPY')),
 observed_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(symbol, observed_at)
);
CREATE INDEX market_snapshots_symbol_time_idx ON jarvis_finance.market_snapshots(symbol, observed_at DESC);
CREATE TABLE jarvis_finance.technical_indicators (
 id BIGSERIAL PRIMARY KEY, snapshot_id BIGINT NOT NULL REFERENCES jarvis_finance.market_snapshots(id) ON DELETE CASCADE,
 observed_at TIMESTAMPTZ NOT NULL, indicators JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(snapshot_id)
);
CREATE TABLE jarvis_finance.portfolios (
 portfolio_key TEXT PRIMARY KEY, initial_capital_jpy BIGINT NOT NULL CHECK(initial_capital_jpy=50000),
 investment_cap_jpy BIGINT NOT NULL CHECK(investment_cap_jpy=35000),
 reserve_jpy BIGINT NOT NULL CHECK(reserve_jpy=15000),
 invested_jpy BIGINT NOT NULL DEFAULT 0 CHECK(invested_jpy>=0 AND invested_jpy<=investment_cap_jpy),
 realized_pnl_jpy BIGINT NOT NULL DEFAULT 0, unrealized_pnl_jpy BIGINT NOT NULL DEFAULT 0,
 fees_jpy BIGINT NOT NULL DEFAULT 0 CHECK(fees_jpy>=0),
 halted BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE jarvis_finance.trade_proposals (
 id UUID PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 job_id UUID NULL REFERENCES public.jarvis_jobs(id) ON DELETE SET NULL,
 approval_id UUID NULL REFERENCES public.jarvis_approvals(id) ON DELETE SET NULL,
 symbol TEXT NOT NULL CHECK(symbol IN ('BTCJPY','ETHJPY','SOLJPY')),
 side TEXT NOT NULL CHECK(side IN ('BUY','SELL')), amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),
 status TEXT NOT NULL CHECK(status IN ('PAPER_ONLY','REJECTED','EXPIRED')),
 rationale JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE jarvis_finance.risk_events (
 id BIGSERIAL PRIMARY KEY, event_code TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('INFO','WARN','CRITICAL')),
 details JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Existing public.jarvis_audit_events is the canonical shared audit ledger.
-- Register migration version in the existing shared ledger as part of the same transaction.
INSERT INTO public.schema_migrations(version) VALUES ('002-finance-persistence');
COMMIT;
