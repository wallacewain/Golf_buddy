/* holeview.js — stylised top-down hole rendering on <canvas>.
 *
 * Draws the hole from OSM geometry — fairway, green, bunkers, water, the
 * tee-to-green line with distance arcs and the player — rotated so the hole
 * always plays "up" the screen. Works with no API key and doubles as the
 * quick-glance caddie view.
 */

import { bearing, dist, toRad } from './geo.js';

const COLORS = {
  bg: '#0d2b16',
  rough: '#14381d',
  fairway: '#2c6e35',
  green: '#4caf50',
  tee: '#3a8a44',
  bunker: '#e8d9a0',
  water: '#2a6fdb',
  line: 'rgba(255, 213, 74, 0.9)',
  player: '#4da3ff',
  text: 'rgba(255,255,255,0.85)',
};

export class HoleView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /**
   * @param hole    hole model from course.js
   * @param features course features (fairways, bunkers, water, tees, greens)
   * @param playerPos current position or null
   */
  render(hole, features, playerPos) {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    if (!hole) return;

    // Projection: meters relative to green center, rotated so tee→green
    // bearing points up the screen.
    const origin = hole.greenCenter;
    const rot = toRad(bearing(hole.tee, hole.greenCenter));
    const cosO = Math.cos(toRad(origin.lat));
    const M = 6371008.8 * Math.PI / 180;
    const project = (p) => {
      const x0 = (p.lng - origin.lng) * M * cosO;
      const y0 = (p.lat - origin.lat) * M;
      // rotate by -rot so the hole direction maps to +y
      const x = x0 * Math.cos(-rot) - y0 * Math.sin(-rot);
      const y = x0 * Math.sin(-rot) + y0 * Math.cos(-rot);
      return { x, y };
    };

    // Fit: hole length plus margin
    const pts = [project(hole.tee), { x: 0, y: 0 }];
    if (playerPos) pts.push(project(playerPos));
    let minX = -30, maxX = 30, minY = -40, maxY = 40;
    for (const p of pts) {
      minX = Math.min(minX, p.x - 45); maxX = Math.max(maxX, p.x + 45);
      minY = Math.min(minY, p.y - 45); maxY = Math.max(maxY, p.y + 45);
    }
    const scale = Math.min(w / (maxX - minX), h / (maxY - minY));
    const toScreen = (p) => {
      const q = project(p);
      return {
        x: (q.x - minX) * scale + (w - (maxX - minX) * scale) / 2,
        y: h - ((q.y - minY) * scale + (h - (maxY - minY) * scale) / 2),
      };
    };

    const nearHole = (poly) => poly.some(p =>
      dist(p, hole.greenCenter) < 700 || dist(p, hole.tee) < 700);

    const drawPoly = (poly, fill) => {
      if (!nearHole(poly)) return;
      ctx.beginPath();
      poly.forEach((p, i) => {
        const s = toScreen(p);
        i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };

    for (const f of features.fairways) drawPoly(f, COLORS.fairway);
    for (const t of features.tees) drawPoly(t, COLORS.tee);
    for (const wtr of features.water) drawPoly(wtr, COLORS.water);
    for (const b of features.bunkers) drawPoly(b, COLORS.bunker);
    if (hole.green) drawPoly(hole.green, COLORS.green);

    // Hole line
    ctx.beginPath();
    hole.line.forEach((p, i) => {
      const s = toScreen(p);
      i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
    });
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Flag on the green
    const g = toScreen(hole.greenCenter);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(g.x, g.y - 18); ctx.stroke();
    ctx.fillStyle = '#ff5252';
    ctx.beginPath();
    ctx.moveTo(g.x, g.y - 18); ctx.lineTo(g.x + 11, g.y - 14); ctx.lineTo(g.x, g.y - 10);
    ctx.closePath(); ctx.fill();

    // Player + distance arc to green
    if (playerPos) {
      const s = toScreen(playerPos);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.player;
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(s.x, s.y); ctx.lineTo(g.x, g.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
