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
import { CLUBS, CTX, club, parseClub, rollFor, Caddie } from './caddie.js';
import { courseList, courseBook, smartTips } from './analytics.js';
import { Voice } from './voice.js';
import { ShotListener } from './shotlistener.js';
import { CourseMap, getGoogleElevations } from './map3d.js';
import { HoleView } from './holeview.js';
import { Hole3D } from './hole3d.js';

const $ = (sel) => document.querySelector(sel);

// bump together with the sw.js cache version on every release
const APP_VERSION = 'v10';

/* ---------------------------------------------------------------- state */

const state = {
  settings: store.getSettings(),
  round: null,          // { id, courseName, startedAt, shots: [...] }
  course: null,         // { name, holes, features }
  hole: null,           // current hole model
  pendingShot: null,    // last shot waiting for its landing position
  lastShotAt: 0,
  view: 'map',          // 'map' | 'hole'
  dimmed: false,        // battery saver: black screen, still listening
  demo: false,
};

const gps = new GPS();
const caddie = new Caddie();
let voice = new Voice(state.settings);
let shotListener = null;
let courseMap = null;
let holeView = null;
let hole3d = null;
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
      key: course?.id || course?.name || 'unknown', // stable key for hole notes
      name: course?.name || 'Unknown course',
      holes: data.holes,
      features: data.features,
    };
    state.round = {
      id: `r${Date.now()}`,
      courseName: state.course.name,
      startedAt: Date.now(),
      demo,
      courseKey: state.course.key,
      pars: Object.fromEntries(data.holes.filter(h => h.par).map(h => [h.num, h.par])),
      shots: [],
    };

    $('#course-name').textContent = state.course.name;
    $('#status').textContent = '';

    // Show the instant 2D hole view right away; swap to the 3D map only
    // once its tiles are actually ready (it keeps loading in the background,
    // which on 4G can take a while — no reason to stare at a black screen).
    holeView = new HoleView($('#holecanvas'));
    hole3d = new Hole3D($('#hole3d'));
    if (!hole3d.supported()) hole3d = null; // no WebGL → 2D canvas carries it
    if (hole3d) {
      hole3d.onFollowChange = (following) =>
        $('#btn-recenter').classList.toggle('hidden', following || state.view !== 'hole');
    }
    setView('hole'); // the stylised hole is home — Google view only by choice
    mapReady.then((ok) => {
      if (!ok) return;
      // Google is up: re-render the stylised hole with real elevation data,
      // and quietly prep the satellite view for whenever it's toggled
      if (state.hole) {
        showStylisedHole(state.hole);
        courseMap.showHole(state.hole, activeGps.position);
      }
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
    $('#hole-tip').classList.add('hidden');
    return;
  }
  const len = hole.distM || dist(hole.tee, hole.greenCenter);
  $('#hole-label').textContent =
    `Hole ${hole.num}${hole.par ? ` · Par ${hole.par}` : ''} · ${fmtDist(len, state.settings.units)}`;

  const tip = store.getTip(state.course.key, hole.num);
  $('#hole-tip').textContent = tip ? `“${tip}”` : '';
  $('#hole-tip').classList.toggle('hidden', !tip);

  if (state.dimmed) {
    updateDimReadout(); // visuals rebuild on wake
  } else {
    courseMap?.showHole(hole, activeGps.position);
    showStylisedHole(hole);
    drawHoleView();
    updateGlance();
  }
  if (announce) {
    voice.speak(
      `Hole ${hole.num}. ` +
      (hole.par ? `Par ${hole.par}, ` : '') +
      `${speakableDist(len)}.` +
      (tip ? ` Your note: ${tip}` : '')
    );
  }
}

/* ------------------------------------------------------------ hole notes */

function openNote() {
  if (!state.hole) { toast('No hole selected'); return; }
  $('#note-title').textContent = `Hole ${state.hole.num} Note`;
  $('#note-text').value = store.getTip(state.course.key, state.hole.num);
  $('#note-sheet').classList.remove('hidden');
}

