/* course.js — detect which golf course you're standing on and build hole
 * models from OpenStreetMap golf data (via the Overpass API).
 *
 * OSM golf tagging: leisure=golf_course (boundary), golf=hole (a polyline
 * from tee to green, tagged ref=<hole number>, par=, dist=), golf=green,
 * golf=tee, golf=fairway, golf=bunker, natural=water.
 */

import { dist, centroid, distToLine } from './geo.js';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass unreachable');
}

function wayGeom(el) {
  return (el.geometry || []).map(g => ({ lat: g.lat, lng: g.lon }));
}

/** Find the golf course nearest the player (within ~2.5 km). */
export async function findCourse(pos) {
  const q = `[out:json][timeout:25];
(
  way["leisure"="golf_course"](around:2500,${pos.lat},${pos.lng});
  relation["leisure"="golf_course"](around:2500,${pos.lat},${pos.lng});
);
out tags center;`;
  const data = await overpass(q);
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

/** Fetch hole layouts + course features around the player. */
export async function loadCourseData(pos) {
  const r = 3000;
  const q = `[out:json][timeout:30];
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
  const data = await overpass(q);

  const features = { holes: [], greens: [], tees: [], fairways: [], bunkers: [], water: [] };
  for (const el of data.elements || []) {
    if (el.type !== 'way') continue;
    const pts = wayGeom(el);
    if (pts.length < 2) continue;
    const t = el.tags || {};
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
