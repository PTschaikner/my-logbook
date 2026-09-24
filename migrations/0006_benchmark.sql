-- Board benchmark flag: marks a tick as a calibrated "benchmark" problem
-- (imported from BoardLib's is_benchmark). 0 = normal, 1 = benchmark.
ALTER TABLE ticks ADD COLUMN is_benchmark INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_ticks_benchmark ON ticks(is_benchmark);
