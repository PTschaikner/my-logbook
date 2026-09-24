#!/usr/bin/env python3
"""Import an outdoor route logfile (RouteDatabase.csv) into My Logbook via the API.

Groups the CSV by (date, crag) into outdoor sessions (mode='crag'), auto-creates
each crag (with coords + region), and posts every climb as a tick in one call
per session.

Environment (same Cloudflare Access service token as the board sync):
  CRAGLOG_URL               e.g. https://<your-project>.pages.dev
  CF_ACCESS_CLIENT_ID       Cloudflare Access service-token id     (optional if no Access)
  CF_ACCESS_CLIENT_SECRET   Cloudflare Access service-token secret

Usage:
  python import_routedatabase.py RouteDatabase.csv --dry-run     # parse + preview, no requests
  python import_routedatabase.py RouteDatabase.csv               # do the import

Idempotent: skips any (date, crag) session that already exists, so re-running is safe.
"""
import csv, os, sys, re, json, urllib.request, urllib.error
from collections import defaultdict

def fixenc(s):
    if not s: return s
    try: return s.encode("latin-1").decode("utf-8")   # undo UTF-8-as-Latin-1 mojibake
    except Exception: return s

def clean_grade(g):
    g = (g or "").strip()
    if not g: return ""
    return re.split(r"\s*[/\u2013-]\s*", g)[0].strip()   # "5c - 6a"->"5c", "6c+/7a"->"6c+"

def result_of(r):
    T = lambda k: (r.get(k, "") or "").strip().upper() == "TRUE"
    if T("OS"): return "onsight"
    if T("Flash"): return "flash"
    if T("Redpoint") or T("Ecopoint"): return "redpoint"
    return "attempt"

def _headers():
    h = {"content-type": "application/json", "user-agent": "my-logbook-import/1.0"}
    token = os.environ.get("CRAGLOG_IMPORT_TOKEN")
    if token: h["authorization"] = f"Bearer {token}"
    cid = os.environ.get("CF_ACCESS_CLIENT_ID"); csec = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    if cid and csec:
        h["CF-Access-Client-Id"] = cid; h["CF-Access-Client-Secret"] = csec
    return h

def api(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}/api{path}", data=data, headers=_headers(), method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read() or "null")

def _digits(raw): return re.sub(r"\D", "", raw or "")

def _place_decimal(d, lo, hi):
    """The export mangled coords (dots as digit-group separators, variable integer
    length). Strip to digits and place the decimal so the value lands in range."""
    for cut in (2, 1, 3):
        if not d: return None
        v = float(d) if len(d) <= cut else float(d[:cut] + "." + d[cut:])
        if lo <= v <= hi: return round(v, 7)
    return None

def parse_coords(r):
    """Column labels are unreliable (latitude/longitude are swapped in the file),
    so assign each value by its plausible range: lat 40-50, lng 5-20."""
    lat = lng = None
    for col in ("Longitude", "Latitude"):
        d = _digits(r.get(col, ""))
        la = _place_decimal(d, 40, 50); ln = _place_decimal(d, 5, 20)
        if la is not None and lat is None: lat = la
        elif ln is not None and lng is None: lng = ln
    return lat, lng

def load(path):
    rows = [r for r in csv.DictReader(open(path, encoding="utf-8-sig")) if (r.get("Date") or "").strip()]
    for r in rows:
        for k in ("Crag", "Region", "RouteName", "Comment", "With"): r[k] = fixenc(r.get(k, ""))
    meta = {}
    for r in rows:
        c = r["Crag"]   # clean crag name is kept as-is
        if c not in meta:
            lat, lng = parse_coords(r)   # first coordinate seen for this crag wins
            meta[c] = {"region": (r.get("Region") or "").strip(), "lat": lat, "lng": lng}
    sess = defaultdict(list)
    for r in rows: sess[(r["Date"], r["Crag"])].append(r)
    return rows, meta, sess

def build_ticks(items):
    ticks = []
    for it in items:
        try: length = int(it["Length"])
        except Exception: length = None
        ticks.append({
            "name": it["RouteName"] or "Unnamed",
            "grade": clean_grade(it["Grade"]),
            "grade_system": "french",
            "result": result_of(it),
            "tries": int(it["Tries"]) if (it["Tries"] or "").strip().isdigit() else 1,
            "length": length if (length and length > 0) else None,
            "note": (it.get("Comment") or "").strip() or None,
        })
    return ticks

def _sqlstr(s): return "'" + (s or "").replace("'", "''") + "'"

