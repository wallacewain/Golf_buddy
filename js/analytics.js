/* analytics.js — turns raw round history into digestible decisions:
 * a per-hole "course book" for the courses you actually play, and a short
 * list of plain-English tips generated from your own numbers.
 *
 * Everything derives from data already on the phone; nothing is uploaded.
 */

import { mToYd } from './geo.js';
import { club } from './caddie.js';

/** Courses you have rounds on, most-played first. */
export function courseList(rounds) {
  const byCourse = new Map();
  for (const r of rounds) {
    if (!r.shots?.length) continue;
    const e = byCourse.get(r.courseName) || { name: r.courseName, plays: 0, last: 0 };
    e.plays += 1;
    e.last = Math.max(e.last, r.startedAt || 0);
    byCourse.set(r.courseName, e);
  }
  return [...byCourse.values()].sort((a, b) => b.plays - a.plays);
}

/**
 * Per-hole book for one course. Each entry:
 * { num, par, plays, avgShots, bestShots, teeClub, teeCount, teeAvgYd, tip }
 * Only confirmed shots inform the tee-club figures; stroke counts use all
 * logged shots (an unconfirmed club is still a stroke).
 */
export function courseBook(rounds, courseName, getTip) {
  const holes = new Map();
  for (const r of rounds) {
    if (r.courseName !== courseName || !r.shots?.length) continue;
    // strokes per hole in this round
    const perHole = new Map();
    for (const s of r.shots) {
      if (!s.hole) continue;
      if (!perHole.has(s.hole)) perHole.set(s.hole, []);
      perHole.get(s.hole).push(s);
    }
    for (const [num, shots] of perHole) {
      const h = holes.get(num) || {
        num, par: null, plays: 0, totalShots: 0, bestShots: Infinity, teeShots: [],
      };
      h.par = h.par || r.pars?.[num] || null;
      h.plays += 1;
      h.totalShots += shots.length;
      h.bestShots = Math.min(h.bestShots, shots.length);
      for (const s of shots) {
        if (s.ctx === 'tee' && s.confirmed) h.teeShots.push(s);
      }
      holes.set(num, h);
    }
  }

  return [...holes.values()]
    .sort((a, b) => a.num - b.num)
    .map(h => {
      // most-used tee club and its average measured carry
      const byClub = new Map();
      for (const s of h.teeShots) {
        const e = byClub.get(s.club) || { count: 0, sumM: 0, measured: 0 };
        e.count += 1;
        if (s.carryM) { e.sumM += s.carryM; e.measured += 1; }
        byClub.set(s.club, e);
      }
      let teeClub = null, teeCount = 0, teeAvgYd = null;
      for (const [id, e] of byClub) {
        if (e.count > teeCount) {
          teeClub = id; teeCount = e.count;
          teeAvgYd = e.measured ? Math.round(mToYd(e.sumM / e.measured)) : null;
        }
      }
      return {
        num: h.num,
        par: h.par,
        plays: h.plays,
        avgShots: h.totalShots / h.plays,
        bestShots: h.bestShots === Infinity ? null : h.bestShots,
        teeClub, teeCount, teeAvgYd,
        tip: getTip ? getTip(h.num) : '',
      };
    });
}

/** Short list of tips generated from the player's own numbers. */
export function smartTips(caddie, rounds) {
  const tips = [];
  const rows = caddie.summary();
  const byId = new Map(rows.map(r => [r.id, r]));

  // 1. Driver vs 3 wood overlap — the classic "why hit driver?" insight
  const dr = byId.get('DR'), w3 = byId.get('3W');
  if (dr && w3 && dr.count >= 3 && w3.count >= 3 && dr.avgYd - w3.avgYd < 12) {
    tips.push(`Your 3 Wood carries ${w3.avgYd} to the Driver's ${dr.avgYd} — on tight tee shots the 3 Wood costs you almost nothing.`);
  }

  // 2. Inconsistent clubs
  for (const r of rows) {
    if (r.count >= 4 && r.spreadYd !== null && r.spreadYd > Math.max(12, r.avgYd * 0.15)) {
      tips.push(`Your ${r.label} varies by about ±${r.spreadYd} yards — when the shot matters, take one more club and swing smooth.`);
    }
  }

  // 3. Distance gaps between neighbouring learned clubs
  const learned = rows.filter(r => r.count >= 3).sort((a, b) => b.avgYd - a.avgYd);
  for (let i = 0; i < learned.length - 1; i++) {
    const gap = learned[i].avgYd - learned[i + 1].avgYd;
    if (gap > 25) {
      tips.push(`There's a ${gap}-yard gap between your ${learned[i].label} (${learned[i].avgYd}) and ${learned[i + 1].label} (${learned[i + 1].avgYd}) — worth grooving a three-quarter ${learned[i].label}.`);
    }
  }

  // 4. Toughest and best holes on your most-played course
  const courses = courseList(rounds);
  if (courses.length) {
    const book = courseBook(rounds, courses[0].name, null)
      .filter(h => h.plays >= 2);
    if (book.length >= 3) {
      const worst = [...book].sort((a, b) => b.avgShots - a.avgShots)[0];
      const best = [...book].sort((a, b) => a.avgShots - b.avgShots)[0];
      tips.push(`Hole ${worst.num} at ${courses[0].name} is your toughest — ${worst.avgShots.toFixed(1)} shots on average. A safer tee club or a hole note might save you a stroke.`);
      if (best.num !== worst.num) {
        tips.push(`Hole ${best.num} is your scoring hole (${best.avgShots.toFixed(1)} avg) — whatever you do there, keep doing it.`);
      }
    }
  }

  // 5. Where your shots actually happen
  let sg = 0, all = 0;
  for (const r of rounds) {
    for (const s of r.shots || []) {
      all += 1;
      if (s.ctx === 'sg' || s.club === 'PT') sg += 1;
    }
  }
  if (all >= 40 && sg / all > 0.45) {
    tips.push(`${Math.round(sg / all * 100)}% of your shots are inside 50 yards — short-game practice pays off faster than range balls.`);
  }

  return tips.slice(0, 6);
}
