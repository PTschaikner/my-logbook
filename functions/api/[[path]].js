// Crag Log API — one Pages Function handling everything under /api/*.
// Cloudflare routes any /api/... request here; we dispatch on method + path.
//
// Endpoints:
//   GET    /api/bootstrap                 crags (+routes), gym grades  — one call to hydrate the app
//   GET    /api/crags                     list crags
//   POST   /api/crags                     { name, region?, notes? }         -> crag
//   GET    /api/crags/:id/routes          routes at a crag
//   POST   /api/routes                    { crag_id, name, grade?, style? } -> route  (dedup on crag+name)
//   GET    /api/routes/:id                route + its full tick history
//   GET    /api/sessions                  recent sessions (list)
//   POST   /api/sessions                  { date, mode, crag_id?, place?, note?, ticks:[...] } -> session
//   GET    /api/sessions/:id              session + ticks
//   DELETE /api/sessions/:id              remove a session (and its ticks)
//   GET    /api/stats                     aggregates for the Stats view
//   GET    /api/settings/:key             read a setting
//   PUT    /api/settings/:key             { value } write a setting

// Categories ("modes"). Board / Boulder / Gym boulder are boulder types: Font scale, no metres.
const MODES = ["crag", "gym", "board", "multi", "cross", "boulder", "gymboulder"];
const BOULDERY = new Set(["board", "boulder", "gymboulder"]);
const NO_METRES = "('board','boulder','gymboulder')";
const normMode = (m) => (MODES.includes(m) ? m : "crag");

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

  // --- optional shared-secret gate -------------------------------------------
  if (env.APP_SECRET) {
    if (method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const auth = request.headers.get("authorization") || "";
    if (auth !== `Bearer ${env.APP_SECRET}`) {
      return cors(json({ error: "unauthorized" }, 401));
    }
  }

  const db = env.DB;
  // path after /api/  ->  ["crags"], ["routes","12"], ["crags","3","routes"] ...
  const parts = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "").split("/").filter(Boolean);

  // --- import endpoint has its own bearer gate (separate from the browser app) ---
  if (parts[0] === "import") {
    if (!env.IMPORT_TOKEN) return cors(json({ error: "import endpoint not configured" }, 503));
    const auth = request.headers.get("authorization") || "";
    if (auth !== `Bearer ${env.IMPORT_TOKEN}`) return cors(json({ error: "unauthorized" }, 401));
  }

  try {
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await safeJson(request) : null;
    const res = await route({ db, method, parts, body, url });
    return cors(res);
  } catch (err) {
    return cors(json({ error: String(err && err.message || err) }, 500));
  }
}

async function route({ db, method, parts, body, url }) {
  const [a, b, c] = parts;

  if (a === "bootstrap" && method === "GET") return bootstrap(db);

  if (a === "crags") {
    if (!b && method === "GET")  return listCrags(db);
    if (!b && method === "POST") return createCrag(db, body);
    if (b && c === "routes" && method === "GET") return cragRoutes(db, +b);
    if (b && c === "import" && method === "POST") return importRoutes(db, +b, body);
    if (b && !c && method === "GET")    return cragDetail(db, +b);
    if (b && !c && method === "PATCH")  return updateCrag(db, +b, body);
    if (b && !c && method === "DELETE") return deleteCrag(db, +b);
  }

  if (a === "routes") {
    if (!b && method === "POST") return createRoute(db, body);
    if (b && method === "GET")    return routeDetail(db, +b);
    if (b && method === "PATCH")  return updateRoute(db, +b, body);
    if (b && method === "DELETE") return deleteRoute(db, +b);
  }

  if (a === "sessions") {
    if (!b && method === "GET")    return listSessions(db);
    if (!b && method === "POST")   return createSession(db, body);
    if (b && c === "ticks" && method === "POST") return addTick(db, +b, body);
    if (b && method === "GET")     return sessionDetail(db, +b);
    if (b && method === "PATCH")   return updateSession(db, +b, body);
    if (b && method === "DELETE")  return deleteSession(db, +b);
  }

  if (a === "import" && b === "board" && method === "POST") return importBoard(db, body);
  if (a === "import" && b === "sessions" && method === "POST") return importSessions(db, body);
  if (a === "multi" && b === "ascents" && method === "POST") return logMultiAscent(db, body);
  if (a === "multi" && b === "ascents" && c && method === "PATCH") return updateMultiAscent(db, +c, body);
  if (a === "cross" && !b && method === "POST") return logCross(db, body);
  if (a === "cross" && b && method === "PUT") return updateCross(db, +b, body);
  if (a === "exercises" && !b && method === "GET") return listExercises(db);
  if (a === "exercises" && !b && method === "POST") return createExercise(db, body);
  if (a === "exercises" && b && method === "DELETE") return deleteExercise(db, +b);

  if (a === "ticks" && b) {
    if (method === "PATCH")  return updateTick(db, +b, body);
    if (method === "DELETE") return deleteTick(db, +b);
  }

  if (a === "stats" && method === "GET") return stats(db, url);
  if (a === "export" && method === "GET") return exportCsv(db, url);

  if (a === "settings" && b) {
    if (method === "GET") return getSetting(db, b);
    if (method === "PUT") return putSetting(db, b, body);
  }

  return json({ error: "not found" }, 404);
}

/* --------------------------------- reads --------------------------------- */

async function bootstrap(db) {
  const crags  = (await db.prepare(`SELECT * FROM crags ORDER BY name`).all()).results || [];
  const routes = (await db.prepare(`SELECT * FROM routes ORDER BY name`).all()).results || [];
  const byCrag = {};
  for (const r of routes) (byCrag[r.crag_id] ||= []).push(r);
  for (const c of crags) c.routes = byCrag[c.id] || [];
  const grades = await settingValue(db, "gym_grades");
  const gbGrades = await settingValue(db, "gymboulder_grades");
  const crossAct = await settingValue(db, "cross_activities");
  const exercises = (await db.prepare(`SELECT e.id, e.name, e.kind,
            (SELECT COUNT(*) FROM cross_entries ce WHERE ce.exercise_id = e.id) AS uses
       FROM exercises e ORDER BY e.kind, e.name`).all()).results || [];
  const appSettings = await settingValue(db, "app_settings");
  let settings = null;
  try { settings = appSettings ? JSON.parse(appSettings) : null; } catch (e) {}
  return json({ crags, gym_grades: grades ? JSON.parse(grades) : null, gymboulder_grades: gbGrades ? JSON.parse(gbGrades) : null, cross_activities: crossAct ? JSON.parse(crossAct) : null, exercises, settings });
}

async function listCrags(db) {
  const rows = (await db.prepare(`SELECT * FROM crags ORDER BY name`).all()).results || [];
  return json(rows);
}

async function cragRoutes(db, cragId) {
  const rows = (await db.prepare(`SELECT * FROM routes WHERE crag_id = ? ORDER BY name`).bind(cragId).all()).results || [];
  return json(rows);
}

async function routeDetail(db, id) {
  const route = await db.prepare(`SELECT * FROM routes WHERE id = ?`).bind(id).first();
  if (!route) return json({ error: "route not found" }, 404);
  const history = (await db.prepare(
    `SELECT t.*, s.date, s.id AS session_id
       FROM ticks t JOIN sessions s ON s.id = t.session_id
      WHERE t.route_id = ?
      ORDER BY s.date ASC, t.id ASC`
  ).bind(id).all()).results || [];

  const attempts = history.reduce((n, t) => n + (t.tries || 1), 0);
  const daysOn   = new Set(history.map(t => t.date)).size;
  const sent     = history.find(t => isSend(t.result));
  route.history = history;
  route.summary = {
    sessions: daysOn,
    attempts,
    first_tried: history.length ? history[0].date : null,
    sent: sent ? { date: sent.date, result: sent.result, tries: sent.tries } : null,
    // A "project" is a route worked on more than 3 separate days.
    status: sent ? "sent" : (daysOn > 3 ? "project" : "logged"),
  };
  return json(route);
}

async function listSessions(db) {
  const rows = (await db.prepare(
    `SELECT s.*,
            COUNT(t.id) AS tick_count,
            COALESCE(SUM(t.tries),0) AS tries_count,
            SUM(CASE WHEN t.result IN ('onsight','flash','redpoint') THEN 1 ELSE 0 END) AS send_count,
            COALESCE(SUM((CASE WHEN s.mode IN ${NO_METRES} THEN 0 WHEN s.mode='multi' THEN (CASE WHEN t.length>0 THEN t.length ELSE t.high_point*30 END) WHEN t.length>0 THEN t.length ELSE 20 END) * t.tries),0) AS metres,
            MAX(CASE WHEN s.mode='multi' THEN t.name END) AS mp_name,
            MAX(CASE WHEN s.mode='multi' THEN t.grade END) AS mp_grade,
            MAX(CASE WHEN s.mode='multi' THEN t.grade_fr END) AS mp_grade_fr,
            MAX(CASE WHEN s.mode='multi' THEN t.result END) AS mp_result,
            MAX(CASE WHEN s.mode='multi' THEN t.high_point END) AS mp_high,
            MAX(CASE WHEN s.mode='multi' THEN t.pitches_total END) AS mp_total,
            MAX(CASE WHEN s.mode='multi' THEN t.pitches END) AS mp_pitches,
            json_group_array(CASE WHEN t.id IS NOT NULL AND s.mode!='multi'
                             THEN json_object('g', COALESCE(NULLIF(t.grade_fr,''), t.grade), 'r', t.result, 't', t.tries) END) AS climbs_json,
            (SELECT json_group_array(json_object('name', ce.name, 'kind', ce.kind, 'sets', ce.sets, 'reps', ce.reps,
                     'weight', ce.weight, 'distance_m', ce.distance_m, 'elevation_m', ce.elevation_m, 'duration_s', ce.duration_s))
               FROM cross_entries ce WHERE ce.session_id = s.id) AS cross_entries_json
       FROM sessions s LEFT JOIN ticks t ON t.session_id = s.id
      GROUP BY s.id
      ORDER BY s.date DESC, s.id DESC`
  ).all()).results || [];
  return json(rows);
}

