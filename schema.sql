-- Crag Log — D1 schema
-- Run once against your D1 database:  wrangler d1 execute craglog --file=./schema.sql --remote

PRAGMA foreign_keys = ON;

-- A place with a persistent set of routes.
CREATE TABLE IF NOT EXISTS crags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  region     TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  lat        REAL,
  lng        REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A route is a persistent identity, not a string you retype each visit.
-- Every attempt across every session links back to the same row, so a route
-- accumulates its own history.
CREATE TABLE IF NOT EXISTS routes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  crag_id    INTEGER NOT NULL REFERENCES crags(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  grade      TEXT NOT NULL DEFAULT '',         -- as entered, in grade_system
  grade_system TEXT NOT NULL DEFAULT 'french', -- french | uiaa | yds | font | v | other
  grade_fr   TEXT NOT NULL DEFAULT '',         -- French display value (computed)
  length     INTEGER NOT NULL DEFAULT 0,        -- route length in metres (0 = unset)
  style      TEXT NOT NULL DEFAULT '',         -- slab / vertical / overhang / crimpy ... free text
  notes      TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'sport',      -- sport | multi
  pitches    TEXT,                                -- JSON pitch topo for multipitch routes
  pitches_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(crag_id, name)
);

-- One day out. Ticks hang off it.
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,                  -- YYYY-MM-DD
  mode       TEXT NOT NULL DEFAULT 'crag',   -- crag | gym | board
  crag_id    INTEGER REFERENCES crags(id) ON DELETE SET NULL,
  place      TEXT NOT NULL DEFAULT '',       -- crag/gym name snapshot for display
  note       TEXT NOT NULL DEFAULT '',
  intensity  INTEGER NOT NULL DEFAULT 0,     -- cross-training effort 1-4 (0 for climbing sessions)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A single logged attempt/send. route_id is null for gym or freeform climbs;
-- name/grade are always snapshotted so history survives even if a route is renamed.
CREATE TABLE IF NOT EXISTS ticks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  route_id   INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  name       TEXT NOT NULL DEFAULT '',
  grade      TEXT NOT NULL DEFAULT '',         -- as entered, in grade_system
  grade_system TEXT NOT NULL DEFAULT 'french',
  grade_fr   TEXT NOT NULL DEFAULT '',         -- French display value (computed)
  length     INTEGER NOT NULL DEFAULT 0,        -- metres climbed for this tick (0 = unset)
  result     TEXT,                           -- onsight | flash | redpoint | attempt | null
  tries      INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  import_key TEXT,                             -- dedup key for imported board ascents (null = manual)
  pitches    TEXT,                             -- JSON per-ascent pitch log (multipitch)
  high_point INTEGER NOT NULL DEFAULT 0,       -- pitches completed this ascent
  pitches_total INTEGER NOT NULL DEFAULT 0,
  is_benchmark INTEGER NOT NULL DEFAULT 0,     -- board benchmark problem (from BoardLib is_benchmark)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value store for things like the gym grade list.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routes_crag    ON routes(crag_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date  ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_crag  ON sessions(crag_id);
CREATE INDEX IF NOT EXISTS idx_ticks_session  ON ticks(session_id);
CREATE INDEX IF NOT EXISTS idx_ticks_route    ON ticks(route_id);
CREATE INDEX IF NOT EXISTS idx_ticks_result   ON ticks(result);
CREATE INDEX IF NOT EXISTS idx_ticks_import   ON ticks(import_key);
CREATE INDEX IF NOT EXISTS idx_ticks_benchmark ON ticks(is_benchmark);

CREATE TABLE IF NOT EXISTS exercises (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'effort',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cross_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  exercise_id  INTEGER REFERENCES exercises(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  sets         INTEGER,
  reps         INTEGER,
  weight       REAL,
  distance_m   REAL,
  elevation_m  REAL,
  duration_s   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cross_entries_session ON cross_entries(session_id);
