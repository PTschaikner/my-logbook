-- Multipitch: routes carry a pitch topo; ticks record a per-ascent pitch log.
-- Apply: wrangler d1 execute mylogbook --file=./migrations/0005_multipitch.sql --remote
ALTER TABLE routes ADD COLUMN kind TEXT NOT NULL DEFAULT 'sport';   -- sport | multi
ALTER TABLE routes ADD COLUMN pitches TEXT;                          -- JSON topo: [{n,grade,system,grade_fr,length}]
ALTER TABLE routes ADD COLUMN pitches_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticks  ADD COLUMN pitches TEXT;                          -- JSON per-ascent: [{n,role,result,grade,grade_fr}]
ALTER TABLE ticks  ADD COLUMN high_point INTEGER NOT NULL DEFAULT 0; -- pitches completed this ascent
ALTER TABLE ticks  ADD COLUMN pitches_total INTEGER NOT NULL DEFAULT 0;