async function sessionDetail(db, id) {
  const s = await db.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first();
  if (!s) return json({ error: "session not found" }, 404);
  s.ticks = (await db.prepare(`SELECT * FROM ticks WHERE session_id = ? ORDER BY id`).bind(id).all()).results || [];
  s.cross_entries_json = (await db.prepare(
    `SELECT json_group_array(json_object('name', name, 'kind', kind, 'sets', sets, 'reps', reps,
       'weight', weight, 'distance_m', distance_m, 'elevation_m', elevation_m, 'duration_s', duration_s))
     FROM cross_entries WHERE session_id = ?`
  ).bind(id).first().then(r => (r ? Object.values(r)[0] : "[]"))) || "[]";
  return json(s);
}

/* --------------------------------- writes -------------------------------- */

async function createCrag(db, body) {
  const name = clean(body?.name);
  if (!name) return json({ error: "name required" }, 400);
  const found = await db.prepare(`SELECT * FROM crags WHERE lower(name) = lower(?)`).bind(name).first();
  if (found) return json(found);
  const lat = num(body?.lat), lng = num(body?.lng);
  const r = await db.prepare(
    `INSERT INTO crags (name, region, notes, lat, lng) VALUES (?,?,?,?,?) RETURNING *`
  ).bind(name, clean(body?.region), clean(body?.notes), lat, lng).first();
  return json(r, 201);
}

async function createRoute(db, body) {
  const cragId = +body?.crag_id;
  const name = clean(body?.name);
  if (!cragId || !name) return json({ error: "crag_id and name required" }, 400);
  const grade = clean(body?.grade);
  const system = normSystem(body?.grade_system);
  const length = Math.max(0, parseInt(body?.length, 10) || 0);
  const desc = clean(body?.description !== undefined ? body.description : body?.notes);
  const found = await db.prepare(
    `SELECT * FROM routes WHERE crag_id = ? AND lower(name) = lower(?)`
  ).bind(cragId, name).first();
  if (found) {
    // Upsert: fill in any fields provided (used by bulk import / re-add).
    const g = grade || found.grade;
    const sys = body?.grade_system !== undefined ? system : found.grade_system;
    const len = body?.length !== undefined ? length : found.length;
    const nt = (body?.description !== undefined || body?.notes !== undefined) ? desc : found.notes;
    const r = await db.prepare(
      `UPDATE routes SET grade=?, grade_system=?, grade_fr=?, length=?, notes=? WHERE id=? RETURNING *`
    ).bind(g, sys, toFrench(g, sys), len, nt, found.id).first();
    await syncTicksToRoute(db, found.id, found.name, g, sys, len);
    return json(r);
  }
  const r = await db.prepare(
    `INSERT INTO routes (crag_id, name, grade, grade_system, grade_fr, length, style, notes, kind)
     VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`
  ).bind(cragId, name, grade, system, toFrench(grade, system), length, clean(body?.style), desc, body?.kind === "boulder" ? "boulder" : "sport").first();
  return json(r, 201);
}

// Create a whole session and its ticks in one call. Any tick that carries a
// crag route name gets linked to (or creates) a persistent route row, so the
// route's history keeps growing.
// Bulk import of historical outdoor sessions, behind the /import token gate so a
// script can reach it without interactive Access. Upserts crags (name -> region +
// coords), then creates one crag session per (date, place) with its ticks. Safe to
// re-run: existing (date, place) crag sessions are skipped.
// Body: { crags:[{name,region,lat,lng}], sessions:[{date,place,note,ticks:[...]}] }
async function importSessions(db, body) {
  const crags = Array.isArray(body?.crags) ? body.crags : [];
  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  let cragN = 0, made = 0, skipped = 0, ticksN = 0;

  for (const c of crags) {
    const name = clean(c?.name);
    if (!name) continue;
    const region = clean(c?.region);
    const lat = (c?.lat === null || c?.lat === undefined || c?.lat === "") ? null : +c.lat;
    const lng = (c?.lng === null || c?.lng === undefined || c?.lng === "") ? null : +c.lng;
    const found = await db.prepare(`SELECT id FROM crags WHERE lower(name) = lower(?)`).bind(name).first();
    if (found) {
      await db.prepare(
        `UPDATE crags SET region = COALESCE(NULLIF(?,''), region), lat = COALESCE(?, lat), lng = COALESCE(?, lng) WHERE id = ?`
      ).bind(region, lat, lng, found.id).run();
    } else {
      await db.prepare(`INSERT INTO crags (name, region, lat, lng) VALUES (?,?,?,?)`).bind(name, region, lat, lng).run();
    }
    cragN++;
  }

  for (const s of sessions) {
    const date = clean(s?.date), place = clean(s?.place);
    if (!date || !place) continue;
    const dup = await db.prepare(`SELECT id FROM sessions WHERE date = ? AND place = ? AND mode = 'crag'`).bind(date, place).first();
    if (dup) { skipped++; continue; }
    const crag = await ensureCrag(db, place);
    const session = await db.prepare(
      `INSERT INTO sessions (date, mode, crag_id, place, note) VALUES (?, 'crag', ?, ?, ?) RETURNING *`
    ).bind(date, crag.id, place, clean(s?.note)).first();
    for (const t of (Array.isArray(s?.ticks) ? s.ticks : [])) {
      await insertTick(db, session.id, crag.id, "crag", t);
      ticksN++;
    }
    made++;
  }
  return json({ crags: cragN, sessions_created: made, sessions_skipped: skipped, ticks: ticksN });
}

async function createSession(db, body) {
  const date  = clean(body?.date) || new Date().toISOString().slice(0, 10);
  const mode  = ["gym","board","multi","boulder","gymboulder"].includes(body?.mode) ? body.mode : "crag";
  const place = clean(body?.place);
  const note  = clean(body?.note);
  let cragId  = body?.crag_id ? +body.crag_id : null;

  // Outdoors (routes or boulders), resolve/create the crag/area from its name so routes can attach.
  if ((mode === "crag" || mode === "boulder") && !cragId && place) {
    const crag = await ensureCrag(db, place);
    cragId = crag.id;
  }

  const session = await db.prepare(
    `INSERT INTO sessions (date, mode, crag_id, place, note) VALUES (?,?,?,?,?) RETURNING *`
  ).bind(date, mode, cragId, place, note).first();

  const ticks = Array.isArray(body?.ticks) ? body.ticks : [];
  const saved = [];
  for (const t of ticks) {
    const row = await insertTick(db, session.id, cragId, mode, t);
    saved.push(row);
  }
  session.ticks = saved;
  return json(session, 201);
}

