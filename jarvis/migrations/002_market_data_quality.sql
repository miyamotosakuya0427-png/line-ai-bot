BEGIN;
CREATE TABLE IF NOT EXISTS market_data_sources (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_key TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
 license_id TEXT NOT NULL, venue_allowlist TEXT[] NOT NULL DEFAULT '{}', currency_allowlist TEXT[] NOT NULL DEFAULT '{}',
 enabled BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS market_ingest_batches (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_id UUID NOT NULL REFERENCES market_data_sources(id),
 idempotency_key TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL, interval TEXT NOT NULL,
 requested_from TIMESTAMPTZ, requested_to TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ, status TEXT NOT NULL CHECK(status IN ('pending','running','completed','partial','failed','quarantined')),
 input_count INTEGER NOT NULL DEFAULT 0 CHECK(input_count>=0), accepted_count INTEGER NOT NULL DEFAULT 0 CHECK(accepted_count>=0),
 rejected_count INTEGER NOT NULL DEFAULT 0 CHECK(rejected_count>=0), raw_payload_hash TEXT, error_summary TEXT
);
CREATE TABLE IF NOT EXISTS market_bars (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_id UUID NOT NULL REFERENCES market_data_sources(id),
 venue TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL CHECK(interval IN ('1m','5m','15m','30m','1h','4h','1d','1w')),
 open_time_utc TIMESTAMPTZ NOT NULL, close_time_utc TIMESTAMPTZ NOT NULL,
 source_timestamp_raw TEXT NOT NULL, source_timezone TEXT NOT NULL, received_at_utc TIMESTAMPTZ NOT NULL,
 open NUMERIC(38,18) NOT NULL CHECK(open>0), high NUMERIC(38,18) NOT NULL CHECK(high>0),
 low NUMERIC(38,18) NOT NULL CHECK(low>0), close NUMERIC(38,18) NOT NULL CHECK(close>0),
 volume NUMERIC(38,18) NOT NULL CHECK(volume>=0), quote_volume NUMERIC(38,18) CHECK(quote_volume>=0),
 adjustment_state TEXT NOT NULL DEFAULT 'raw' CHECK(adjustment_state IN ('raw','split_adjusted','total_return_adjusted')),
 normalized_hash CHAR(64) NOT NULL, raw_payload_hash CHAR(64), verification_status TEXT NOT NULL DEFAULT 'unverified'
 CHECK(verification_status IN ('unverified','passed','quarantined','superseded')),
 batch_id UUID REFERENCES market_ingest_batches(id), revision_no INTEGER NOT NULL DEFAULT 1 CHECK(revision_no>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(high>=GREATEST(open,close,low)), CHECK(low<=LEAST(open,close,high)),
 UNIQUE(source_id,venue,symbol,interval,open_time_utc,adjustment_state)
);
CREATE INDEX IF NOT EXISTS market_bars_lookup_idx ON market_bars(venue,symbol,interval,open_time_utc DESC);
CREATE INDEX IF NOT EXISTS market_bars_quality_idx ON market_bars(verification_status,open_time_utc);
CREATE INDEX IF NOT EXISTS market_ingest_status_idx ON market_ingest_batches(status,started_at DESC);
CREATE TABLE IF NOT EXISTS market_quality_findings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID REFERENCES market_ingest_batches(id),
 bar_id UUID REFERENCES market_bars(id), code TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('info','warning','high','critical')),
 details JSONB NOT NULL DEFAULT '{}', detected_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS market_quality_findings_idx ON market_quality_findings(severity,detected_at DESC);
CREATE TABLE IF NOT EXISTS market_bar_revisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bar_id UUID NOT NULL REFERENCES market_bars(id),
 revision_no INTEGER NOT NULL CHECK(revision_no>0), prior_hash CHAR(64), revised_hash CHAR(64) NOT NULL,
 prior_payload JSONB, revised_payload JSONB NOT NULL, reason TEXT NOT NULL,
 source_batch_id UUID REFERENCES market_ingest_batches(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(bar_id,revision_no)
);
CREATE TABLE IF NOT EXISTS market_execution_costs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), venue TEXT NOT NULL, symbol TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL, liquidity_role TEXT CHECK(liquidity_role IN ('maker','taker','unknown')),
 maker_fee_rate NUMERIC(18,12) CHECK(maker_fee_rate>=0), taker_fee_rate NUMERIC(18,12) CHECK(taker_fee_rate>=0),
 spread_bps NUMERIC(18,8) CHECK(spread_bps>=0), slippage_bps NUMERIC(18,8) CHECK(slippage_bps>=0),
 impact_bps NUMERIC(18,8) CHECK(impact_bps>=0), execution_price NUMERIC(38,18) CHECK(execution_price>0),
 reference_price NUMERIC(38,18) CHECK(reference_price>0), fee_amount NUMERIC(38,18) CHECK(fee_amount>=0),
 fee_currency TEXT, evidence_source TEXT NOT NULL, evidence_hash CHAR(64), completeness TEXT NOT NULL
 CHECK(completeness IN ('complete','partial','unknown')), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_execution_cost_lookup_idx ON market_execution_costs(venue,symbol,observed_at DESC);
CREATE TABLE IF NOT EXISTS market_data_audit_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_type TEXT NOT NULL,
 resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, payload JSONB NOT NULL,
 previous_hash CHAR(64), event_hash CHAR(64) NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_data_audit_resource_idx ON market_data_audit_events(resource_type,resource_id,id);
CREATE FUNCTION reject_market_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'market_data_audit_events is append-only'; END; $$;
CREATE TRIGGER market_data_audit_no_update_delete BEFORE UPDATE OR DELETE ON market_data_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_market_audit_mutation();
GRANT SELECT ON market_data_sources, market_bars, market_ingest_batches, market_quality_findings, market_bar_revisions, market_execution_costs, market_data_audit_events TO jarvis_audit_readonly;
COMMIT;