-- Structured training: reusable exercise definitions + per-session entries.
-- kind: 'sets' (sets x reps, optional weight) | 'endurance' (distance/elevation/duration) | 'effort' (just there).
CREATE TABLE IF NOT EXISTS exercises (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'effort',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per exercise performed within a training (mode='cross') session.
CREATE TABLE IF NOT EXISTS cross_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  exercise_id  INTEGER REFERENCES exercises(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,          -- snapshot of the exercise name
  kind         TEXT NOT NULL,          -- snapshot of the kind
  sets         INTEGER,                -- sets kind
  reps         INTEGER,                -- sets kind: reps per set
  weight       REAL,                   -- sets kind: optional added weight (kg)
  distance_m   REAL,                   -- endurance kind
  elevation_m  REAL,                   -- endurance kind: vertical gain
  duration_s   INTEGER,                -- endurance kind
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cross_entries_session ON cross_entries(session_id);

-- Seed a sensible starter set (safe to re-run).
INSERT OR IGNORE INTO exercises (name, kind) VALUES
  ('Pull-ups','sets'), ('Push-ups','sets'), ('Dips','sets'), ('Core','sets'),
  ('Running','endurance'), ('Mountain biking','endurance'), ('Hiking','endurance'),
  ('Flexibility','effort'), ('Other','effort');