// Bulk import of Tension Board ascents. Re-runnable: each ascent carries an
// import_key (climb_name|is_mirror|date); anything already present is skipped,
// and one board session is reused per day. Body: { ascents: [ { import_key,
// date, name, grade (Font), result, tries } ... ] }
async function importBoard(db, body) {
  const ascents = Array.isArray(body?.ascents) ? body.ascents : [];
  if (!ascents.length) return json({ error: "no ascents provided" }, 400);
  const PLACE = "Tensionboard";

  // Existing key -> tick id, so a re-sync updates rather than duplicates.
  const existing = {};
  for (const r of ((await db.prepare(`SELECT id, import_key FROM ticks WHERE import_key IS NOT NULL`).all()).results || []))
    existing[r.import_key] = r.id;
  const sessByDate = {};
  // reuse only the sync's own day sessions, never a hand-logged board session (e.g. Kilter)
  for (const s of ((await db.prepare(`SELECT id, date FROM sessions WHERE mode='board' AND place=?`).bind(PLACE).all()).results || []))
    sessByDate[s.date] = s.id;

  let inserted = 0, updated = 0, skipped = 0, sessionsCreated = 0;
  const seen = new Set();
  for (const a of ascents) {
    const date = clean(a?.date).slice(0, 10);
    const key  = clean(a?.import_key);
    if (!date || !key || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const grade  = clean(a?.grade);
    const name   = clean(a?.name);
    const result = normResult(a?.result);
    const tries  = Math.max(1, parseInt(a?.tries, 10) || 1);
    const bench  = (a?.is_benchmark ? 1 : 0);

    if (existing[key] != null) {
      // update in place — re-classified results (e.g. flash -> redpoint) land here
      await db.prepare(`UPDATE ticks SET name=?, grade=?, grade_fr=?, result=?, tries=?, is_benchmark=? WHERE id=?`)
        .bind(name, grade, grade, result, tries, bench, existing[key]).run();
      updated++; continue;
    }
    let sid = sessByDate[date];
    if (!sid) {
      const s = await db.prepare(`INSERT INTO sessions (date, mode, place) VALUES (?, 'board', ?) RETURNING id`).bind(date, PLACE).first();
      sid = s.id; sessByDate[date] = sid; sessionsCreated++;
    }
    await db.prepare(
      `INSERT INTO ticks (session_id, route_id, name, grade, grade_system, grade_fr, length, result, tries, note, import_key, is_benchmark)
       VALUES (?, NULL, ?, ?, 'font', ?, 0, ?, ?, '', ?, ?)`
    ).bind(sid, name, grade, grade, result, tries, key, bench).run();
    inserted++;
  }
  return json({ ok: true, inserted, updated, skipped, sessions_created: sessionsCreated });
}

// Insert one tick. At a crag, every climb becomes a persistent route — named
// ones as given, unnamed ones as a unique "Unnamed N" — so history and repeats
// always have something to attach to. Gym climbs stay unlinked.
async function insertTick(db, sessionId, cragId, mode, t) {
  const grade = clean(t?.grade);
  const system = normSystem(t?.grade_system);
  let name = clean(t?.name);
  let routeId = null;
  let route = null;
  if ((mode === "crag" || mode === "boulder") && cragId) {
    let routeName = name || await nextUnnamedName(db, cragId);
    route = await ensureRoute(db, cragId, routeName, grade, system, mode === "boulder" ? "boulder" : "sport");
    routeId = route.id;
    name = routeName;
  }
  // Length snapshot: explicit -> route's length -> default 20.
  let length = parseInt(t?.length, 10);
  if (!(length > 0)) length = (route && route.length > 0) ? route.length : 20;
  if (BOULDERY.has(mode)) length = 0;   // boulders don't count toward metres climbed
  return db.prepare(
    `INSERT INTO ticks (session_id, route_id, name, grade, grade_system, grade_fr, length, result, tries, note)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
  ).bind(
    sessionId, routeId, name, grade, system, toFrench(grade, system), length,
    normResult(t?.result), Math.max(1, +t?.tries || 1), clean(t?.note)
  ).first();
}

// Next free "Unnamed N" label for a crag.
async function nextUnnamedName(db, cragId) {
  const rows = (await db.prepare(
    `SELECT name FROM routes WHERE crag_id = ? AND name LIKE 'Unnamed %'`
  ).bind(cragId).all()).results || [];
  let max = 0;
  for (const r of rows) { const m = String(r.name).match(/^Unnamed\s+(\d+)$/i); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return "Unnamed " + (max + 1);
}

// Add a climb to an existing session (used when editing history).
async function addTick(db, sessionId, body) {
  const s = await db.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(sessionId).first();
  if (!s) return json({ error: "session not found" }, 404);
  const row = await insertTick(db, sessionId, s.crag_id, s.mode, body || {});
  return json(row, 201);
}

// Edit a tick in place. Recomputes the French value and re-links the route
// if the name/grade changed.
async function updateTick(db, id, body) {
  const t = await db.prepare(`SELECT * FROM ticks WHERE id = ?`).bind(id).first();
  if (!t) return json({ error: "tick not found" }, 404);
  const s = await db.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(t.session_id).first();

  const name   = body?.name   !== undefined ? clean(body.name)   : t.name;
  const grade  = body?.grade  !== undefined ? clean(body.grade)  : t.grade;
  const system = body?.grade_system !== undefined ? normSystem(body.grade_system) : t.grade_system;
  const result = body?.result !== undefined ? normResult(body.result) : t.result;
  const tries  = body?.tries  !== undefined ? Math.max(1, +body.tries || 1) : t.tries;
  const note   = body?.note   !== undefined ? clean(body.note)   : t.note;
  const length = body?.length !== undefined ? Math.max(0, parseInt(body.length, 10) || 0) : t.length;

  let routeId = t.route_id;
  if (s && (s.mode === "crag" || s.mode === "boulder") && s.crag_id && name) {
    const route = await ensureRoute(db, s.crag_id, name, grade, system, s.mode === "boulder" ? "boulder" : "sport");
    routeId = route.id;
  }
  const row = await db.prepare(
    `UPDATE ticks SET name=?, grade=?, grade_system=?, grade_fr=?, length=?, result=?, tries=?, note=?, route_id=?
      WHERE id=? RETURNING *`
  ).bind(name, grade, system, toFrench(grade, system), length, result, tries, note, routeId, id).first();
  return json(row);
}

async function deleteTick(db, id) {
  await db.prepare(`DELETE FROM ticks WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// Rename / re-grade a route, plus persistent length & description. Keeps linked
// ticks' snapshot name in sync so history reads consistently.
async function updateRoute(db, id, body) {
  const r = await db.prepare(`SELECT * FROM routes WHERE id = ?`).bind(id).first();
  if (!r) return json({ error: "route not found" }, 404);
  const name = body?.name !== undefined ? clean(body.name) : r.name;
  const grade = body?.grade !== undefined ? clean(body.grade) : r.grade;
  const system = body?.grade_system !== undefined ? normSystem(body.grade_system) : r.grade_system;
  const length = body?.length !== undefined ? Math.max(0, parseInt(body.length, 10) || 0) : r.length;
  const desc = body?.description !== undefined ? clean(body.description)
             : (body?.notes !== undefined ? clean(body.notes) : r.notes);
  if (!name) return json({ error: "name required" }, 400);
  const clash = await db.prepare(
    `SELECT id FROM routes WHERE crag_id = ? AND lower(name) = lower(?) AND id <> ?`
  ).bind(r.crag_id, name, id).first();
  if (clash) return json({ error: "a route with that name already exists at this crag" }, 409);
  // Multipitch topo edit: recompute overall grade + total length from all pitches.
  if (Array.isArray(body?.pitches)) {
    const pitches = parsePitches(body.pitches, system);
    const topo = JSON.stringify(pitches.map(p => ({ n: p.n, grade: p.grade, grade_fr: p.grade_fr, length: p.length, note: p.note })));
    const routeFr = multiOverall(pitches);
    let routeLength = 0; for (const p of pitches) routeLength += (p.length || 0);
    const total = Math.max(pitches.length, parseInt(body?.pitches_total, 10) || pitches.length);
    const row = await db.prepare(
      `UPDATE routes SET name=?, grade=?, grade_system=?, grade_fr=?, length=?, notes=?, kind='multi', pitches=?, pitches_total=? WHERE id=? RETURNING *`
    ).bind(name, routeFr, system, routeFr, routeLength, desc, topo, total, id).first();
    return json(row);
  }
  const row = await db.prepare(
    `UPDATE routes SET name=?, grade=?, grade_system=?, grade_fr=?, length=?, notes=? WHERE id=? RETURNING *`
  ).bind(name, grade, system, toFrench(grade, system), length, desc, id).first();
  await syncTicksToRoute(db, id, name, grade, system, length);
  return json(row);
}

// Keep a route's logged climbs consistent with the route: name, grade, and
// (when the route has one) length flow down to every linked tick, so History
// and Stats — including metres climbed — reflect edits made in the Crags view.
async function syncTicksToRoute(db, routeId, name, grade, system, length) {
  await db.prepare(
    `UPDATE ticks SET name=?, grade=?, grade_system=?, grade_fr=? WHERE route_id=?`
  ).bind(name, grade, normSystem(system), toFrench(grade, system), routeId).run();
  if (length > 0) {
    await db.prepare(`UPDATE ticks SET length=? WHERE route_id=?`).bind(length, routeId).run();
  }
}

async function deleteRoute(db, id) {
  await db.prepare(`DELETE FROM routes WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// Full crag with its routes (for the Crags management tab).
async function cragDetail(db, id) {
  const crag = await db.prepare(`SELECT * FROM crags WHERE id = ?`).bind(id).first();
  if (!crag) return json({ error: "crag not found" }, 404);
  crag.routes = (await db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM ticks WHERE route_id = r.id) AS tick_count
       FROM routes r WHERE r.crag_id = ? ORDER BY r.name`
  ).bind(id).all()).results || [];
  return json(crag);
}

async function updateCrag(db, id, body) {
  const c = await db.prepare(`SELECT * FROM crags WHERE id = ?`).bind(id).first();
  if (!c) return json({ error: "crag not found" }, 404);
  const name = body?.name !== undefined ? clean(body.name) : c.name;
  const region = body?.region !== undefined ? clean(body.region) : c.region;
  const notes = body?.description !== undefined ? clean(body.description)
              : (body?.notes !== undefined ? clean(body.notes) : c.notes);
  if (!name) return json({ error: "name required" }, 400);
  const clash = await db.prepare(`SELECT id FROM crags WHERE lower(name)=lower(?) AND id<>?`).bind(name, id).first();
  if (clash) return json({ error: "a crag with that name already exists" }, 409);
  const lat = body?.lat !== undefined ? num(body.lat) : c.lat;
  const lng = body?.lng !== undefined ? num(body.lng) : c.lng;
  const row = await db.prepare(
    `UPDATE crags SET name=?, region=?, notes=?, lat=?, lng=? WHERE id=? RETURNING *`
  ).bind(name, region, notes, lat, lng, id).first();
  // keep session place snapshots readable if the crag was renamed
  if (_low(name) !== _low(c.name)) await db.prepare(`UPDATE sessions SET place=? WHERE crag_id=?`).bind(name, id).run();
  return json(row);
}

async function deleteCrag(db, id) {
  // routes cascade-delete; sessions.crag_id and ticks.route_id fall to NULL,
  // so past sessions survive (just unlinked from the removed crag).
  await db.prepare(`DELETE FROM crags WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// Bulk import routes into a crag. body: { grade_system, routes:[{name,grade,length,description}] }
async function importRoutes(db, cragId, body) {
  const crag = await db.prepare(`SELECT * FROM crags WHERE id = ?`).bind(cragId).first();
  if (!crag) return json({ error: "crag not found" }, 404);
  const system = normSystem(body?.grade_system);
  const rows = Array.isArray(body?.routes) ? body.routes : [];
  let created = 0, updated = 0;
  for (const it of rows) {
    const name = clean(it?.name); if (!name) continue;
    const grade = clean(it?.grade);
    const length = Math.max(0, parseInt(it?.length, 10) || 0);
    const desc = clean(it?.description);
    const found = await db.prepare(`SELECT * FROM routes WHERE crag_id=? AND lower(name)=lower(?)`).bind(cragId, name).first();
    if (found) {
      const g = grade || found.grade;
      const sys = grade ? system : found.grade_system;
      const len = length || found.length;
      await db.prepare(`UPDATE routes SET grade=?, grade_system=?, grade_fr=?, length=?, notes=? WHERE id=?`)
        .bind(g, sys, toFrench(g, sys), len, desc || found.notes, found.id).run();
      await syncTicksToRoute(db, found.id, found.name, g, sys, len);
      updated++;
    } else {
      await db.prepare(`INSERT INTO routes (crag_id,name,grade,grade_system,grade_fr,length,notes) VALUES (?,?,?,?,?,?,?)`)
        .bind(cragId, name, grade, system, toFrench(grade, system), length, desc).run();
      created++;
    }
  }
  return json({ ok: true, created, updated });
}

// Edit a session's date / place / note. Re-links the crag if the place changed.
async function updateSession(db, id, body) {
  const s = await db.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first();
  if (!s) return json({ error: "session not found" }, 404);
  const date  = body?.date  !== undefined ? (clean(body.date) || s.date) : s.date;
  const place = body?.place !== undefined ? clean(body.place) : s.place;
  const note  = body?.note  !== undefined ? clean(body.note)  : s.note;
  const intensity = body?.intensity !== undefined ? Math.max(0, Math.min(4, parseInt(body.intensity, 10) || 0)) : s.intensity;
  let cragId = s.crag_id;
  if ((s.mode === "crag" || s.mode === "boulder") && place && _low(place) !== _low(s.place)) {
    const crag = await ensureCrag(db, place);
    cragId = crag.id;
  }
  const row = await db.prepare(
    `UPDATE sessions SET date=?, place=?, note=?, crag_id=?, intensity=? WHERE id=? RETURNING *`
  ).bind(date, place, note, cragId, intensity, id).first();
  return json(row);
}

async function insertCrossEntry(db, sessionId, e) {
  const kind = (["sets","endurance","effort"].includes(e?.kind)) ? e.kind : "effort";
  const name = clean(e?.name) || "Exercise";
  const exId = e?.exercise_id ? (parseInt(e.exercise_id, 10) || null) : null;
  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? n : null; };
  await db.prepare(
    `INSERT INTO cross_entries (session_id, exercise_id, name, kind, sets, reps, weight, distance_m, elevation_m, duration_s)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(sessionId, exId, name, kind,
    kind === "sets" ? num(e.sets) : null,
    kind === "sets" ? num(e.reps) : null,
    kind === "sets" ? num(e.weight) : null,
    kind === "endurance" ? num(e.distance_m) : null,
    kind === "endurance" ? num(e.elevation_m) : null,
    (kind === "endurance" || kind === "effort") ? num(e.duration_s) : null
  ).run();
}
function crossPlace(entries, fallback) {
  if (entries.length === 1) return clean(entries[0].name) || fallback;
  if (entries.length > 1) return entries.length + " exercises";
  return fallback;
}

// Off-wall training. A session (mode='cross') holds a 1-4 effort, a note, and
// any number of structured entries (sets / endurance / effort). Backward
// compatible: with no entries it behaves like the old effort-only log.
async function logCross(db, body) {
  const date = clean(body?.date) || new Date().toISOString().slice(0, 10);
  const intensity = Math.max(1, Math.min(4, parseInt(body?.intensity, 10) || 2));
  const note = clean(body?.note);
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  const place = crossPlace(entries, clean(body?.activity) || "Training");
  const s = await db.prepare(
    `INSERT INTO sessions (date, mode, place, note, intensity) VALUES (?, 'cross', ?, ?, ?) RETURNING *`
  ).bind(date, place, note, intensity).first();
  for (const e of entries) await insertCrossEntry(db, s.id, e);
  return json({ ok: true, session: s }, 201);
}

// Full edit of a training session: fields + entries (used to enrich old sessions too).
async function updateCross(db, id, body) {
  const s = await db.prepare(`SELECT * FROM sessions WHERE id = ? AND mode='cross'`).bind(id).first();
  if (!s) return json({ error: "not found" }, 404);
  const date = clean(body?.date) || s.date;
  const intensity = body?.intensity !== undefined ? Math.max(1, Math.min(4, parseInt(body.intensity, 10) || 2)) : s.intensity;
  const note = body?.note !== undefined ? clean(body.note) : s.note;
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  const place = crossPlace(entries, clean(body?.activity) || s.place || "Training");
  await db.prepare(`UPDATE sessions SET date=?, note=?, intensity=?, place=? WHERE id=?`).bind(date, note, intensity, place, id).run();
  await db.prepare(`DELETE FROM cross_entries WHERE session_id = ?`).bind(id).run();
  for (const e of entries) await insertCrossEntry(db, id, e);
  return json({ ok: true });
}

async function listExercises(db) {
  const rows = (await db.prepare(`SELECT e.id, e.name, e.kind,
            (SELECT COUNT(*) FROM cross_entries ce WHERE ce.exercise_id = e.id) AS uses
       FROM exercises e ORDER BY e.kind, e.name`).all()).results || [];
  return json(rows);
}
async function createExercise(db, body) {
  const name = clean(body?.name);
  const kind = (["sets","endurance","effort"].includes(body?.kind)) ? body.kind : "effort";
  if (!name) return json({ error: "name required" }, 400);
  await db.prepare(`INSERT OR IGNORE INTO exercises (name, kind) VALUES (?, ?)`).bind(name, kind).run();
  const row = await db.prepare(`SELECT id, name, kind FROM exercises WHERE name = ?`).bind(name).first();
  return json(row, 201);
}
async function deleteExercise(db, id) {
  await db.prepare(`DELETE FROM exercises WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function deleteSession(db, id) {
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function getSetting(db, key) {
  const v = await settingValue(db, key);
  return json({ key, value: v });
}
async function putSetting(db, key, body) {
  const value = typeof body?.value === "string" ? body.value : JSON.stringify(body?.value ?? null);
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
  return json({ key, value });
}

/* --------------------------------- stats --------------------------------- */

async function stats(db, url) {
  // scope: crag (outdoor) | gym | all ; optional date range from/to (YYYY-MM-DD)
  // hide: categories switched off in Settings; left out of every query (so "All" skips them)
  let scope = "crag", from = "", to = "", hide = [];
  try {
    const q = (url && url.searchParams);
    if (q) {
      const sc = q.get("scope") || ""; if (sc === "all" || MODES.includes(sc)) scope = sc;
      const f = q.get("from") || "", t = q.get("to") || "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(f)) from = f;
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) to = t;
      hide = (q.get("hide") || "").split(",").filter((m, i, a) => MODES.includes(m) && a.indexOf(m) === i);
    }
  } catch (e) {}
  const modeCond = scope === "all" ? "" : ` AND s.mode = '${normMode(scope)}'`;
  const hideCond = hide.length ? ` AND s.mode NOT IN (${hide.map(m => `'${m}'`).join(",")})` : "";
  const dateCond = (from ? ` AND s.date >= '${from}'` : "") + (to ? ` AND s.date <= '${to}'` : "") + hideCond;
  const filt = modeCond + dateCond;

  const sends = (await db.prepare(
    `SELECT COALESCE(NULLIF(t.grade_fr,''), t.grade) AS grade, t.result, s.date, s.mode AS mode
       FROM ticks t JOIN sessions s ON s.id = t.session_id
      WHERE t.result IN ('onsight','flash','redpoint')` + filt
  ).all()).results || [];
  const rsys = (mode) => (BOULDERY.has(mode) ? "font" : "french");

  const totals = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sessions s WHERE 1=1 ${filt})                                                 AS sessions,
       (SELECT COUNT(DISTINCT s.date) FROM sessions s WHERE 1=1 ${filt})                                   AS days,
       (SELECT COUNT(*) FROM ticks t JOIN sessions s ON s.id=t.session_id WHERE 1=1 ${filt})               AS ticks,
       (SELECT COUNT(*) FROM ticks t JOIN sessions s ON s.id=t.session_id
          WHERE t.result IN ('onsight','flash','redpoint') ${filt})                                        AS sends,
       (SELECT COALESCE(SUM(t.tries),0) FROM ticks t JOIN sessions s ON s.id=t.session_id WHERE 1=1 ${filt}) AS attempts,
       (SELECT COALESCE(SUM((CASE WHEN s.mode IN ${NO_METRES} THEN 0 WHEN s.mode='multi' THEN (CASE WHEN t.length>0 THEN t.length ELSE t.high_point*30 END) WHEN t.length>0 THEN t.length ELSE 20 END) * t.tries),0)
          FROM ticks t JOIN sessions s ON s.id=t.session_id WHERE 1=1 ${filt})                             AS metres`
  ).first();

  const styleCount = { onsight: 0, flash: 0, redpoint: 0 };
  for (const s of sends) { if (styleCount[s.result] != null) styleCount[s.result]++; }

  const monthMax = {};
  for (const s of sends) {
    const m = (s.date || "").slice(0, 7);
    if (!m) continue;
    const r = gradeRank(s.grade, rsys(s.mode));
    if (!monthMax[m] || r > monthMax[m].rank) monthMax[m] = { rank: r, grade: s.grade };
  }
  const progression = Object.entries(monthMax)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, grade: v.grade, rank: v.rank }));

  // Projects: never-sent routes tried on more than 3 separate days (within range).
  const projects = (await db.prepare(
    `SELECT r.id, r.name, COALESCE(NULLIF(r.grade_fr,''), r.grade) AS grade, r.crag_id,
            (SELECT name FROM crags WHERE id = r.crag_id) AS crag,
            SUM(t.tries)           AS attempts,
            COUNT(DISTINCT s.date) AS sessions
       FROM routes r
       JOIN ticks t    ON t.route_id = r.id
       JOIN sessions s ON s.id = t.session_id
      WHERE r.id NOT IN (
              SELECT route_id FROM ticks
               WHERE route_id IS NOT NULL AND result IN ('onsight','flash','redpoint')
            )` + dateCond + `
      GROUP BY r.id
      HAVING COUNT(DISTINCT s.date) > 3
      ORDER BY sessions DESC, attempts DESC`
  ).all()).results || [];

  // Activity heatmap: per-day counts split by activity type, ignoring the mode
  // filter so the calendar is a full overview that the scope can highlight.
  const actRows = (await db.prepare(
    `SELECT s.date AS date, s.mode AS mode,
            SUM(CASE WHEN s.mode='multi'
                     THEN (CASE WHEN t.high_point>0 THEN t.high_point
                                WHEN t.length>0 THEN MAX(1, CAST(round(t.length/30.0) AS INTEGER))
                                ELSE 1 END)
                     ELSE 1 END) AS cnt
       FROM ticks t JOIN sessions s ON s.id = t.session_id
      WHERE 1=1 ${dateCond}
      GROUP BY s.date, s.mode
      UNION ALL
      SELECT s.date AS date, 'cross' AS mode, MAX(s.intensity) AS cnt
        FROM sessions s WHERE s.mode='cross' ${dateCond}
        GROUP BY s.date
      ORDER BY date`
  ).all()).results || [];
  const actMap = {};
  for (const r of actRows) {
    const m = normMode(r.mode);
    if (!actMap[r.date]) actMap[r.date] = { date: r.date, crag: 0, gym: 0, board: 0, multi: 0, cross: 0, boulder: 0, gymboulder: 0, total: 0 };
    if (m === "cross") { actMap[r.date].cross = Math.max(actMap[r.date].cross, +r.cnt || 0); }
    else { actMap[r.date][m] += (+r.cnt || 0); actMap[r.date].total += (+r.cnt || 0); }
  }
  const activity = Object.keys(actMap).sort().map(k => actMap[k]);

  // Every climb (for the beeswarm): name, grade, result, tries, and route link.
  const climbs = (await db.prepare(
    `SELECT s.date AS date, t.name AS name, t.route_id AS route_id, s.mode AS mode, s.place AS place, t.pitches AS pitches,
            COALESCE(NULLIF(t.grade_fr,''), t.grade) AS grade,
            t.result AS result, t.tries AS tries
       FROM ticks t JOIN sessions s ON s.id = t.session_id
      WHERE 1=1 ${filt} ORDER BY s.date`
  ).all()).results || [];

  // Diverging grade pyramid: per grade, sends split by style + cumulative tries.
  const pyramidMap = {};
  for (const c of climbs) {
    const g = c.grade || "—";
    if (!pyramidMap[g]) pyramidMap[g] = { onsight: 0, flash: 0, redpoint: 0, tries: 0, mode: c.mode };
    if (pyramidMap[g][c.result] != null && ["onsight","flash","redpoint"].includes(c.result)) pyramidMap[g][c.result]++;
    pyramidMap[g].tries += (+c.tries || 1);
  }
  const pyramid = Object.entries(pyramidMap)
    .map(([grade, o]) => ({ grade, onsight: o.onsight, flash: o.flash, redpoint: o.redpoint,
                            sends: o.onsight + o.flash + o.redpoint, tries: o.tries, rank: gradeRank(grade, rsys(o.mode)) }))
    .filter(p => p.grade !== "—" && (p.sends > 0 || p.tries > 0))
    .sort((a, b) => b.rank - a.rank);

  // Full available span (ignores the date range) so the client can build pickers.
  const span = await db.prepare(
    `SELECT MIN(s.date) AS min, MAX(s.date) AS max FROM sessions s WHERE 1=1 ${modeCond}${hideCond}`
  ).first();

  // Per-discipline summary for the "All" overview (unscoped by mode).
  const nm = normMode;
  const discCounts = (await db.prepare(
    `SELECT s.mode AS mode,
            COUNT(DISTINCT s.id) AS sessions, COUNT(DISTINCT s.date) AS days,
            COUNT(t.id) AS ticks,
            SUM(CASE WHEN t.result IN ('onsight','flash','redpoint') THEN 1 ELSE 0 END) AS sends,
            COALESCE(SUM((CASE WHEN s.mode IN ${NO_METRES} THEN 0 WHEN s.mode='multi' THEN (CASE WHEN t.length>0 THEN t.length ELSE t.high_point*30 END) WHEN t.length>0 THEN t.length ELSE 20 END) * t.tries),0) AS metres
       FROM sessions s LEFT JOIN ticks t ON t.session_id = s.id
      WHERE 1=1 ${dateCond}
      GROUP BY s.mode`
  ).all()).results || [];
  const discSends = (await db.prepare(
    `SELECT s.mode AS mode, COALESCE(NULLIF(t.grade_fr,''), t.grade) AS grade
       FROM ticks t JOIN sessions s ON s.id = t.session_id
      WHERE t.result IN ('onsight','flash','redpoint') ${dateCond}`
  ).all()).results || [];
  const disciplines = { crag:{sessions:0,days:0,ticks:0,sends:0,metres:0,hardest:null},
                        gym:{sessions:0,days:0,ticks:0,sends:0,metres:0,hardest:null},
                        board:{sessions:0,days:0,ticks:0,sends:0,metres:0,hardest:null},
                        multi:{sessions:0,days:0,ticks:0,sends:0,metres:0,hardest:null},
                        cross:{sessions:0,days:0,ticks:0,sends:0,metres:0,hardest:null},
                        boulder:{sessions:0,days:0,ticks:0,sends:0,metres:0,hardest:null},
                        gymboulder:{sessions:0,days:0,ticks:0,sends:0,metres:0,hardest:null} };
  for (const r of discCounts) { const D = disciplines[nm(r.mode)]; D.sessions+=(+r.sessions||0); D.days+=(+r.days||0); D.ticks+=(+r.ticks||0); D.sends+=(+r.sends||0); D.metres+=(+r.metres||0); }
  const hardRank = {};
  for (const s of discSends) { const m = nm(s.mode); const r = gradeRank(s.grade, rsys(s.mode)); if (!(m in hardRank) || r > hardRank[m]) { hardRank[m] = r; disciplines[m].hardest = s.grade; } }

  // Multipitch extras for the multi info cards (needs pitch-level data).
  let multiInfo = null;
  if (scope === "multi") {
    const mt = (await db.prepare(
      `SELECT t.length AS length, t.result AS result, t.high_point AS high, t.pitches AS pitches
         FROM ticks t JOIN sessions s ON s.id = t.session_id WHERE s.mode='multi' ${dateCond}`
    ).all()).results || [];
    let topped = 0, bailed = 0, longest = 0, pitches = 0, ledFr = "", ledRank = -1;
    for (const t of mt) {
      if (t.result === "attempt") bailed++; else topped++;
      pitches += (+t.high || 0);
      let routeLen = 0;
      try { for (const p of JSON.parse(t.pitches || "[]")) { routeLen += (+p.length || 0); if (p.role === "lead" && p.result !== "notreached" && p.grade_fr) { const r = gradeRank(p.grade_fr, "french"); if (r > ledRank) { ledRank = r; ledFr = p.grade_fr; } } } } catch (e) {}
      if (!routeLen) routeLen = +t.length || 0;
      if (routeLen > longest) longest = routeLen;
    }
    multiInfo = { ascents: mt.length, topped, bailed, longest, pitches, hardestLed: ledFr };
  }

  // Benchmarks for the board card: distinct calibrated problems sent, plus
  // total benchmark sends (repeats included).
  let benchmarks = null;
  if (scope === "board") {
    const bm = await db.prepare(
      `SELECT COUNT(DISTINCT t.name) AS boulders, COUNT(*) AS sends
         FROM ticks t JOIN sessions s ON s.id = t.session_id
        WHERE s.mode='board' AND t.is_benchmark=1 AND t.result IN ('onsight','flash','redpoint') ${dateCond}`
    ).first();
    benchmarks = { boulders: bm ? (+bm.boulders || 0) : 0, sends: bm ? (+bm.sends || 0) : 0 };
  }

  // Per-location activity for the stats heatmap (outdoor + multi only).
  let geo = null;
  if (scope === "crag" || scope === "multi" || scope === "boulder") {
    const g = (await db.prepare(
      `SELECT c.name AS name, c.lat AS lat, c.lng AS lng, COUNT(t.id) AS count,
              json_group_array(json_object('d', s.date, 'n', t.name,
                'g', COALESCE(NULLIF(t.grade_fr,''), t.grade), 'r', t.result)) AS climbs_json
         FROM ticks t JOIN sessions s ON s.id = t.session_id JOIN crags c ON c.id = s.crag_id
        WHERE s.mode='${scope}' AND c.lat IS NOT NULL AND c.lng IS NOT NULL ${dateCond}
        GROUP BY c.id HAVING count > 0`
    ).all()).results || [];
    geo = g.map(r => { let cl = []; try { cl = JSON.parse(r.climbs_json || "[]"); } catch (e) {} return { name: r.name, lat: +r.lat, lng: +r.lng, count: +r.count || 0, climbs: cl }; });
  }

  // Training (cross) breakdown for its own scope: aggregate by EXERCISE, not the
  // auto session label. Per-exercise totals + a per-session time series for trends.
  let training = null;
  if (scope === "cross") {
    const srows = (await db.prepare(
      `SELECT s.intensity AS intensity, s.date AS date FROM sessions s WHERE s.mode='cross' ${dateCond}`
    ).all()).results || [];
    const byIntensity = { 1: 0, 2: 0, 3: 0, 4: 0 }, days = {};
    for (const r of srows) { byIntensity[Math.max(1, Math.min(4, +r.intensity || 2))]++; days[r.date] = 1; }

    const erows = (await db.prepare(
      `SELECT s.date AS date, ce.name AS name, ce.kind AS kind, ce.sets AS sets, ce.reps AS reps, ce.weight AS weight,
              ce.distance_m AS distance_m, ce.elevation_m AS elevation_m, ce.duration_s AS duration_s
         FROM cross_entries ce JOIN sessions s ON s.id = ce.session_id
        WHERE s.mode='cross' ${dateCond} ORDER BY s.date`
    ).all()).results || [];

    const ex = {};   // name -> aggregate
    const totals = { reps: 0, distance_m: 0, elevation_m: 0, duration_s: 0 };
    for (const r of erows) {
      const name = r.name || "Exercise", kind = r.kind || "effort";
      const e = ex[name] || (ex[name] = { name, kind, count: 0, dates: {},
        totalReps: 0, bestReps: 0, bestWeight: 0, distance_m: 0, elevation_m: 0, duration_s: 0, series: {} });
      e.count++; e.dates[r.date] = 1; e.lastDate = r.date;
      const n = (v) => (isFinite(+v) && +v > 0 ? +v : 0);
      let sv = 0;   // series value for this row
      if (kind === "sets") {
        const vol = n(r.sets) * n(r.reps);
        e.totalReps += vol; totals.reps += vol; sv = vol;
        if (n(r.reps) > e.bestReps) e.bestReps = n(r.reps);
        if (n(r.weight) > e.bestWeight) e.bestWeight = n(r.weight);
      } else if (kind === "endurance") {
        e.distance_m += n(r.distance_m); e.elevation_m += n(r.elevation_m); e.duration_s += n(r.duration_s);
        totals.distance_m += n(r.distance_m); totals.elevation_m += n(r.elevation_m); totals.duration_s += n(r.duration_s);
        sv = n(r.distance_m) || n(r.duration_s);
      } else {
        e.duration_s += n(r.duration_s); totals.duration_s += n(r.duration_s); sv = n(r.duration_s);
      }
      e.series[r.date] = (e.series[r.date] || 0) + sv;
    }
    const exercises = Object.keys(ex).map(function (k) {
      const e = ex[k];
      const dates = Object.keys(e.series).sort();
      return { name: e.name, kind: e.kind, count: e.count, sessions: Object.keys(e.dates).length,
        totalReps: e.totalReps, bestReps: e.bestReps, bestWeight: e.bestWeight,
        distance_m: e.distance_m, elevation_m: e.elevation_m, duration_s: e.duration_s, lastDate: e.lastDate,
        series: dates.map(function (d) { return { date: d, v: e.series[d] }; }) };
    }).sort(function (a, b) { return b.sessions - a.sessions || b.count - a.count; });

    training = { sessions: srows.length, days: Object.keys(days).length, byIntensity, totals, exercises };
  }

  const sentPyr = pyramid.filter(p => p.sends > 0);
  const hardest = sentPyr.length ? sentPyr[0].grade : null;

  // Per-route rollups (from the scoped climbs) for the highlight cards.
  const SEND = new Set(["onsight", "flash", "redpoint", "clean"]);
  const byRoute = {};
  for (const c of climbs) {
    const key = (c.route_id != null) ? ("r" + c.route_id) : ("n:" + (c.name || "") + "|" + (c.place || ""));
    const r = byRoute[key] || (byRoute[key] = {
      id: (c.route_id != null ? c.route_id : null), name: c.name, grade: c.grade,
      crag: c.place, rank: gradeRank(c.grade, rsys(c.mode)), ticks: []
    });
    r.ticks.push({ date: c.date, result: c.result, tries: (+c.tries || 1) });
  }
  const routeVals = Object.keys(byRoute).map(k => byRoute[k]);

  // Hardest onsight and hardest flash, tracked separately (newest first).
  function topRoutesByResult(results){
    let top = 0;
    routeVals.forEach(r => { if (r.rank > top && r.ticks.some(t => results.has(t.result))) top = r.rank; });
    if (top <= 0) return [];
    return routeVals.filter(r => r.rank === top && r.ticks.some(t => results.has(t.result))).map(r => {
      const ft = r.ticks.filter(t => results.has(t.result)).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      return { id: r.id, name: r.name, grade: r.grade, crag: r.crag, date: ft.date, result: ft.result };
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  const hardestOnsights = topRoutesByResult(new Set(["onsight"]));
  const hardestFlashes = topRoutesByResult(new Set(["flash"]));
  const hardestRedpoints = topRoutesByResult(new Set(["redpoint", "clean"]));

  // Most tries to send: tries counted only up to (and including) the first send.
  let mostTriesToSend = null;
  routeVals.forEach(r => {
    const sd = r.ticks.filter(t => SEND.has(t.result)).map(t => t.date).sort()[0];
    if (!sd) return;
    const upto = r.ticks.filter(t => t.date <= sd);
    const tries = upto.reduce((a, t) => a + t.tries, 0);
    const sessions = new Set(upto.map(t => t.date)).size;
    if (!mostTriesToSend || tries > mostTriesToSend.tries)
      mostTriesToSend = { id: r.id, name: r.name, grade: r.grade, crag: r.crag, tries, sessions, date: sd };
  });

  // Biggest project: never-sent route with the most tries.
  let topProject = null;
  routeVals.forEach(r => {
    if (r.ticks.some(t => SEND.has(t.result))) return;
    const tries = r.ticks.reduce((a, t) => a + t.tries, 0);
    const sessions = new Set(r.ticks.map(t => t.date)).size;
    if (!topProject || tries > topProject.tries)
      topProject = { id: r.id, name: r.name, grade: r.grade, crag: r.crag, tries, sessions };
  });

  // Per-day training entries, for the activity-calendar day detail (any scope).
  const crossEntries = (await db.prepare(
    `SELECT s.date AS date, ce.name AS name, ce.kind AS kind, ce.sets AS sets, ce.reps AS reps, ce.weight AS weight,
            ce.distance_m AS distance_m, ce.elevation_m AS elevation_m, ce.duration_s AS duration_s
       FROM cross_entries ce JOIN sessions s ON s.id = ce.session_id
      WHERE s.mode='cross' ${dateCond} ORDER BY s.date`
  ).all()).results || [];

  return json({
    range: { from, to }, span,
    totals: Object.assign({}, totals, {
      projects: projects.length,
      crags: (await db.prepare(`SELECT COUNT(*) AS n FROM crags`).first()).n,
    }),
    pyramid, styles: styleCount, progression, projects, activity, climbs, crossEntries, disciplines, multiInfo, benchmarks, training, geo,
    highlights: { hardest_send: hardest, hardestRedpoints: hardestRedpoints, hardestOnsights: hardestOnsights, hardestFlashes: hardestFlashes, mostTriesToSend: mostTriesToSend, topProject: topProject },
  });
}

/* --------------------------------- export -------------------------------- */

// Tidy CSV: one row per logged climb (or multi-pitch ascent) and one row per training
// exercise. The columns follow the selection: only what applies to the chosen categories.
// Query: modes=crag,boulder,... from=YYYY-MM-DD to=... sep=comma|semicolon files=one|per
// files=per returns a ZIP with one CSV per category (each with its own columns).
const MODE_LABEL = { crag: "Outdoor routes", gym: "Indoor routes", multi: "Multi-pitch", boulder: "Outdoor boulder",
                     gymboulder: "Indoor boulder", board: "Board", cross: "Training" };
const MODE_SLUG = { crag: "outdoor-routes", gym: "indoor-routes", multi: "multi-pitch", boulder: "outdoor-boulder",
                    gymboulder: "indoor-boulder", board: "board", cross: "training" };
const EFFORT = ["", "Mild", "Moderate", "Hard", "Max"];
const rowType = (m) => (m === "cross" ? "exercise" : m === "multi" ? "multi-pitch" : BOULDERY.has(m) ? "boulder" : "route");

// Which columns a selection gets.
function exportColumns(modes) {
  const has = (m) => modes.includes(m);
  const climbing = modes.some(m => m !== "cross"), training = has("cross");
  const cols = ["date", "category"];
  if (climbing) cols.push("place");                                   // training "place" is only an auto label
  if (["crag", "boulder", "multi"].some(has)) cols.push("region");
  cols.push("session_id", "session_note");
  if (new Set(modes.map(rowType)).size > 1) cols.push("type");
  cols.push("name");
  if (climbing) cols.push("grade", "grade_system", "grade_standard", "result");
  if (modes.some(m => m !== "multi" && m !== "cross")) cols.push("tries");
  if (["crag", "gym", "multi"].some(has)) cols.push("length_m");      // boulders don't count metres
  if (has("multi")) cols.push("pitches_done", "pitches_total", "pitch_log");
  if (climbing) cols.push("note");
  if (has("board")) cols.push("benchmark", "source");
  if (training) cols.push("exercise_kind", "sets", "reps", "weight_kg", "distance_m", "elevation_m", "duration_min", "effort");
  return cols;
}

async function exportRows(db, modes, dateCond) {
  const climbModes = modes.filter(m => m !== "cross");
  const rows = [];
  if (climbModes.length) {
    const list = climbModes.map(m => `'${m}'`).join(",");
    const ticks = (await db.prepare(
      `SELECT s.id AS sid, s.date, s.mode, s.place, s.note AS snote, c.region,
              t.name, t.grade, t.grade_system, t.grade_fr, t.result, t.tries, t.length, t.note,
              t.pitches, t.high_point, t.pitches_total, t.is_benchmark, t.import_key
         FROM ticks t JOIN sessions s ON s.id = t.session_id LEFT JOIN crags c ON c.id = s.crag_id
        WHERE s.mode IN (${list}) ${dateCond}
        ORDER BY s.date, s.id, t.id`
    ).all()).results || [];
    for (const t of ticks) {
      const multi = t.mode === "multi", bouldery = BOULDERY.has(t.mode);
      let pitchLog = "";
      if (multi) {
        try {
          pitchLog = JSON.parse(t.pitches || "[]").map((p, i) =>
            ["P" + (i + 1), p.grade_fr || p.grade || "?", p.role || "lead",
             p.result === "notreached" ? "not reached" : p.result, p.length ? p.length + "m" : ""].filter(Boolean).join(" ")
          ).join("; ");
        } catch (e) {}
      }
      rows.push({
        mode: t.mode, date: t.date, category: MODE_LABEL[t.mode] || t.mode, place: t.place, region: t.region,
        session_id: t.sid, session_note: t.snote, type: rowType(t.mode),
        name: t.name, grade: t.grade, grade_system: t.grade_system, grade_standard: t.grade_fr || t.grade,
        result: t.result === "redpoint" && bouldery ? "send" : (t.result || ""),
        tries: multi ? "" : t.tries, length_m: bouldery ? "" : (t.length || ""),
        pitches_done: multi ? t.high_point : "", pitches_total: multi ? t.pitches_total : "", pitch_log: pitchLog,
        note: t.note, benchmark: t.mode === "board" ? (t.is_benchmark ? "yes" : "no") : "",
        source: t.import_key ? "tension-sync" : "manual",
      });
    }
  }
  if (modes.includes("cross")) {
    const ex = (await db.prepare(
      `SELECT s.id AS sid, s.date, s.place, s.note AS snote, s.intensity,
              ce.name, ce.kind, ce.sets, ce.reps, ce.weight, ce.distance_m, ce.elevation_m, ce.duration_s
         FROM sessions s LEFT JOIN cross_entries ce ON ce.session_id = s.id
        WHERE s.mode = 'cross' ${dateCond}
        ORDER BY s.date, s.id, ce.id`
    ).all()).results || [];
    for (const e of ex) {
      rows.push({
        mode: "cross", date: e.date, category: MODE_LABEL.cross, place: e.place, session_id: e.sid, session_note: e.snote,
        type: "exercise", name: e.name || e.place || "", source: "manual",
        exercise_kind: e.kind === "effort" ? "other" : (e.kind || ""), sets: e.sets, reps: e.reps, weight_kg: e.weight,
        distance_m: e.distance_m, elevation_m: e.elevation_m,
        duration_min: e.duration_s ? Math.round(e.duration_s / 6) / 10 : "",
        effort: EFFORT[Math.max(0, Math.min(4, +e.intensity || 0))] || "",
      });
    }
  }
  rows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.session_id || 0) - (y.session_id || 0)));
  return rows;
}

