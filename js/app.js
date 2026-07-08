/* app.js — Golf Buddy main controller.
 *
 * Flow: Start round → GPS finds the course (OpenStreetMap golf data) →
 * 3D flyover of the current hole (Google Maps) → the mic hears your shot →
 * the app asks "what club?" and listens → every shot is logged with GPS so
 * carries are measured → the caddie recommends clubs from your history.
 */

import { dist, fmtDist, distNum } from './geo.js';
import { store } from './store.js';
import { GPS } from './gps.js';
import { getCourse, nearestHole, greenDistances } from './course.js';
import { CLUBS, club, parseClub, Caddie } from './caddie.js';
import { Voice } from './voice.js';
import { ShotListener } from './shotlistener.js';
import { CourseMap } from './map3d.js';
import { HoleView } from './holeview.js';

const $ = (sel) => document.querySelector(sel);

/* ---------------------------------------------------------------- state */

const state = {
  settings: store.getSettings(),
  round: null,          // { id, courseName, startedAt, shots: [...] }
  course: null,         // { name, holes, features }
  hole: null,           // current hole model
  pendingShot: null,    // last shot waiting for its landing position
  lastShotAt: 0,
  view: 'map',          // 'map' | 'hole'
  userToggledView: false, // don't auto-switch views after a manual toggle
  demo: false,
};

const gps = new GPS();
const caddie = new Caddie();
let voice = new Voice(state.settings);
let shotListener = null;
let courseMap = null;
let holeView = null;
let wakeLock = null;

/* ------------------------------------------------------------- helpers */

function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function buzz(pattern = [80, 60, 80]) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.4);
    setTimeout(() => ctx.close(), 600);
  } catch { /* no audio */ }
}

function speakableDist(m) {
  return `${distNum(m, state.settings.units)} ${state.settings.units === 'm' ? 'meters' : 'yards'}`;
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* denied */ }
}

/* ---------------------------------------------------------- demo mode */

/** Simulated GPS for trying the app at home: walks St Andrews Old Course. */
class DemoGPS {
  constructor() { this.listeners = new Set(); this.position = null; }
  get available() { return true; }
  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  start() {
    this.position = { lat: 56.34295, lng: -2.80303, accuracy: 5, t: Date.now() };
    this.timer = setInterval(() => {
      // drift toward the current hole's green at a walking pace
      const target = state.hole?.greenCenter;
      if (target) {
        const d = dist(this.position, target);
        if (d > 12) {
          const step = 2.2 / d;
          this.position = {
            ...this.position,
            lat: this.position.lat + (target.lat - this.position.lat) * step,
            lng: this.position.lng + (target.lng - this.position.lng) * step,
            t: Date.now(),
          };
        }
      }
      for (const fn of this.listeners) fn(this.position);
    }, 1500);
    return Promise.resolve(this.position);
  }
  stop() { clearInterval(this.timer); }
}

/* ------------------------------------------------------------ round flow */

let activeGps = gps;

