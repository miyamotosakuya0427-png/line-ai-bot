BEGIN;
ALTER TABLE market_data_sources ADD COLUMN IF NOT EXISTS license_approved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE market_data_sources ADD COLUMN IF NOT EXISTS license_evidence_ref TEXT;
ALTER TABLE market_data_sources ADD COLUMN IF NOT EXISTS license_reviewed_at TIMESTAMPTZ;
ALTER TABLE market_bars ADD COLUMN IF NOT EXISTS quote_currency TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='market_data_sources_license_evidence_required') THEN
    ALTER TABLE market_data_sources ADD CONSTRAINT market_data_sources_license_evidence_required
      CHECK (enabled = FALSE OR (license_approved = TRUE AND license_evidence_ref IS NOT NULL AND btrim(license_evidence_ref) <> '' AND license_reviewed_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='market_bars_quote_currency_format') THEN
    ALTER TABLE market_bars ADD CONSTRAINT market_bars_quote_currency_format
      CHECK (quote_currency IS NULL OR quote_currency ~ '^[A-Z]{3}$');
  END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES ('003') ON CONFLICT (version) DO NOTHING;
COMMIT;
