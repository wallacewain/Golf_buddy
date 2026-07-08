/* geo.js — geometry helpers (all distances in meters unless noted) */

const EARTH_R = 6371008.8;

export function toRad(d) { return d * Math.PI / 180; }
export function toDeg(r) { return r * 180 / Math.PI; }

/** Great-circle distance in meters between {lat,lng} points. */
export function dist(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/** Initial bearing in degrees (0 = north) from a to b. */
export function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point at a given distance (m) and bearing (deg) from origin. */
export function destination(origin, distanceM, bearingDeg) {
  const δ = distanceM / EARTH_R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}

export function centroid(points) {
  let lat = 0, lng = 0;
  for (const p of points) { lat += p.lat; lng += p.lng; }
  return { lat: lat / points.length, lng: lng / points.length };
}

/** Ray-cast point-in-polygon on lat/lng (fine at course scale). */
export function inPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lng > pt.lng) !== (b.lng > pt.lng) &&
        pt.lat < (b.lat - a.lat) * (pt.lng - a.lng) / (b.lng - a.lng) + a.lat) {
      inside = !inside;
    }
  }
  return inside;
}

/** Min distance (m) from point to a polyline. */
export function distToLine(pt, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    best = Math.min(best, distToSegment(pt, line[i], line[i + 1]));
  }
  return best;
}

function distToSegment(p, a, b) {
  // Equirectangular projection around the segment — accurate at hole scale.
  const kx = Math.cos(toRad(a.lat)) * EARTH_R * Math.PI / 180;
  const ky = EARTH_R * Math.PI / 180;
  const ax = 0, ay = 0;
  const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky;
  const px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
  const len2 = bx * bx + by * by;
  let t = len2 ? ((px - ax) * bx + (py - ay) * by) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}

export const M_PER_YD = 0.9144;
export function mToYd(m) { return m / M_PER_YD; }
export function ydToM(yd) { return yd * M_PER_YD; }

/** Format meters in the user's units. */
export function fmtDist(m, units) {
  return units === 'm' ? `${Math.round(m)} m` : `${Math.round(mToYd(m))} yds`;
}

/** Round number in user's units (no suffix) — for big displays. */
export function distNum(m, units) {
  return Math.round(units === 'm' ? m : mToYd(m));
}