function saveNote() {
  if (!state.hole) return;
  store.saveTip(state.course.key, state.hole.num, $('#note-text').value);
  $('#note-sheet').classList.add('hidden');
  setHole(state.hole, { announce: false }); // refresh the tip line
  toast('Note saved — I’ll remind you on this tee');
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
  if (state.dimmed) {
    updateDimReadout();
    maybeAutoAdvance(pos);
    return; // skip all rendering while the screen is resting
  }
  courseMap?.updatePlayer(pos);
  hole3d?.updatePlayer(pos);
  drawHoleView();
  updateGlance();
  maybeAutoAdvance(pos);
}

/* --------------------------------------------------- battery saver */

/* Black screen (OLED pixels off), rendering paused; GPS, mic, and the
 * voice caddie keep working. Tap anywhere to wake. */
function enterDim() {
  state.dimmed = true;
  $('#dim-screen').classList.remove('hidden');
  // stop the expensive renderers, not just cover them
  hole3d?.setVisible(false);
  $('#map').classList.add('hidden');
  $('#hole3d').classList.add('hidden');
  $('#holecanvas').classList.add('hidden');
  updateDimReadout();
  voice.speak('Battery saver on. Screen off — I’m still listening.');
}

function exitDim() {
  if (!state.dimmed) return;
  state.dimmed = false;
  $('#dim-screen').classList.add('hidden');
  setView(state.view); // restores the right renderer
  if (state.hole) {   // the hole may have advanced while the screen rested
    courseMap?.showHole(state.hole, activeGps.position);
    showStylisedHole(state.hole);
  }
  updateGlance();
  if (activeGps.position) {
    courseMap?.updatePlayer(activeGps.position);
    hole3d?.updatePlayer(activeGps.position);
  }
}

function updateDimReadout() {
  const pos = activeGps.position;
  if (!pos || !state.hole) { $('#dim-dist').textContent = '—'; return; }
  const g = greenDistances(pos, state.hole);
  $('#dim-dist').textContent = distNum(g.middle, state.settings.units);
  const reco = caddie.recommend(g.middle, shotContext(pos, state.hole));
  $('#dim-club').textContent = club(reco.primary).label;
}

/** Rebuild the Three.js hole scene (elevation cached per hole on-device). */
function showStylisedHole(hole) {
  if (!hole3d || !hole || !state.course) return;
  hole3d.show(hole, state.course.features,
    (latlngs, tag) => getGoogleElevations(latlngs, `${state.course.key}/${hole.num}/${tag || ''}`),
    { trees: state.settings.trees !== false })
    .then(() => {
      if (activeGps.position) hole3d?.updatePlayer(activeGps.position);
      updateGlance(); // scene is ready now — draw the landing preview
    })
    .catch(e => console.warn('hole3d failed', e));
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

  const ctx = shotContext(pos, state.hole);
  const reco = caddie.recommend(g.middle, ctx);
  const c = club(reco.primary);
  const learnedTag = caddie.learned(reco.primary) >= 2 ? '' : ' (default)';
  $('#club-reco').textContent =
    `${c.label}${reco.note ? ` — ${reco.note}` : ''}${learnedTag}`;

  // landing ring + roll-out preview on the 3D hole (throttled internally)
  if (hole3d && reco.primary !== 'PT') {
    const carryM = caddie.carry(reco.primary, ctx);
    hole3d.setShotPreview({
      carryM,
      spreadM: Math.max(9, caddie.spread(reco.primary) ?? carryM * 0.09),
      rollM: rollFor(reco.primary),
    });
  }
}

function drawHoleView() {
  if (state.view === 'hole' && !hole3d && holeView && state.hole && state.course) {
    holeView.render(state.hole, state.course.features, activeGps.position);
  }
}