// CSV text: UTF-8 BOM (so Excel shows umlauts), CRLF line ends, quoted where needed.
function toCsv(rows, cols, sep) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const str = String(v);
    return /["\r\n]/.test(str) || str.includes(sep) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  return "﻿" + [cols.join(sep)].concat(rows.map(r => cols.map(c => cell(r[c])).join(sep))).join("\r\n") + "\r\n";
}

async function exportCsv(db, url) {
  const q = url.searchParams;
  let modes = (q.get("modes") || "").split(",").filter((m, i, a) => MODES.includes(m) && a.indexOf(m) === i);
  if (!modes.length) modes = MODES.slice();
  modes = MODES.filter(m => modes.includes(m));                        // stable order
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get("from") || "") ? q.get("from") : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get("to") || "") ? q.get("to") : "";
  const sep = q.get("sep") === "semicolon" ? ";" : ",";
  const dateCond = (from ? ` AND s.date >= '${from}'` : "") + (to ? ` AND s.date <= '${to}'` : "");
  const rows = await exportRows(db, modes, dateCond);
  const today = new Date().toISOString().slice(0, 10);
  const csvResponse = (body, name, n) => new Response(body, { status: 200, headers: {
    "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "x-rows": String(n) } });

  if (q.get("files") === "per") {
    // one CSV per category that has rows, each with columns for just that category
    const files = [];
    for (const m of modes) {
      const part = rows.filter(r => r.mode === m);
      if (part.length) files.push({ name: `my-logbook-${today}-${MODE_SLUG[m]}.csv`, text: toCsv(part, exportColumns([m]), sep), n: part.length });
    }
    if (files.length === 1) return csvResponse(files[0].text, files[0].name, files[0].n);
    if (files.length > 1) {
      const zip = makeZip(files.map(f => ({ name: f.name, data: new TextEncoder().encode(f.text) })));
      return new Response(zip, { status: 200, headers: {
        "content-type": "application/zip", "content-disposition": `attachment; filename="my-logbook-${today}.zip"`,
        "x-rows": String(rows.length), "x-files": String(files.length) } });
    }
  }
  const used = modes.filter(m => rows.some(r => r.mode === m));
  return csvResponse(toCsv(rows, exportColumns(used.length ? used : modes), sep), `my-logbook-${today}.csv`, rows.length);
}

// Minimal ZIP writer (files stored uncompressed): enough for a handful of CSVs, no library needed.
function makeZip(files) {
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (d) => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const now = new Date();
  const dosTime = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  const dosDate = ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const chunks = [], central = []; let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
    c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const parts = chunks.concat(central, [new Uint8Array(e.buffer)]);
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}

/* -------------------------------- helpers -------------------------------- */

async function ensureCrag(db, name) {
  const found = await db.prepare(`SELECT * FROM crags WHERE lower(name) = lower(?)`).bind(name).first();
  if (found) return found;
  return db.prepare(`INSERT INTO crags (name) VALUES (?) RETURNING *`).bind(name).first();
}

async function ensureRoute(db, cragId, name, grade, system, kind) {
  system = normSystem(system);
  const found = await db.prepare(
    `SELECT * FROM routes WHERE crag_id = ? AND lower(name) = lower(?)`
  ).bind(cragId, name).first();
  if (found) {
    // Backfill a grade if the route was created without one.
    if (grade && !found.grade) {
      await db.prepare(`UPDATE routes SET grade = ?, grade_system = ?, grade_fr = ? WHERE id = ?`)
        .bind(grade, system, toFrench(grade, system), found.id).run();
      found.grade = grade; found.grade_system = system; found.grade_fr = toFrench(grade, system);
    }
    return found;
  }
  return db.prepare(
    `INSERT INTO routes (crag_id, name, grade, grade_system, grade_fr, kind) VALUES (?,?,?,?,?,?) RETURNING *`
  ).bind(cragId, name, grade || "", system, toFrench(grade, system), kind === "boulder" ? "boulder" : "sport").first();
}

async function settingValue(db, key) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
  return row ? row.value : null;
}

function isSend(r) { return r === "onsight" || r === "flash" || r === "redpoint"; }
function normResult(r) {
  return ["onsight", "flash", "redpoint", "attempt"].includes(r) ? r : null;
}
// per-pitch result: leads can be os/flash/rp/aid/attempt; seconds clean/attempt
function normPitchResult(r) {
  r = _low(r);
  return ["onsight", "flash", "redpoint", "aid", "clean", "attempt", "notreached"].includes(r) ? r : "attempt";
}
function parsePitches(raw, system) {
  return (Array.isArray(raw) ? raw : []).map((p, i) => {
    const sys = normSystem(p?.system || system);
    const g = clean(p?.grade);
    return { n: i + 1, role: p?.role === "second" ? "second" : "lead", result: normPitchResult(p?.result),
             grade: g, grade_fr: toFrench(g, sys), length: parseInt(p?.length, 10) || 0,
             tries: Math.max(1, parseInt(p?.tries, 10) || 1), note: clean(p?.note) };
  });
}
function multiOverall(pitches) {
  let overallFr = "", best = -1;
  for (const p of pitches) { if (!p.grade_fr) continue; const r = gradeRank(p.grade_fr, "french"); if (r > best) { best = r; overallFr = p.grade_fr; } }
  return overallFr;
}
// Hardest pitch as {orig, fr} so displays can show the entered grade + conversion.
function multiOverallPair(pitches) {
  let fr = "", orig = "", best = -1;
  for (const p of pitches) { if (!p.grade_fr) continue; const r = gradeRank(p.grade_fr, "french"); if (r > best) { best = r; fr = p.grade_fr; orig = p.grade || p.grade_fr; } }
  return { fr, orig };
}
// Route topo describes ALL pitches (length + grade); the ascent counts only
// pitches actually climbed (send/attempt) for metres and high point.
function multiCompute(pitches) {
  const climbed = pitches.filter(p => p.result !== "notreached");
  let metres = 0; for (const p of climbed) metres += (p.length || 0) * Math.max(1, p.tries || 1);
  let routeLength = 0; for (const p of pitches) routeLength += (p.length || 0);
  return { climbed, high: climbed.length, metres, routeLength,
           ascentGrade: multiOverall(climbed), routeGrade: multiOverall(pitches) };
}
// Overall ascent outcome from the pitch log (for colour + pyramid).
function multiOutcome(pitches, high, total) {
  if (high < total) return "attempt";               // bailed
  if (!pitches.length) return "redpoint";           // completed, no pitch detail
  let allOnsight = true, allClean = true;
  for (const p of pitches) {
    const second = p.role === "second";
    const res = p.result;
    if (second) { allOnsight = false; if (res !== "clean") allClean = false; }
    else {
      if (res !== "onsight") allOnsight = false;
      if (res !== "onsight" && res !== "flash") allClean = false;
    }
  }
  if (allOnsight) return "onsight";
  if (allClean) return "flash";
  return "redpoint";
}
async function logMultiAscent(db, body) {
  const date = clean(body?.date).slice(0, 10);
  if (!date) return json({ error: "date required" }, 400);
  const name = clean(body?.name);
  if (!name) return json({ error: "route name required" }, 400);
  const areaName = clean(body?.area);
  const system = normSystem(body?.grade_system);
  const pitches = parsePitches(body?.pitches, system);
  let total, high, metres, ascentFr, ascentOrig, routeFr, routeOrig, routeLength, climbed;
  if (pitches.length) {
    const c = multiCompute(pitches);
    total = Math.max(pitches.length, parseInt(body?.pitches_total, 10) || pitches.length);
    high = c.high; metres = c.metres; routeLength = c.routeLength; climbed = c.climbed;
    const ap = multiOverallPair(climbed), rp = multiOverallPair(pitches);
    ascentFr = ap.fr; ascentOrig = ap.orig || ap.fr; routeFr = rp.fr; routeOrig = rp.orig || rp.fr;
  } else {
    total = Math.max(1, parseInt(body?.pitches_total, 10) || 1);
    high = Math.min(total, parseInt(body?.high_point, 10) >= 0 ? parseInt(body?.high_point, 10) : 0);
    routeLength = parseInt(body?.length, 10) || 0;
    metres = routeLength ? (total > 0 ? Math.round(routeLength * high / total) : routeLength) : 0;
    ascentOrig = clean(body?.overall_grade); ascentFr = toFrench(ascentOrig, system); routeFr = ascentFr; routeOrig = ascentOrig; climbed = [];
  }
  const overall = routeOrig || routeFr;   // ascent shows the full route grade (a bail is an attempt anyway)

  // resolve/create the area (reuse crags)
  let cragId = null;
  if (areaName) {
    let crag = await db.prepare(`SELECT id FROM crags WHERE lower(name)=lower(?)`).bind(areaName).first();
    if (!crag) crag = await db.prepare(`INSERT INTO crags (name) VALUES (?) RETURNING id`).bind(areaName).first();
    cragId = crag.id;
  }
  // upsert the multi route (saved & reusable). Route grade/length reflect ALL pitches.
  let routeId = null;
  if (cragId) {
    const topo = JSON.stringify(pitches.map(p => ({ n: p.n, grade: p.grade, grade_fr: p.grade_fr, length: p.length, note: p.note })));
    const found = await db.prepare(`SELECT id, pitches FROM routes WHERE crag_id=? AND lower(name)=lower(?)`).bind(cragId, name).first();
    if (found) {
      await db.prepare(`UPDATE routes SET kind='multi', grade=?, grade_system=?, grade_fr=?, length=MAX(length,?), pitches=CASE WHEN COALESCE(pitches,'')='' THEN ? ELSE pitches END, pitches_total=MAX(pitches_total, ?) WHERE id=?`)
        .bind(routeOrig || routeFr, system, routeFr, routeLength, topo, total, found.id).run();
      routeId = found.id;
    } else {
      const r = await db.prepare(`INSERT INTO routes (crag_id,name,grade,grade_system,grade_fr,length,kind,pitches,pitches_total) VALUES (?,?,?,?,?,?, 'multi', ?, ?) RETURNING id`)
        .bind(cragId, name, routeOrig || routeFr, system, routeFr, routeLength, topo, total).first();
      routeId = r.id;
    }
  }
  const outcome = multiOutcome(climbed, high, total);   // metres already computed (climbed × tries)

  const sess = await db.prepare(`INSERT INTO sessions (date,mode,crag_id,place,note) VALUES (?, 'multi', ?, ?, ?) RETURNING id`)
    .bind(date, cragId, areaName, clean(body?.note)).first();
  const pjson = JSON.stringify(pitches);
  const tick = await db.prepare(
    `INSERT INTO ticks (session_id,route_id,name,grade,grade_system,grade_fr,length,result,tries,note,pitches,high_point,pitches_total)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?) RETURNING *`
  ).bind(sess.id, routeId, name, overall, system, routeFr, metres, outcome, clean(body?.note), pjson, high, total).first();
  return json({ ok: true, session_id: sess.id, route_id: routeId, tick }, 201);
}

// Edit a logged multipitch ascent (from history or the route sheet).
async function updateMultiAscent(db, id, body) {
  const tk = await db.prepare(`SELECT id, route_id FROM ticks WHERE id=?`).bind(id).first();
  if (!tk) return json({ error: "not found" }, 404);
  const system = normSystem(body?.grade_system);
  const pitches = parsePitches(body?.pitches, system);
  let total, high, metres, ascentFr, ascentOrig, routeFr, routeOrig, routeLength, climbed;
  if (pitches.length) {
    const c = multiCompute(pitches);
    total = Math.max(pitches.length, parseInt(body?.pitches_total, 10) || pitches.length);
    high = c.high; metres = c.metres; routeLength = c.routeLength; climbed = c.climbed;
    const ap = multiOverallPair(climbed), rp = multiOverallPair(pitches);
    ascentFr = ap.fr; ascentOrig = ap.orig || ap.fr; routeFr = rp.fr; routeOrig = rp.orig || rp.fr;
  } else {
    total = Math.max(1, parseInt(body?.pitches_total, 10) || 1);
    high = Math.min(total, parseInt(body?.high_point, 10) >= 0 ? parseInt(body?.high_point, 10) : 0);
    routeLength = parseInt(body?.length, 10) || 0;
    metres = routeLength ? (total > 0 ? Math.round(routeLength * high / total) : routeLength) : 0;
    ascentOrig = clean(body?.overall_grade); ascentFr = toFrench(ascentOrig, system); routeFr = ascentFr; routeOrig = ascentOrig; climbed = [];
  }
  const overall = routeOrig || routeFr;   // ascent shows the full route grade
  const outcome = multiOutcome(climbed, high, total);
  await db.prepare(
    `UPDATE ticks SET grade=?, grade_system=?, grade_fr=?, length=?, result=?, note=?, pitches=?, high_point=?, pitches_total=? WHERE id=?`
  ).bind(overall, system, routeFr, metres, outcome, clean(body?.note), JSON.stringify(pitches), high, total, id).run();
  // keep the linked route's grade/length/topo current (route reflects ALL pitches)
  if (tk.route_id && pitches.length) {
    const topo = JSON.stringify(pitches.map(p => ({ n: p.n, grade: p.grade, grade_fr: p.grade_fr, length: p.length, note: p.note })));
    await db.prepare(`UPDATE routes SET grade_fr=?, grade=?, length=MAX(length,?), pitches=?, pitches_total=MAX(pitches_total,?) WHERE id=?`)
      .bind(routeFr, routeOrig || routeFr, routeLength, topo, total, tk.route_id).run();
  }
  const tick = await db.prepare(`SELECT * FROM ticks WHERE id=?`).bind(id).first();
  return json({ ok: true, tick });
}
function clean(v) { return (typeof v === "string" ? v : "").trim(); }
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }

