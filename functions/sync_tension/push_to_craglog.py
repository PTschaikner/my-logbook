#!/usr/bin/env python3
"""Push a BoardLib tension.csv into Crag Log's /api/import/board endpoint.

Runs after sync_tension.sh has produced the CSV. Safe to re-run: the server
dedups on each ascent's import_key, so only new ascents are added.

Secrets come from the environment (never hardcode them):
  CRAGLOG_URL            base URL of your app,  e.g. https://<your-project>.pages.dev
  CRAGLOG_IMPORT_TOKEN   matches the Worker's IMPORT_TOKEN secret
  CF_ACCESS_CLIENT_ID    (optional) Cloudflare Access service-token id
  CF_ACCESS_CLIENT_SECRET(optional) Cloudflare Access service-token secret

Usage:  python3 push_to_craglog.py tension.csv
"""
import csv, json, os, sys, urllib.request, urllib.error

def truthy(v):
    return str(v).strip().lower() in ("true", "1", "yes")

def font_of(displayed, logged):
    # Grades arrive combined as "Font/V" (e.g. "5a/V1"); use the Font part.
    raw = (displayed or "").strip() or (logged or "").strip()
    return raw.split("/")[0].strip()

def result_of(is_ascent, tries, tries_total, is_repeat):
    if not is_ascent:
        return "attempt"
    # A flash is a true first encounter: sent, and never tried before. Use
    # tries_total (all tries on the boulder ever) — the per-session `tries`
    # would wrongly flag a first-go send in a later session as a flash.
    if not is_repeat and tries_total <= 1:
        return "flash"
    return "redpoint"   # tried before (earlier session or more than one try) -> redpoint

def transform(path):
    ascents = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = (row.get("climb_name") or "").strip()
            date = (row.get("date") or "")[:10]
            if not name or not date:
                continue
            mirror = truthy(row.get("is_mirror"))
            try:
                tries = int(float(row.get("tries") or 1))
            except ValueError:
                tries = 1
            try:
                tries_total = int(float(row.get("tries_total") or tries))
            except ValueError:
                tries_total = tries
            is_ascent = truthy(row.get("is_ascent"))
            is_repeat = truthy(row.get("is_repeat"))
            ascents.append({
                # dedup key: climb + mirror + date  (angle intentionally ignored)
                "import_key": f"{name}|{'1' if mirror else '0'}|{date}",
                "date": date,
                "name": name + (" (mirror)" if mirror else ""),
                "grade": font_of(row.get("displayed_grade"), row.get("logged_grade")),
                "result": result_of(is_ascent, tries, tries_total, is_repeat),
                "tries": max(1, tries),
                # BoardLib flags calibrated "benchmark" problems; carry it through.
                "is_benchmark": 1 if truthy(row.get("is_benchmark")) else 0,
            })
    return ascents

def main():
    if len(sys.argv) < 2:
        print("Usage: push_to_craglog.py <tension.csv>", file=sys.stderr); sys.exit(1)
    base = os.environ.get("CRAGLOG_URL", "").rstrip("/")
    token = os.environ.get("CRAGLOG_IMPORT_TOKEN", "")
    if not base or not token:
        print("Set CRAGLOG_URL and CRAGLOG_IMPORT_TOKEN in your environment first.", file=sys.stderr)
        sys.exit(1)

    ascents = transform(sys.argv[1])
    if not ascents:
        print("No ascents found in the CSV — nothing to push."); return
    print(f"Pushing {len(ascents)} ascents to {base}/api/import/board ...")

    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
        # Cloudflare's Browser Integrity Check 403s (error 1010) the default
        # "Python-urllib" agent; a normal UA gets us to Access + the Worker.
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) craglog-sync/1.0",
    }
    cid, csec = os.environ.get("CF_ACCESS_CLIENT_ID"), os.environ.get("CF_ACCESS_CLIENT_SECRET")
    if cid and csec:                     # get past Cloudflare Access with a service token
        headers["CF-Access-Client-Id"] = cid
        headers["CF-Access-Client-Secret"] = csec

    req = urllib.request.Request(
        f"{base}/api/import/board",
        data=json.dumps({"ascents": ascents}).encode("utf-8"),
        headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if "<html" in body.lower():
            print("Blocked by Cloudflare Access (got a login page, not the API).", file=sys.stderr)
            print("Add a service token to your Access policy and set CF_ACCESS_CLIENT_ID/SECRET,", file=sys.stderr)
            print("or add an Access bypass for /api/import/board.", file=sys.stderr)
            sys.exit(1)
        print(f"HTTP {e.code}: {body}", file=sys.stderr); sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Could not reach {base}: {e}", file=sys.stderr); sys.exit(1)

    try:
        data = json.loads(body)
    except ValueError:
        print("Unexpected response (not JSON):", body[:300], file=sys.stderr); sys.exit(1)
    print(f"Done. inserted={data.get('inserted')} updated={data.get('updated')} "
          f"skipped={data.get('skipped')} new sessions={data.get('sessions_created')}")

if __name__ == "__main__":
    main()