async function startRound(demo = false) {
  state.demo = demo;
  state.userToggledView = false;
  activeGps = demo ? new DemoGPS() : gps;

  $('#start-screen').classList.add('hidden');
  $('#round-screen').classList.remove('hidden');
  $('#status').textContent = demo ? 'Demo: teleporting to St Andrews…' : 'Finding you…';

  try {
    // Kick off the (slow) Google Maps 3D load immediately — it needs no
    // position, so it downloads while GPS + course data are being fetched.
    courseMap = new CourseMap($('#map'));
    const mapReady = courseMap.init(state.settings.apiKey);

    const pos = await activeGps.start();
    $('#status').textContent = 'Looking up the course…';

    const { course, holes, features, fromCache } = await getCourse(pos);
    const data = { holes, features };
    if (fromCache) console.info('course loaded from cache');

    if (!data.holes.length) {
      $('#status').textContent = course
        ? `On ${course.name}, but no hole map data exists for it yet.`
        : 'No golf course found nearby.';
      toast('Shot tracking still works — distances need course map data (openstreetmap.org).', 6000);
    }

    state.course = {
      name: course?.name || 'Unknown course',
      holes: data.holes,
      features: data.features,
    };
    state.round = {
      id: `r${Date.now()}`,
      courseName: state.course.name,
      startedAt: Date.now(),
      demo,
      shots: [],
    };

    $('#course-name').textContent = state.course.name;
    $('#status').textContent = '';

    // Show the instant 2D hole view right away; swap to the 3D map only
    // once its tiles are actually ready (it keeps loading in the background,
    // which on 4G can take a while — no reason to stare at a black screen).
    holeView = new HoleView($('#holecanvas'));
    setView('hole');
    mapReady.then(async (ok) => {
      if (!ok) return;
      if (state.hole) courseMap.showHole(state.hole, activeGps.position);
      await courseMap.whenSteady(12000); // let the 3D tiles settle first
      if (!state.userToggledView) setView('map');
    }).catch(() => {});

    // Start on the nearest hole (or #1)
    const near = data.holes.length ? nearestHole(pos, data.holes) : null;
    setHole(near ? near.hole : data.holes[0] || null, { announce: false });

    // Mic shot detection
    if (state.settings.listen) {
      try {
        shotListener = new ShotListener({
          sensitivity: state.settings.sensitivity,
          onShot: () => onShotDetected(),
        });
        await shotListener.start();
      } catch (e) {
        console.warn('Mic unavailable', e);
        toast('Mic blocked — use the Mark Shot button instead.', 5000);
      }
    }

    activeGps.onUpdate(onPosition);
    keepAwake();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { keepAwake(); shotListener?.resume(); }
    });

    updateGlance();
    const holeCount = data.holes.length;
    voice.speak(
      `Welcome to ${state.course.name}. ` +
      (state.hole ? `You're near hole ${state.hole.num}. ` : '') +
      (holeCount ? `${holeCount} holes mapped. ` : '') +
      `Play well. I'm listening for your shots.`
    );
  } catch (e) {
    console.error(e);
    $('#status').textContent = `Couldn't start: ${e.message || e}`;
  }
}

function setHole(hole, { announce = true } = {}) {
  state.hole = hole;
  if (!hole) {
    $('#hole-label').textContent = 'No hole data';
    return;
  }
  const len = hole.distM || dist(hole.tee, hole.greenCenter);
  $('#hole-label').textContent =
    `Hole ${hole.num}${hole.par ? ` · Par ${hole.par}` : ''} · ${fmtDist(len, state.settings.units)}`;
  courseMap?.showHole(hole, activeGps.position);
  drawHoleView();
  updateGlance();
  if (announce) {
    voice.speak(
      `Hole ${hole.num}. ` +
      (hole.par ? `Par ${hole.par}, ` : '') +
      `${speakableDist(len)}.`
    );
  }
}

function stepHole(delta) {
  if (!state.course?.holes.length) return;
  const holes = state.course.holes;
  const i = holes.findIndex(h => h === state.hole);
  const next = holes[(i + delta + holes.length) % holes.length];
  finalizePendingShot(activeGps.position); // walked off — settle the last shot
  setHole(next);
}

function onPosition(pos) {
  courseMap?.updatePlayer(pos);
  drawHoleView();
  updateGlance();
  maybeAutoAdvance(pos);
}

let autoAdvanceCandidate = null;

function maybeAutoAdvance(pos) {
  if (!state.course?.holes.length || !state.hole) return;
  const holes = state.course.holes;
  const i = holes.findIndex(h => h === state.hole);
  const next = holes[i + 1];
  if (!next) return;
  // Standing near the next tee and away from the current green → next hole
  if (dist(pos, next.tee) < 40 && dist(pos, state.hole.greenCenter) > 60) {
    if (!autoAdvanceCandidate) autoAdvanceCandidate = Date.now();
    if (Date.now() - autoAdvanceCandidate > 8000) {
      autoAdvanceCandidate = null;
      finalizePendingShot(state.hole.greenCenter);
      setHole(next);
    }
  } else {
    autoAdvanceCandidate = null;
  }
}

/* -------------------------------------------------------------- glance */