/* ---- grade conversion (log in any system, display in French) ---- */
// Sport ladder: [french, yds, uiaa]. Boulder ladder: [font, v].
const SPORT = [["3","5.3","3"],["4a","5.4","4-"],["4b","5.5","4"],["4c","5.6","4+"],["5a","5.7","5-"],["5b","5.8","5+"],["5c","5.9","6"],["5c+","",""],["6a","5.10a","6+"],["6a+","5.10b","7-"],["6b","5.10c","7"],["6b+","5.10d","7+"],["6c","5.11a","8-"],["6c+","5.11b","8-"],["7a","5.11c","8"],["7a+","5.11d","8+"],["7b","5.12a","9-"],["7b+","5.12b","9-"],["7c","5.12c","9"],["7c+","5.12d","9+"],["8a","5.13a","10-"],["8a+","5.13b","10-"],["8b","5.13c","10"],["8b+","5.13d","10+"],["8c","5.14a","11-"],["8c+","5.14b","11"],["9a","5.14c","11+"],["9a+","5.14d","12-"],["9b","5.15a","12"],["9b+","5.15b","12+"],["9c","5.15c","13-"]];
const UIAA_SCALE=["3","4-","4","4+","5-","5","5+","6-","6","6+","7-","7","7+","8-","8","8+","9-","9","9+","10-","10","10+","11-","11","11+","12-"], UIAA_EXTRA={"5":"5a","6-":"5c"};
const BOULDER = [
  ["3","VB"],["4","V0"],["4+","V0+"],["5","V1"],["5+","V2"],["6A","V3"],["6A+","V3"],
  ["6B","V4"],["6B+","V4"],["6C","V5"],["6C+","V6"],["7A","V6"],["7A+","V7"],["7B","V8"],
  ["7B+","V8"],["7C","V9"],["7C+","V10"],["8A","V11"],["8A+","V12"],["8B","V13"],
  ["8B+","V14"],["8C","V15"],["8C+","V16"],["9A","V17"]
];
const GRADE_SYSTEMS = ["french","uiaa","yds","font","v","other"];
const _low = s => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, "");
const _fr = {}, _yds = {}, _uiaa = {}, _font = {}, _v = {};
for (let i = 0; i < SPORT.length; i++) { if(SPORT[i][0]) _fr[_low(SPORT[i][0])] = i; if(SPORT[i][1]) _yds[_low(SPORT[i][1])] = i; if(SPORT[i][2]) _uiaa[_low(SPORT[i][2])] = i; }
for (let j = 0; j < BOULDER.length; j++) { if (!(_low(BOULDER[j][0]) in _font)) _font[_low(BOULDER[j][0])] = j; if (!(_low(BOULDER[j][1]) in _v)) _v[_low(BOULDER[j][1])] = j; }

