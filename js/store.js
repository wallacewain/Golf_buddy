/* store.js — persistence for settings, club stats and round history (localStorage) */

const KEYS = {
  settings: 'gb.settings.v1',
  clubs: 'gb.clubstats.v1',
  rounds: 'gb.rounds.v1',
  tips: 'gb.holetips.v1',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  units: 'yd',          // 'yd' | 'm'
  voice: true,          // speak announcements
  listen: true,         // mic shot detection
  trees: true,          // 3D trees in the hole view
  sensitivity: 'normal' // 'low' | 'normal' | 'high'
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function readArr(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch { return []; }
}

export const store = {
  getSettings() { return read(KEYS.settings, DEFAULT_SETTINGS); },
  saveSettings(s) { localStorage.setItem(KEYS.settings, JSON.stringify(s)); },

  /** Club stats: { [clubId]: { count, avgM, bestM } } */
  getClubStats() { return read(KEYS.clubs, {}); },
  saveClubStats(stats) { localStorage.setItem(KEYS.clubs, JSON.stringify(stats)); },

  /** Per-hole notes: { [courseKey]: { [holeNum]: "aim left of the bunker" } } */
  getTip(courseKey, holeNum) {
    return read(KEYS.tips, {})[courseKey]?.[holeNum] || '';
  },
  saveTip(courseKey, holeNum, text) {
    const tips = read(KEYS.tips, {});
    if (!tips[courseKey]) tips[courseKey] = {};
    if (text.trim()) tips[courseKey][holeNum] = text.trim();
    else delete tips[courseKey][holeNum];
    if (!Object.keys(tips[courseKey]).length) delete tips[courseKey];
    localStorage.setItem(KEYS.tips, JSON.stringify(tips));
  },

  getRounds() { return readArr(KEYS.rounds); },
  saveRound(round) {
    const rounds = readArr(KEYS.rounds);
    const i = rounds.findIndex(r => r.id === round.id);
    if (i >= 0) rounds[i] = round; else rounds.push(round);
    // keep the last 50 rounds
    localStorage.setItem(KEYS.rounds, JSON.stringify(rounds.slice(-50)));
  },
};