function setView(v) {
  state.view = v;
  const use3d = !!hole3d;
  $('#map').classList.toggle('hidden', v !== 'map');
  $('#hole3d').classList.toggle('hidden', v !== 'hole' || !use3d);
  $('#holecanvas').classList.toggle('hidden', v !== 'hole' || use3d);
  $('#btn-view').textContent = v === 'map' ? 'Hole View' : 'Satellite';
  hole3d?.setVisible(v === 'hole');
  if (v === 'hole') hole3d?.resize();
  $('#btn-recenter').classList.toggle('hidden',
    v !== 'hole' || !hole3d || hole3d.follow);
  drawHoleView();
}

/* --------------------------------------------------------------- shots */

async function onShotDetected() {
  await recordShotInteractive('I heard that one!');
}

async function markShotManually() {
  await recordShotInteractive(null);
}

const YES_RE = /\b(yes|yeah|yep|yup|correct|right|aye|confirm)\b/i;
const NO_RE = /\b(no|nope|nah|wrong|change)\b/i;

/** Where is this shot being played from? 'tee' | 'app' | 'sg' */
function shotContext(pos, hole) {
  if (!pos || !hole) return 'app';
  if (dist(pos, hole.tee) < 35) return 'tee';
  if (dist(pos, hole.greenCenter) < 45) return 'sg';
  return 'app';
}

async function recordShotInteractive(heardPhrase) {
  const pos = activeGps.position;
  if (!pos || !state.round) return;
  if (Date.now() - state.lastShotAt < 5000) return; // double-trigger guard
  state.lastShotAt = Date.now();

  shotListener?.setPaused(true);
  buzz();
  chime();

  // Club stats only learn from shots the player has explicitly confirmed —
  // a tap on the grid, or a spoken "yes" after the club is read back. A
  // misheard club still logs the shot but never pollutes the averages.
  let clubId = null;
  let confirmed = false;
  if (voice.canListen && state.settings.voice) {
    await voice.speak(`${heardPhrase ? heardPhrase + ' ' : ''}What club?`);
    const heard = await voice.listenOnce({ timeoutMs: 6000 });
    clubId = heard ? parseClub(heard) : null;
    if (clubId) {
      await voice.speak(`${club(clubId).label} — correct?`);
      const answer = await voice.listenOnce({ timeoutMs: 4000 });
      if (YES_RE.test(answer)) confirmed = true;
      else if (NO_RE.test(answer)) clubId = null; // re-pick on screen
      // silence: keep the club for the scorecard, but leave it unconfirmed
    } else if (heard) {
      await voice.speak("Didn't catch that — pick it on screen.");
    }
  }
  if (!clubId) {
    clubId = await pickClubOnScreen();
    confirmed = !!clubId; // a tap is an explicit confirmation
  }
  shotListener?.setPaused(false);
  if (!clubId) return; // dismissed — not a shot

  recordShot(clubId, pos, confirmed);
}

function recordShot(clubId, pos, confirmed) {
  // The previous shot's ball has been found: it landed where this one is hit from.
  finalizePendingShot(pos);

  const shot = {
    t: Date.now(),
    hole: state.hole?.num || null,
    club: clubId,
    confirmed: !!confirmed,
    ctx: shotContext(pos, state.hole),
    pos: { lat: pos.lat, lng: pos.lng },
    carryM: null,
  };
  state.round.shots.push(shot);
  state.pendingShot = shot;
  store.saveRound(state.round);

  const c = club(clubId);
  toast(`${c.label} logged${confirmed ? '' : ' (unconfirmed)'}${shot.hole ? ` on hole ${shot.hole}` : ''}`);
  voice.speak(`${c.label}. Got it.`);
  renderShotCount();
}