function updateGlance() {
  const pos = activeGps.position;
  if (!pos || !state.hole) {
    $('#dist-mid').textContent = '—';
    $('#dist-front').textContent = '';
    $('#dist-back').textContent = '';
    $('#club-reco').textContent = '';
    return;
  }
  const g = greenDistances(pos, state.hole);
  const u = state.settings.units;
  $('#dist-mid').textContent = distNum(g.middle, u);
  $('#dist-front').textContent = g.approx ? '' : `F ${distNum(g.front, u)}`;
  $('#dist-back').textContent = g.approx ? '' : `B ${distNum(g.back, u)}`;

  const reco = caddie.recommend(g.middle);
  const c = club(reco.primary);
  const learnedTag = caddie.learned(reco.primary) >= 2 ? '' : ' (default)';
  $('#club-reco').textContent =
    `${c.label}${reco.note ? ` — ${reco.note}` : ''}${learnedTag}`;
}

function drawHoleView() {
  if (state.view === 'hole' && holeView && state.hole && state.course) {
    holeView.render(state.hole, state.course.features, activeGps.position);
  }
}

function setView(v) {
  state.view = v;
  $('#map').classList.toggle('hidden', v !== 'map');
  $('#holecanvas').classList.toggle('hidden', v !== 'hole');
  $('#btn-view').textContent = v === 'map' ? 'Hole View' : '3D View';
  drawHoleView();
}

/* --------------------------------------------------------------- shots */

async function onShotDetected() {
  await recordShotInteractive('I heard that one!');
}

async function markShotManually() {
  await recordShotInteractive(null);
}

async function recordShotInteractive(heardPhrase) {
  const pos = activeGps.position;
  if (!pos || !state.round) return;
  if (Date.now() - state.lastShotAt < 5000) return; // double-trigger guard
  state.lastShotAt = Date.now();

  shotListener?.setPaused(true);
  buzz();
  chime();

  let clubId = null;
  if (voice.canListen && state.settings.voice) {
    await voice.speak(`${heardPhrase ? heardPhrase + ' ' : ''}What club?`);
    const heard = await voice.listenOnce({ timeoutMs: 6000 });
    clubId = heard ? parseClub(heard) : null;
    if (!clubId && heard) {
      await voice.speak("Didn't catch that — pick it on screen.");
    }
  }
  if (!clubId) clubId = await pickClubOnScreen();
  shotListener?.setPaused(false);
  if (!clubId) return; // dismissed — not a shot

  recordShot(clubId, pos);
}

function recordShot(clubId, pos) {
  // The previous shot's ball has been found: it landed where this one is hit from.
  finalizePendingShot(pos);

  const shot = {
    t: Date.now(),
    hole: state.hole?.num || null,
    club: clubId,
    pos: { lat: pos.lat, lng: pos.lng },
    carryM: null,
  };
  state.round.shots.push(shot);
  state.pendingShot = shot;
  store.saveRound(state.round);

  const c = club(clubId);
  toast(`${c.label} logged${shot.hole ? ` on hole ${shot.hole}` : ''}`);
  voice.speak(`${c.label}. Got it.`);
  renderShotCount();
}

function finalizePendingShot(landingPos) {
  const p = state.pendingShot;
  if (!p || !landingPos) return;
  const carry = dist(p.pos, landingPos);
  p.carryM = carry;
  state.pendingShot = null;
  const counted = caddie.recordCarry(p.club, carry);
  store.saveRound(state.round);
  if (counted) {
    toast(`${club(p.club).label}: ${fmtDist(carry, state.settings.units)} — noted`, 3000);
  }
}

function renderShotCount() {
  $('#shot-count').textContent = `${state.round.shots.length} shots`;
}

function pickClubOnScreen() {
  return new Promise((resolve) => {
    const sheet = $('#club-sheet');
    const grid = $('#club-grid');
    grid.innerHTML = '';
    for (const c of CLUBS) {
      const b = document.createElement('button');
      b.className = 'club-btn';
      b.textContent = c.label;
      b.onclick = () => { close(c.id); };
      grid.append(b);
    }
    const close = (id) => {
      sheet.classList.add('hidden');
      clearTimeout(timer);
      resolve(id);
    };
    $('#club-cancel').onclick = () => close(null);
    sheet.classList.remove('hidden');
    const timer = setTimeout(() => close(null), 30000);
  });
}

