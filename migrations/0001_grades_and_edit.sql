-- Adds grade-system tracking + a French display value to routes and ticks.
-- Additive and safe to run on a live database with existing data.
-- Apply:  wrangler d1 execute craglog --file=./migrations/0001_grades_and_edit.sql --remote

ALTER TABLE routes ADD COLUMN grade_system TEXT NOT NULL DEFAULT 'french';
ALTER TABLE routes ADD COLUMN grade_fr     TEXT NOT NULL DEFAULT '';
ALTER TABLE ticks  ADD COLUMN grade_system TEXT NOT NULL DEFAULT 'french';
ALTER TABLE ticks  ADD COLUMN grade_fr     TEXT NOT NULL DEFAULT '';

-- Existing grades were entered as French, so the French display equals the grade.
UPDATE routes SET grade_fr = grade WHERE grade_fr = '';
UPDATE ticks  SET grade_fr = grade WHERE grade_fr = '';