function finalizePendingShot(landingPos) {
  const p = state.pendingShot;
  if (!p || !landingPos) return;
  const carry = dist(p.pos, landingPos);
  p.carryM = carry;
  state.pendingShot = null;
  // Only player-confirmed clubs teach the caddie; unconfirmed shots keep
  // their carry on the scorecard but never touch the averages.
  const counted = p.confirmed && caddie.recordCarry(p.club, carry, p.ctx || 'app');
  store.saveRound(state.round);
  if (counted) {
    toast(`${club(p.club).label}: ${fmtDist(carry, state.settings.units)} — noted`, 3000);
  }
}

function renderShotCount() {
  $('#shot-count').textContent = `${state.round.shots.length} shots`;
}

function pickClubOnScreen() {
  exitDim(); // can't tap a club on a black screen
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
  const reco = caddie.recommend(g.middle, shotContext(pos, state.hole));
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
    // terrain read from the 3D preview: kicks and funnels at the pitch point
    const pred = hole3d?.lastPrediction;
    if (pred?.hasSlope) {
      if (pred.endRegion === 'water') {
        msg += ` Careful — the slope feeds${pred.kick !== 'none' ? ` ${pred.kick}` : ''} toward the water.`;
      } else if (pred.endRegion === 'bunker') {
        msg += ` Watch it — the ground kicks${pred.kick !== 'none' ? ` ${pred.kick}` : ''} into the sand.`;
      } else if (pred.endRegion === 'green') {
        msg += ` The land should gather it onto the green.`;
      } else if (pred.kick !== 'none') {
        msg += ` Expect a kick to the ${pred.kick} on landing.`;
      }
    }
  }
  shotListener?.setPaused(true);
  await voice.speak(msg);
  shotListener?.setPaused(false);
  toast(msg, 6000);
}

/* --------------------------------------------------------- end / stats */