/* -------------------------------------------------------------- caddie */

async function askCaddie() {
  const pos = activeGps.position;
  if (!pos || !state.hole) {
    voice.speak('I need a GPS fix and hole data first.');
    return;
  }
  const g = greenDistances(pos, state.hole);
  const reco = caddie.recommend(g.middle);
  const c = club(reco.primary);
  const alt = reco.alt ? club(reco.alt) : null;

  let msg = `${speakableDist(g.middle)} to the middle`;
  if (!g.approx) msg += `, ${distNum(g.front, state.settings.units)} to the front`;
  msg += `. `;
  if (reco.primary === 'PT') {
    msg += `You're around the green.`;
  } else {
    msg += `I'd take the ${c.label}`;
    if (reco.note) msg += `, ${reco.note}`;
    if (alt && caddie.learned(reco.primary) < 2) msg += `, or the ${alt.label}`;
    msg += '.';
    if (caddie.learned(reco.primary) >= 2) {
      msg += ` You average ${speakableDist(caddie.carry(reco.primary))} with it.`;
    }
  }
  shotListener?.setPaused(true);
  await voice.speak(msg);
  shotListener?.setPaused(false);
  toast(msg, 6000);
}

/* --------------------------------------------------------- end / stats */

async function endRound() {
  finalizePendingShot(activeGps.position);
  activeGps.stop();
  shotListener?.stop();
  wakeLock?.release().catch(() => {});
  if (state.round) {
    state.round.endedAt = Date.now();
    store.saveRound(state.round);
  }
  const shots = state.round?.shots.length || 0;
  await voice.speak(`Round saved. ${shots} shots logged. See you next time.`);
  showStats();
  $('#round-screen').classList.add('hidden');
  $('#start-screen').classList.remove('hidden');
  state.round = null;
  state.pendingShot = null;
}

function showStats() {
  const rows = caddie.summary();
  const tbody = $('#stats-body');
  tbody.innerHTML = rows.length
    ? rows.map(r =>
        `<tr><td>${r.label}</td><td>${r.avgYd}</td><td>${r.bestYd}</td><td>${r.count}</td></tr>`
      ).join('')
    : '<tr><td colspan="4">No shots measured yet — play a round!</td></tr>';
  $('#stats-sheet').classList.remove('hidden');
}

/* ------------------------------------------------------------ settings */

function openSettings() {
  const s = state.settings;
  $('#set-apikey').value = s.apiKey;
  $('#set-units').value = s.units;
  $('#set-voice').checked = s.voice;
  $('#set-listen').checked = s.listen;
  $('#set-sensitivity').value = s.sensitivity;
  $('#settings-sheet').classList.remove('hidden');
}

function saveSettings() {
  state.settings = {
    apiKey: $('#set-apikey').value.trim(),
    units: $('#set-units').value,
    voice: $('#set-voice').checked,
    listen: $('#set-listen').checked,
    sensitivity: $('#set-sensitivity').value,
  };
  store.saveSettings(state.settings);
  voice = new Voice(state.settings);
  $('#settings-sheet').classList.add('hidden');
  toast('Settings saved');
}

/* ---------------------------------------------------------------- boot */

function boot() {
  $('#btn-start').onclick = () => startRound(false);
  $('#btn-demo').onclick = () => startRound(true);
  $('#btn-settings').onclick = openSettings;
  $('#btn-settings-2').onclick = openSettings;
  $('#btn-stats').onclick = showStats;
  $('#settings-save').onclick = saveSettings;
  $('#settings-close').onclick = () => $('#settings-sheet').classList.add('hidden');
  $('#stats-close').onclick = () => $('#stats-sheet').classList.add('hidden');
  $('#btn-caddie').onclick = askCaddie;
  $('#btn-shot').onclick = markShotManually;
  $('#btn-end').onclick = endRound;
  $('#hole-prev').onclick = () => stepHole(-1);
  $('#hole-next').onclick = () => stepHole(1);
  $('#btn-view').onclick = () => {
    state.userToggledView = true;
    setView(state.view === 'map' ? 'hole' : 'map');
  };
  window.addEventListener('resize', drawHoleView);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
