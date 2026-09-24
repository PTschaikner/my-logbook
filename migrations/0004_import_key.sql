-- Dedup key for imported board ascents (null for manually-logged climbs).
-- Apply: wrangler d1 execute mylogbook --file=./migrations/0004_import_key.sql --remote
ALTER TABLE ticks ADD COLUMN import_key TEXT;
CREATE INDEX IF NOT EXISTS idx_ticks_import ON ticks(import_key);