async function endRound() {
  exitDim();
  finalizePendingShot(activeGps.position);
  activeGps.stop();
  hole3d?.setVisible(false);
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

/* ------------------------------------------------------------ insights */

const esc = (s) => String(s).replace(/[&<>"]/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function showStats() {
  renderInsightTab('clubs');
  $('#stats-sheet').classList.remove('hidden');
}

function renderInsightTab(tab) {
  for (const b of document.querySelectorAll('#insight-tabs button')) {
    b.classList.toggle('on', b.dataset.tab === tab);
  }
  const el = $('#stats-body');
  if (tab === 'clubs') el.innerHTML = renderClubs();
  else if (tab === 'course') el.innerHTML = renderCourseBook();
  else el.innerHTML = renderTips();
}

function renderClubs() {
  const rows = caddie.summary();
  if (!rows.length) return `<p class="empty">No measured shots yet — play a round and confirm your clubs.</p>`;
  return rows.map(r => {
    const splits = Object.entries(CTX)
      .filter(([k]) => r.ctx[k])
      .map(([k, name]) => `${name} ${r.ctx[k].avgYd}`)
      .join(' · ');
    const spread = r.spreadYd !== null ? ` · ±${r.spreadYd}` : '';
    return `<div class="icard">
      <div class="icard-top"><span class="icard-title">${esc(r.label)}</span>
        <span class="icard-big">${r.avgYd}<small> yd</small></span></div>
      <div class="icard-sub">${splits || 'Building picture…'}${spread} · best ${r.bestYd} · ${r.count} shots</div>
    </div>`;
  }).join('');
}

function renderCourseBook() {
  const rounds = store.getRounds();
  const courses = courseList(rounds);
  if (!courses.length) return `<p class="empty">No rounds saved yet.</p>`;
  const name = state.insightCourse && courses.some(c => c.name === state.insightCourse)
    ? state.insightCourse : courses[0].name;
  state.insightCourse = name;

  const select = courses.length > 1
    ? `<select id="course-select">${courses.map(c =>
        `<option ${c.name === name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
    : `<div class="icard-sub" style="text-align:center">${esc(name)}</div>`;

  const courseKey = rounds.find(r => r.courseName === name)?.courseKey;
  const book = courseBook(rounds, name, (holeNum) => store.getTip(courseKey || name, holeNum));
  if (!book.length) return `${select}<p class="empty">No hole-by-hole data for this course yet.</p>`;

  return select + book.map(h => {
    const par = h.par ? ` · Par ${h.par}` : '';
    const vsPar = h.par ? ` (${h.avgShots - h.par >= 0 ? '+' : ''}${(h.avgShots - h.par).toFixed(1)})` : '';
    const tee = h.teeClub
      ? `Off the tee: ${esc(club(h.teeClub).label)} ×${h.teeCount}${h.teeAvgYd ? ` — avg ${h.teeAvgYd} yd` : ''}`
      : 'Off the tee: no confirmed data yet';
    return `<div class="icard">
      <div class="icard-top"><span class="icard-title">Hole ${h.num}${par}</span>
        <span class="icard-big">${h.avgShots.toFixed(1)}<small>${vsPar}</small></span></div>
      <div class="icard-sub">${tee} · played ${h.plays}× · best ${h.bestShots}</div>
      ${h.tip ? `<div class="icard-tip">“${esc(h.tip)}”</div>` : ''}
    </div>`;
  }).join('');
}

function renderTips() {
  const tips = smartTips(caddie, store.getRounds());
  if (!tips.length) return `<p class="empty">Tips appear once a few rounds of confirmed shots are in the book.</p>`;
  return tips.map(t => `<div class="icard icard-tipcard">${esc(t)}</div>`).join('');
}

/* ------------------------------------------------------------ settings */

function openSettings() {
  const s = state.settings;
  $('#set-apikey').value = s.apiKey;
  $('#set-units').value = s.units;
  $('#set-voice').checked = s.voice;
  $('#set-listen').checked = s.listen;
  $('#set-trees').checked = s.trees !== false;
  $('#set-sensitivity').value = s.sensitivity;
  $('#settings-sheet').classList.remove('hidden');
}

function saveSettings() {
  state.settings = {
    apiKey: $('#set-apikey').value.trim(),
    units: $('#set-units').value,
    voice: $('#set-voice').checked,
    listen: $('#set-listen').checked,
    trees: $('#set-trees').checked,
    sensitivity: $('#set-sensitivity').value,
  };
  store.saveSettings(state.settings);
  voice = new Voice(state.settings);
  $('#settings-sheet').classList.add('hidden');
  if (state.hole) showStylisedHole(state.hole); // apply tree toggle live
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
  for (const b of document.querySelectorAll('#insight-tabs button')) {
    b.onclick = () => renderInsightTab(b.dataset.tab);
  }
  $('#stats-body').addEventListener('change', (e) => {
    if (e.target.id === 'course-select') {
      state.insightCourse = e.target.value;
      renderInsightTab('course');
    }
  });
  $('#btn-caddie').onclick = askCaddie;
  $('#btn-shot').onclick = markShotManually;
  $('#btn-end').onclick = endRound;
  $('#hole-prev').onclick = () => stepHole(-1);
  $('#hole-next').onclick = () => stepHole(1);
  $('#btn-recenter').onclick = () => hole3d?.recenter();
  $('#btn-dim').onclick = enterDim;
  $('#dim-screen').onclick = exitDim;
  $('#btn-note').onclick = openNote;
  $('#note-save').onclick = saveNote;
  $('#note-close').onclick = () => $('#note-sheet').classList.add('hidden');
  $('#btn-view').onclick = () => setView(state.view === 'map' ? 'hole' : 'map');
  window.addEventListener('resize', () => { drawHoleView(); hole3d?.resize(); });

  $('#app-version').textContent = APP_VERSION;

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'activated') {
            // new version fully cached — safe to swap in when not playing
            if (state.round) toast('Update downloaded — applies after your round', 5000);
            else location.reload();
          }
        });
      });
    }).catch(() => {});
  }
}

boot();