// (grade, system) -> French display string. Unknown values pass through.
function toFrench(grade, system) {
  const g = clean(grade); if (!g) return "";
  const sys = _low(system) || "french";
  if (sys === "french") return g;
  if (sys === "font") return g.toUpperCase();
  if (sys === "yds") { const a = _yds[_low(g)]; return a != null ? SPORT[a][0] : g; }
  if (sys === "uiaa") { const b = _uiaa[_low(g)]; if (b != null) return SPORT[b][0]; return UIAA_EXTRA[_low(g)] || g; }
  if (sys === "v") { const c = _v[_low(g)]; return c != null ? BOULDER[c][0] : g; }
  return g;
}
function _parseFrenchLike(g) {
  const s = _low(g);
  const m = s.match(/^(\d+)([abc])?(\+)?/);
  if (m) return 100 + parseInt(m[1], 10) * 6 + (m[2] ? {a:0,b:1,c:2}[m[2]] : 0) * 2 + (m[3] ? 1 : 0);
  const v = s.match(/^v(\d+)/); if (v) return 500 + parseInt(v[1], 10);
  return 0;
}
// Numeric rank for sorting/stats. Sport and boulder kept on separate bands.
function gradeRank(grade, system) {
  const sys = _low(system) || "french"; const g = clean(grade); if (!g) return 0;
  if (sys === "yds") { const a = _yds[_low(g)]; return a != null ? 100 + a : 0; }
  if (sys === "uiaa") { const b = _uiaa[_low(g)]; if (b != null) return 100 + b; const e = UIAA_EXTRA[_low(g)]; return (e != null && _fr[e] != null) ? 100 + _fr[e] : 0; }
  if (sys === "french") { const f = _fr[_low(g)]; return f != null ? 100 + f : _parseFrenchLike(g); }
  if (sys === "font") { const d = _font[_low(g)]; return d != null ? 500 + d : _parseFrenchLike(g); }
  if (sys === "v") { const c = _v[_low(g)]; return c != null ? 500 + c : 0; }
  return 0;
}
function normSystem(s) { s = _low(s); return GRADE_SYSTEMS.includes(s) ? s : "french"; }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}
function cors(res) {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type,authorization");
  return res;
}
