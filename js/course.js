/* course.js — detect which golf course you're standing on and build hole
 * models from OpenStreetMap golf data (via the Overpass API).
 *
 * OSM golf tagging: leisure=golf_course (boundary), golf=hole (a polyline
 * from tee to green, tagged ref=<hole number>, par=, dist=), golf=green,
 * golf=tee, golf=fairway, golf=bunker, natural=water.
 */

import { dist, centroid, distToLine } from './geo.js';

const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

// A busy public server can hang for ages — give each one 9 s, then fail
// over to the next mirror instead of stalling the whole round start.
const ENDPOINT_TIMEOUT_MS = 9000;

async function overpass(query, onStatus) {
  let lastErr;
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    onStatus?.(i === 0 ? 'Looking up the course…' : `Trying map server ${i + 1} of ${OVERPASS_ENDPOINTS.length}…`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ENDPOINT_TIMEOUT_MS);
    try {
      const res = await fetch(OVERPASS_ENDPOINTS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`map server replied ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('map servers unreachable');
}

function wayGeom(el) {
  return (el.geometry || []).map(g => ({ lat: g.lat, lng: g.lon }));
}

export function emptyFeatures() {
  return {
    holes: [], greens: [], tees: [], fairways: [], bunkers: [], water: [],
    roughs: [], woods: [], trees: [], beaches: [], boundaries: [],
  };
}

/** Find the golf course nearest the player (within ~2.5 km). */
export async function findCourse(pos, onStatus) {
  const q = `[out:json][timeout:25];
(
  way["leisure"="golf_course"](around:2500,${pos.lat},${pos.lng});
  relation["leisure"="golf_course"](around:2500,${pos.lat},${pos.lng});
);
out tags center;`;
  const data = await overpass(q, onStatus);
  const courses = (data.elements || [])
    .filter(el => el.center)
    .map(el => ({
      id: `${el.type}/${el.id}`,
      name: el.tags?.name || 'Unknown course',
      center: { lat: el.center.lat, lng: el.center.lon },
      tags: el.tags || {},
    }))
    .sort((a, b) => dist(pos, a.center) - dist(pos, b.center));
  return courses[0] || null;
}

/** Fetch hole layouts + course features around the player.
 *  Two queries in parallel: the core golf data the round depends on, and a
 *  context query (trees, beach, rough, boundary — big and non-essential)
 *  that is allowed to fail or dawdle without blocking the round start. */
export async function loadCourseData(pos, onStatus) {
  const r = 3000, rc = 2200;
  const coreQ = `[out:json][timeout:30];
(
  way["golf"="hole"](around:${r},${pos.lat},${pos.lng});
  way["golf"="green"](around:${r},${pos.lat},${pos.lng});
  way["golf"="tee"](around:${r},${pos.lat},${pos.lng});
  way["golf"="fairway"](around:${r},${pos.lat},${pos.lng});
  way["golf"="bunker"](around:${r},${pos.lat},${pos.lng});
  way["natural"="water"](around:${r},${pos.lat},${pos.lng});
  way["golf"="water_hazard"](around:${r},${pos.lat},${pos.lng});
);
out geom;`;
  const ctxQ = `[out:json][timeout:20];
(
  way["golf"="rough"](around:${rc},${pos.lat},${pos.lng});
  way["natural"="scrub"](around:${rc},${pos.lat},${pos.lng});
  way["natural"="heath"](around:${rc},${pos.lat},${pos.lng});
  way["natural"="wood"](around:${rc},${pos.lat},${pos.lng});
  way["landuse"="forest"](around:${rc},${pos.lat},${pos.lng});
  way["natural"="beach"](around:${rc},${pos.lat},${pos.lng});
  way["natural"="sand"](around:${rc},${pos.lat},${pos.lng});
  way["leisure"="golf_course"](around:${rc},${pos.lat},${pos.lng});
  node["natural"="tree"](around:${rc},${pos.lat},${pos.lng});
);
out geom;`;
  const [data, ctxData] = await Promise.all([
    overpass(coreQ, onStatus),
    overpass(ctxQ).catch(e => { console.warn('context features unavailable', e); return null; }),
  ]);
  if (ctxData?.elements) data.elements = [...(data.elements || []), ...ctxData.elements];

  const features = {
    holes: [], greens: [], tees: [], fairways: [], bunkers: [], water: [],
    roughs: [], woods: [], trees: [], beaches: [], boundaries: [],
  };
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.natural === 'tree' && el.lat) features.trees.push({ lat: el.lat, lng: el.lon });
      continue;
    }
    if (el.type !== 'way') continue;
    const pts = wayGeom(el);
    if (pts.length < 2) continue;
    if (t.golf === 'hole') {
      features.holes.push({
        num: parseInt(t.ref, 10) || 0,
        par: parseInt(t.par, 10) || null,
        distM: t.dist ? parseFloat(t.dist) : null,
        line: pts,
      });
    } else if (t.golf === 'green') features.greens.push(pts);
    else if (t.golf === 'tee') features.tees.push(pts);
    else if (t.golf === 'fairway') features.fairways.push(pts);
    else if (t.golf === 'bunker') features.bunkers.push(pts);
    else if (t.golf === 'rough' || t.natural === 'scrub' || t.natural === 'heath') features.roughs.push(pts);
    else if (t.natural === 'wood' || t.landuse === 'forest') features.woods.push(pts);
    else if (t.natural === 'beach' || t.natural === 'sand') features.beaches.push(pts);
    else if (t.leisure === 'golf_course') features.boundaries.push(pts);
    else features.water.push(pts);
  }

  // Build hole models: pair each hole line with its green (polygon nearest
  // to the line's end point).
  const holes = features.holes
    .map(h => {
      const end = h.line[h.line.length - 1];
      let green = null, best = Infinity;
      for (const g of features.greens) {
        const d = dist(end, centroid(g));
        if (d < best) { best = d; green = g; }
      }
      const tee = h.line[0];
      const greenCenter = green && best < 80 ? centroid(green) : end;
      return {
        num: h.num, par: h.par, distM: h.distM,
        line: h.line, tee, green: best < 80 ? green : null, greenCenter,
      };
    })
    .filter(h => h.num >= 1 && h.num <= 36)
    .sort((a, b) => a.num - b.num);

  // Dedupe hole numbers (some courses map multiple tee lines per hole)
  const seen = new Map();
  for (const h of holes) if (!seen.has(h.num)) seen.set(h.num, h);

  return { holes: [...seen.values()], features };
}

/* ---------------------------------------------------------------- cache */

const CACHE_KEY = 'gb.coursecache.v3'; // v3: beach, heath and course boundary added
const CACHE_MAX_AGE_MS = 45 * 24 * 3600 * 1000; // courses don't move often
const CACHE_MAX_ENTRIES = 5;

// ~2 km grid tile — you start each round from roughly the same car park /
// first tee, so this hits on every repeat visit to a course.
function cacheTile(pos) {
  return `${Math.round(pos.lat * 50)},${Math.round(pos.lng * 50)}`;
}

function readCache(pos) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    const hit = all[cacheTile(pos)];
    if (hit && Date.now() - hit.t < CACHE_MAX_AGE_MS) return hit;
  } catch { /* corrupt cache — ignore */ }
  return null;
}

function writeCache(pos, entry) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    all[cacheTile(pos)] = { ...entry, t: Date.now() };
    // keep only the most recent courses so we stay well under quota
    const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
    for (const k of keys.slice(CACHE_MAX_ENTRIES)) delete all[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* quota — not fatal, just no cache */ }
}

/**
 * One-stop course load: cached when you've been here before, otherwise the
 * course lookup and hole-data queries run in parallel.
 * Returns { course, holes, features, fromCache }.
 */
export async function getCourse(pos, onStatus) {
  const cached = readCache(pos);
  if (cached) return { ...cached, fromCache: true };
  const [course, data] = await Promise.all([
    findCourse(pos, onStatus),
    loadCourseData(pos, onStatus),
  ]);
  const entry = { course, holes: data.holes, features: data.features };
  if (data.holes.length) writeCache(pos, entry);
  return { ...entry, fromCache: false };
}

/** Which hole is the player most likely on? (nearest hole corridor) */
export function nearestHole(pos, holes) {
  let best = null, bestD = Infinity;
  for (const h of holes) {
    const d = distToLine(pos, h.line);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best ? { hole: best, distM: bestD } : null;
}

/**
 * Distances (m) from player to the front / middle / back of the green.
 * Front/back are the nearest/farthest green-edge vertices from the player.
 */
export function greenDistances(pos, hole) {
  const middle = dist(pos, hole.greenCenter);
  if (!hole.green) return { front: middle, middle, back: middle, approx: true };
  let front = Infinity, back = 0;
  for (const v of hole.green) {
    const d = dist(pos, v);
    if (d < front) front = d;
    if (d > back) back = d;
  }
  return { front, middle, back, approx: false };
}
