-- Per-climb length (metres) for "metres climbed" stats, and crag coordinates.
-- Additive and safe on live data.
-- Apply: wrangler d1 execute craglog --file=./migrations/0003_length_and_coords.sql --remote

ALTER TABLE ticks ADD COLUMN length INTEGER NOT NULL DEFAULT 0;  -- snapshot; 0 = unset (counts as 20 in stats)
ALTER TABLE crags ADD COLUMN lat REAL;                            -- null = unset
ALTER TABLE crags ADD COLUMN lng REAL;

-- Backfill existing ticks from their linked route's length where known.
UPDATE ticks SET length = COALESCE((SELECT length FROM routes WHERE routes.id = ticks.route_id), 0) WHERE length = 0;
