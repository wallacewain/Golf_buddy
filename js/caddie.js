/* caddie.js — club definitions, learned carry distances and recommendations.
 *
 * Every detected shot is logged with its GPS position. When the next shot
 * (or the hole-out) fixes where the ball ended up, the carry is the distance
 * between the two positions. Carries feed an exponentially-weighted average
 * per club, so recommendations track your real game and adapt over time.
 */

import { ydToM, mToYd } from './geo.js';
import { store } from './store.js';

/** id, label, spoken aliases, default carry (yards) used until we learn yours */
export const CLUBS = [
  { id: 'DR',  label: 'Driver',    yd: 230, say: ['driver', 'one wood', 'big dog', 'big stick'] },
  { id: '3W',  label: '3 Wood',    yd: 215, say: ['3 wood', 'three wood'] },
  { id: '5W',  label: '5 Wood',    yd: 200, say: ['5 wood', 'five wood'] },
  { id: '7W',  label: '7 Wood',    yd: 190, say: ['7 wood', 'seven wood'] },
  { id: '2H',  label: '2 Hybrid',  yd: 205, say: ['2 hybrid', 'two hybrid'] },
  { id: '3H',  label: '3 Hybrid',  yd: 195, say: ['3 hybrid', 'three hybrid', 'hybrid', 'rescue'] },
  { id: '4H',  label: '4 Hybrid',  yd: 185, say: ['4 hybrid', 'four hybrid'] },
  { id: '5H',  label: '5 Hybrid',  yd: 175, say: ['5 hybrid', 'five hybrid'] },
  { id: '2I',  label: '2 Iron',    yd: 200, say: ['2 iron', 'two iron'] },
  { id: '3I',  label: '3 Iron',    yd: 190, say: ['3 iron', 'three iron'] },
  { id: '4I',  label: '4 Iron',    yd: 180, say: ['4 iron', 'four iron', 'for iron'] },
  { id: '5I',  label: '5 Iron',    yd: 170, say: ['5 iron', 'five iron'] },
  { id: '6I',  label: '6 Iron',    yd: 160, say: ['6 iron', 'six iron'] },
  { id: '7I',  label: '7 Iron',    yd: 150, say: ['7 iron', 'seven iron'] },
  { id: '8I',  label: '8 Iron',    yd: 140, say: ['8 iron', 'eight iron', 'ate iron'] },
  { id: '9I',  label: '9 Iron',    yd: 130, say: ['9 iron', 'nine iron'] },
  { id: 'PW',  label: 'Pitch Wedge', yd: 115, say: ['pitching wedge', 'pitch wedge', 'p w', 'pw'] },
  { id: 'GW',  label: 'Gap Wedge',   yd: 100, say: ['gap wedge', 'approach wedge', 'fifty two', '52'] },
  { id: 'SW',  label: 'Sand Wedge',  yd: 85,  say: ['sand wedge', 'sandy', 'fifty six', '56'] },
  { id: 'LW',  label: 'Lob Wedge',   yd: 70,  say: ['lob wedge', 'lobber', 'sixty degree', '60'] },
  { id: 'PT',  label: 'Putter',      yd: 0,   say: ['putter', 'putt', 'flat stick'] },
];

const BY_ID = new Map(CLUBS.map(c => [c.id, c]));
export function club(id) { return BY_ID.get(id); }

/** Parse a spoken phrase into a club id (or null). */
export function parseClub(phrase) {
  const p = ' ' + phrase.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  // longest alias first so "sand wedge" wins over "wedge"
  const candidates = [];
  for (const c of CLUBS) {
    for (const alias of c.say) {
      if (p.includes(' ' + alias + ' ')) candidates.push({ id: c.id, len: alias.length });
    }
  }
  // bare "wedge" → pitching wedge; bare "iron" is too ambiguous
  if (!candidates.length && p.includes(' wedge ')) return 'PW';
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0]?.id || null;
}

const EWMA_ALPHA = 0.3;          // weight of the newest shot
const MIN_FULL_SWING_M = ydToM(30); // ignore chips/duffs for carry learning

/** Shot contexts: off the tee, approach (fairway/rough), short game. */
export const CTX = { tee: 'Tee', app: 'Approach', sg: 'Short' };

export class Caddie {
  constructor() {
    this.stats = store.getClubStats();
  }

