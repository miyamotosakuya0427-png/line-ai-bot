-- DRAFT ONLY. Apply only after explicit approval and after confirming no retained finance data.
BEGIN;
DROP TABLE IF EXISTS jarvis_finance.financial_audit_logs;
DROP TABLE IF EXISTS jarvis_finance.risk_events;
DROP TABLE IF EXISTS jarvis_finance.trade_proposals;
DROP TABLE IF EXISTS jarvis_finance.capital_allocations;
DROP TABLE IF EXISTS jarvis_finance.technical_indicators;
DROP TABLE IF EXISTS jarvis_finance.market_snapshots;
DROP SCHEMA IF EXISTS jarvis_finance;
COMMIT;