def emit_sql(meta, sess):
    """Emit idempotent SQL for D1 (no API/Access needed). Ticks store their own
    name/grade/result, so routes aren't created (route_id stays NULL) — history and
    stats read the tick fields directly."""
    out = ["-- My Logbook: import outdoor sessions. Safe to re-run (idempotent).",
           "-- Run:  npx wrangler d1 execute craglog --file=import_oldtable.sql --remote"]
    for name, m in meta.items():
        lat = "NULL" if m["lat"] is None else repr(m["lat"])
        lng = "NULL" if m["lng"] is None else repr(m["lng"])
        out.append(f"INSERT OR IGNORE INTO crags (name,region,lat,lng) VALUES "
                   f"({_sqlstr(name)},{_sqlstr(m['region'])},{lat},{lng});")
    for (date, crag), items in sorted(sess.items()):
        withs = sorted({(it.get("With") or "").strip() for it in items if (it.get("With") or "").strip()})
        note = _sqlstr("with " + ", ".join(withs)) if withs else "''"
        out.append(f"INSERT INTO sessions (date,mode,crag_id,place,note) "
                   f"SELECT {_sqlstr(date)},'crag',id,{_sqlstr(crag)},{note} FROM crags WHERE name={_sqlstr(crag)} "
                   f"AND NOT EXISTS (SELECT 1 FROM sessions WHERE date={_sqlstr(date)} AND place={_sqlstr(crag)} AND mode='crag');")
        for t in build_ticks(items):
            length = t["length"] if t["length"] else 20
            out.append(f"INSERT INTO ticks (session_id,route_id,name,grade,grade_system,grade_fr,length,result,tries,note) "
                       f"SELECT s.id,NULL,{_sqlstr(t['name'])},{_sqlstr(t['grade'])},'french',{_sqlstr(t['grade'])},{length},{_sqlstr(t['result'])},{t['tries']},{_sqlstr(t.get('note') or '')} "
                       f"FROM sessions s WHERE s.date={_sqlstr(date)} AND s.place={_sqlstr(crag)} AND s.mode='crag' "
                       f"AND NOT EXISTS (SELECT 1 FROM ticks x WHERE x.session_id=s.id AND x.name={_sqlstr(t['name'])} AND x.grade={_sqlstr(t['grade'])} AND x.result={_sqlstr(t['result'])});")
    return "\n".join(out) + "\n"

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    as_sql = "--sql" in sys.argv
    path = args[0] if args else "RouteDatabase.csv"
    rows, meta, sess = load(path)

    if as_sql:
        sys.stdout.write(emit_sql(meta, sess))
        print(f"-- {len(rows)} climbs -> {len(sess)} sessions across {len(meta)} crags", file=sys.stderr)
        return

    print(f"{len(rows)} climbs -> {len(sess)} sessions across {len(meta)} crags")

    if dry:
        for (d, c), items in sorted(sess.items())[:6]:
            print(f"  {d} | {c} | " + "; ".join(
                f'{t["name"]} {t["grade"]} {t["result"]} (x{t["tries"]})' for t in build_ticks(items)))
        print("dry-run only; no requests sent.")
        return

    base = os.environ.get("CRAGLOG_URL", "").rstrip("/")
    token = os.environ.get("CRAGLOG_IMPORT_TOKEN", "")
    if not base or not token:
        print("Set CRAGLOG_URL and CRAGLOG_IMPORT_TOKEN (plus CF_ACCESS_CLIENT_ID/SECRET if you use a\n"
              "service token) first — or use --sql / --dry-run.", file=sys.stderr)
        sys.exit(1)

    crags = [{"name": n, "region": m["region"], "lat": m["lat"], "lng": m["lng"]} for n, m in meta.items()]
    payload_sessions = []
    for (date, crag), items in sorted(sess.items()):
        withs = sorted({(it.get("With") or "").strip() for it in items if (it.get("With") or "").strip()})
        note = ("with " + ", ".join(withs)) if withs else ""
        payload_sessions.append({"date": date, "place": crag, "note": note, "ticks": build_ticks(items)})

    # POST to /api/import/sessions (behind the IMPORT_TOKEN gate + your Access bypass).
    # Crags ride along in the first batch; sessions are chunked. The endpoint upserts
    # crags and skips (date, place) sessions that already exist, so re-running is safe.
    BATCH = 25
    total = {"crags": 0, "sessions_created": 0, "sessions_skipped": 0, "ticks": 0}
    try:
        for i in range(0, len(payload_sessions), BATCH):
            chunk = payload_sessions[i:i + BATCH]
            res = api(base, "POST", "/import/sessions",
                      {"crags": crags if i == 0 else [], "sessions": chunk}) or {}
            for k in total: total[k] += res.get(k, 0)
            print(f"  batch {i // BATCH + 1}: +{res.get('sessions_created', 0)} created, "
                  f"{res.get('sessions_skipped', 0)} skipped, {res.get('ticks', 0)} ticks")
    except urllib.error.HTTPError as e:
        print(f"\nHTTP {e.code}: {e.read().decode(errors='replace')[:300]}", file=sys.stderr)
        if e.code in (401, 403):
            print("Auth failed. Check CRAGLOG_IMPORT_TOKEN matches the Worker's IMPORT_TOKEN, and that\n"
                  "your Access bypass/service token covers /api/import/*.", file=sys.stderr)
        sys.exit(1)
    print(f"done: {total['sessions_created']} sessions created, {total['sessions_skipped']} skipped, "
          f"{total['ticks']} ticks, {total['crags']} crags upserted")

if __name__ == "__main__":
    main()
