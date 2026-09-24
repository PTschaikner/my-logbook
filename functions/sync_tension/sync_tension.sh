#!/usr/bin/env bash
# sync_tension.sh — pull your Tension Board logbook to tension.csv (run on your PC)
#
# Usage:
#   ./sync_tension.sh YOUR_TENSION_USERNAME
#
# What it does:
#   1. Makes sure boardlib is installed.
#   2. Downloads/syncs the shared Tension climb database (needed to turn
#      climb IDs into names + grades). First run downloads it; later runs
#      just sync the new bits, so re-running is fast.
#   3. Exports your full logbook (ascents + attempts) to tension.csv.
#
# Your password: it is NOT passed on the command line. You'll either be
# prompted for it, or you can set it once for this shell with:
#   export TENSION_PASSWORD='...'
# It never leaves your machine.

set -euo pipefail

USER_NAME="${1:-}"
if [ -z "$USER_NAME" ]; then
  echo "Usage: ./sync_tension.sh YOUR_TENSION_USERNAME" >&2
  exit 1
fi

DB="./tension.sqlite"
OUT="./tension.csv"

# 1. Ensure a private venv with boardlib exists (created once, reused after).
VENV="./.venv"
VPY="$VENV/bin/python"

if [ ! -x "$VPY" ]; then
  echo "Creating a virtual environment in $VENV ..."
  if ! python3 -m venv "$VENV" 2>/dev/null; then
    echo "Could not create the venv. Install the venv package once with:" >&2
    echo "  sudo apt update && sudo apt install -y python3-venv" >&2
    exit 1
  fi
fi

NEED_INSTALL=0
"$VPY" -c "import boardlib, PIL" 2>/dev/null || NEED_INSTALL=1
# boardlib 0.15.1 breaks on pandas 3.x (its groupby.apply relies on pre-3.0
# behavior), so require pandas 2.x.
"$VPY" -c "import pandas,sys; sys.exit(0 if pandas.__version__.split('.')[0]=='2' else 1)" 2>/dev/null || NEED_INSTALL=1

if [ "$NEED_INSTALL" = "1" ]; then
  echo "Installing/repairing boardlib dependencies in the venv..."
  "$VPY" -m pip install --upgrade pip >/dev/null
  "$VPY" -m pip install boardlib pillow 'pandas<3'
fi

# 2. Download / sync the Tension climb database (resolves names + grades).
echo "Syncing Tension database (this can take a minute on the first run)..."
"$VPY" -m boardlib database tension "$DB" --username "$USER_NAME"

# 3. Export your logbook to CSV.
echo "Exporting your logbook to $OUT ..."
"$VPY" -m boardlib logbook tension --username "$USER_NAME" --database-path "$DB" --output "$OUT"

# 4. Quick summary so you can eyeball that it worked.
"$VPY" - "$OUT" <<'PY'
import csv, sys
from collections import Counter
path = sys.argv[1]
rows = list(csv.DictReader(open(path, newline="", encoding="utf-8")))
sends = [r for r in rows if str(r.get("is_ascent", "")).strip().lower() in ("true", "1")]
dates = sorted(r["date"][:10] for r in rows if r.get("date"))
grades = Counter(r.get("displayed_grade") or r.get("logged_grade") for r in sends)
print("\n---- tension.csv ----")
print(f"rows total      : {len(rows)}")
print(f"  of which sends : {len(sends)}")
if dates:
    print(f"date range      : {dates[0]}  ->  {dates[-1]}")
if grades:
    top = ", ".join(f"{g}:{n}" for g, n in grades.most_common(6))
    print(f"top send grades : {top}")
print("---------------------")
print("Ready to import into My Logbook.")
PY
# 5. Push into the live app (only if configured). Safe to re-run: the server
#    dedups on each ascent, so this only ever adds new ascents.
#    Configure once in your shell (never hardcode):
#      export CRAGLOG_URL='https://<your-project>.pages.dev'
#      export CRAGLOG_IMPORT_TOKEN='...'                 # matches the Worker's IMPORT_TOKEN
#      export CF_ACCESS_CLIENT_ID='...'                  # optional: Access service token
#      export CF_ACCESS_CLIENT_SECRET='...'              # optional
if [ -n "${CRAGLOG_URL:-}" ] && [ -n "${CRAGLOG_IMPORT_TOKEN:-}" ]; then
  echo "Pushing to My Logbook..."
  "$VPY" "$(dirname "$0")/push_to_craglog.py" "$OUT"
else
  echo "Skipping push: set CRAGLOG_URL and CRAGLOG_IMPORT_TOKEN to sync straight into My Logbook."
fi