  /**
   * Record a measured carry for a club, split by shot context so you can
   * see how a club performs off the tee vs. as a second shot vs. around
   * the green. Returns true if it counted.
   */
  recordCarry(clubId, meters, ctx = 'app') {
    if (clubId === 'PT' || meters < MIN_FULL_SWING_M || meters > 400) return false;
    const s = this.stats[clubId] || { count: 0, avgM: 0, bestM: 0, varM: 0, ctx: {} };
    s.ctx = s.ctx || {}; // migrate pre-context stats
    s.count += 1;
    if (s.count === 1) {
      s.avgM = meters;
      s.varM = 0;
    } else {
      const prevAvg = s.avgM;
      s.avgM += EWMA_ALPHA * (meters - s.avgM);
      // EWMA variance → "±" consistency figure
      s.varM = (1 - EWMA_ALPHA) * (s.varM || 0) + EWMA_ALPHA * (meters - prevAvg) ** 2;
    }
    s.bestM = Math.max(s.bestM, meters);
    const c = s.ctx[ctx] || { count: 0, avgM: 0 };
    c.count += 1;
    c.avgM = c.count === 1 ? meters : c.avgM + EWMA_ALPHA * (meters - c.avgM);
    s.ctx[ctx] = c;
    this.stats[clubId] = s;
    store.saveClubStats(this.stats);
    return true;
  }

  /**
   * Carry (m) for a club. With a context and ≥3 shots in that context, the
   * context average wins (your driver off the deck ≠ off a tee); otherwise
   * the overall learned average (≥2 shots), otherwise the default table.
   */
  carry(clubId, ctx = null) {
    const s = this.stats[clubId];
    if (ctx && s?.ctx?.[ctx]?.count >= 3) return s.ctx[ctx].avgM;
    if (s && s.count >= 2) return s.avgM;
    return ydToM(club(clubId).yd);
  }

  /** Consistency: ± meters around the average (null until ≥3 shots). */
  spread(clubId) {
    const s = this.stats[clubId];
    return s && s.count >= 3 ? Math.sqrt(s.varM || 0) : null;
  }

  learned(clubId) {
    const s = this.stats[clubId];
    return s ? s.count : 0;
  }

  /**
   * Recommend a club for a target distance (m), optionally biased by shot
   * context ('tee' | 'app' | 'sg') so tee-shot history informs tee shots.
   * Returns { primary, alt, note } where note flavours the advice
   * ("smooth", "step on it") based on how the carry compares.
   */
  recommend(targetM, ctx = null) {
    if (targetM < ydToM(25)) {
      return { primary: 'PT', alt: 'LW', note: 'around the green' };
    }
    const swingClubs = CLUBS.filter(c => c.id !== 'PT');
    // Clubs we've actually measured get a head start over default-table clubs,
    // so a learned club wins near-ties against a guess.
    const penalty = (id) => this.learned(id) >= 2 ? 0 : ydToM(5);
    const ranked = swingClubs
      .map(c => ({ id: c.id, carryM: this.carry(c.id, ctx), diff: this.carry(c.id, ctx) - targetM }))
      .sort((a, b) => (Math.abs(a.diff) + penalty(a.id)) - (Math.abs(b.diff) + penalty(b.id)));

    const primary = ranked[0];
    // alt = next-best on the other side of the target when available
    const alt = ranked.slice(1).find(r => Math.sign(r.diff) !== Math.sign(primary.diff)) || ranked[1];

    let note = '';
    if (primary.diff > ydToM(6)) note = 'smooth one';
    else if (primary.diff < -ydToM(6)) note = 'step on it';

    return { primary: primary.id, alt: alt?.id || null, note };
  }

  /** Clubs with learned data, for the insights screen. */
  summary() {
    return CLUBS
      .filter(c => this.stats[c.id]?.count)
      .map(c => {
        const s = this.stats[c.id];
        const spread = this.spread(c.id);
        const ctxYd = {};
        for (const k of Object.keys(CTX)) {
          const cs = s.ctx?.[k];
          if (cs?.count) ctxYd[k] = { avgYd: Math.round(mToYd(cs.avgM)), count: cs.count };
        }
        return {
          id: c.id, label: c.label,
          count: s.count,
          avgYd: Math.round(mToYd(s.avgM)),
          bestYd: Math.round(mToYd(s.bestM)),
          spreadYd: spread === null ? null : Math.round(mToYd(spread)),
          ctx: ctxYd,
        };
      });
  }
}
