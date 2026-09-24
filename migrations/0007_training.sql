-- Off-wall training/other-sport sessions use mode='cross'. They carry no ticks;
-- the activity type is stored in sessions.place and a 1-4 effort in intensity.
ALTER TABLE sessions ADD COLUMN intensity INTEGER NOT NULL DEFAULT 0;
