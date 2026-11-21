-- DRAFT ONLY. Destructive: only after explicit approval and verified backup.
BEGIN;
DELETE FROM public.schema_migrations WHERE version='002-finance-persistence';
DROP TABLE IF EXISTS jarvis_finance.risk_events;
DROP TABLE IF EXISTS jarvis_finance.trade_proposals;
DROP TABLE IF EXISTS jarvis_finance.portfolios;
DROP TABLE IF EXISTS jarvis_finance.technical_indicators;
DROP TABLE IF EXISTS jarvis_finance.market_snapshots;
DROP SCHEMA IF EXISTS jarvis_finance;
COMMIT;
