-- Adds a persistent route length (metres). Additive and safe on live data.
-- Apply:  wrangler d1 execute mylogbook --file=./migrations/0002_route_length.sql --remote
ALTER TABLE routes ADD COLUMN length INTEGER NOT NULL DEFAULT 0;   -- 0 = unset
