/* store.js — persistence for settings, club stats and round history (localStorage) */

const KEYS = {
  settings: 'gb.settings.v1',
  clubs: 'gb.clubstats.v1',
  rounds: 'gb.rounds.v1',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  units: 'yd',          // 'yd' | 'm'
  voice: true,          // speak announcements
  listen: true,         // mic shot detection
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

  getRounds() { return readArr(KEYS.rounds); },
  saveRound(round) {
    const rounds = readArr(KEYS.rounds);
    const i = rounds.findIndex(r => r.id === round.id);
    if (i >= 0) rounds[i] = round; else rounds.push(round);
    // keep the last 50 rounds
    localStorage.setItem(KEYS.rounds, JSON.stringify(rounds.slice(-50)));
  },
};
