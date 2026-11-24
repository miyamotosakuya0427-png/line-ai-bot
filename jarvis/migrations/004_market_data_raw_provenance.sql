BEGIN;
ALTER TABLE market_bars ADD COLUMN IF NOT EXISTS source_record_id TEXT;
ALTER TABLE market_bars ADD COLUMN IF NOT EXISTS raw_payload JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS market_bars_source_record_id_key
  ON market_bars(source_id, source_record_id)
  WHERE source_record_id IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES ('004') ON CONFLICT (version) DO NOTHING;
COMMIT;
