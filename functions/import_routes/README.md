# Import an outdoor route logfile into My Logbook

Adds historical outdoor sessions (grouped by date + crag) to My Logbook — crag region +
coordinates, and every climb as a tick (routes are created too).

## API import (recommended) — via /api/import/sessions
This endpoint lives under `/api/import/*`, so it's covered by the same Cloudflare Access
bypass + `IMPORT_TOKEN` bearer your board sync already uses. **Requires deploying the updated
Worker** (`functions/api/[[path]].js`) which adds `POST /api/import/sessions`.

```bash
export CRAGLOG_URL="https://<your-project>.pages.dev"
export CRAGLOG_IMPORT_TOKEN="…"        # same value as the Worker's IMPORT_TOKEN (board sync token)
# if your board sync also sends a service token, set these too:
# export CF_ACCESS_CLIENT_ID="…"
# export CF_ACCESS_CLIENT_SECRET="…"

python3 import_routedatabase.py routedatabase.csv --dry-run   # preview mapping, no requests
python3 import_routedatabase.py routedatabase.csv             # import
```
The endpoint upserts crags (region + coords) and **skips any (date, crag) session that already
exists**, so re-running is safe. It creates routes as well as ticks.

## SQL alternative (no deploy, no token)
```bash
python3 import_routedatabase.py routedatabase.csv --sql > import_oldtable.sql
npx wrangler d1 execute craglog --file=import_oldtable.sql --remote
```
Also idempotent; stores ticks only (no `routes` rows).

## Result mapping
`OS`→onsight, `Flash`→flash, `Redpoint`/`Ecopoint`→redpoint, none→attempt (priority onsight>flash>redpoint).

## Data handling / choices
- **Collapsed crags**: where one crag name has several coordinate sets, the **first** is used.
- **Coordinates**: the export mangled them (dots as digit-group separators) and swapped lat/lng;
  the script strips to digits and assigns by plausible range (lat 40–50, lng 5–20), self-correcting.
- **Region**: from the `Region` column.
- **Grade ranges** (`5c - 6a`, `6c+/7a`) → the **first** grade (edit `clean_grade()` for the harder).
- **Idempotent** both ways.

Run with `--dry-run` first: it prints how many crags, sessions and climbs it found, so you
can check the mapping before anything is written.
