/* map3d.js — stylised 3D course view on Google Maps.
 *
 * Preferred: photorealistic 3D (gmp-map-3d, Maps JS "maps3d" library) with
 * the hole line, tee and green drawn on top; the camera flies in behind the
 * tee looking down the hole like a TV flyover.
 * Fallback (3D tiles unavailable in the area / older browser): classic
 * satellite map tilted to 45° with the same overlays.
 * No API key at all → the canvas hole view (holeview.js) carries the app.
 */

let loadPromise = null;

export function loadGoogleMaps(apiKey) {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    // Official dynamic-import bootstrap
    ((g) => {
      var h, a, k, p = 'The Google Maps JavaScript API', c = 'google', l = 'importLibrary',
        q = '__ib__', m = document, b = window;
      b = b[c] || (b[c] = {});
      var d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(),
        u = () => h || (h = new Promise(async (f, n) => {
          await (a = m.createElement('script'));
          e.set('libraries', [...r] + '');
          for (k in g) e.set(k.replace(/[A-Z]/g, t => '_' + t[0].toLowerCase()), g[k]);
          e.set('callback', c + '.maps.' + q);
          a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
          d[q] = f;
          a.onerror = () => h = n(Error(p + ' could not load.'));
          a.nonce = m.querySelector('script[nonce]')?.nonce || '';
          m.head.append(a);
        }));
      d[l] ? console.warn(p + ' only loads once.') : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n));
    })({ key: apiKey, v: 'alpha' });
    // Resolve on the core library so a missing maps3d doesn't poison the
    // satellite fallback — callers import maps3d/maps themselves.
    google.maps.importLibrary('core').then(resolve, reject);
  });
  return loadPromise;
}

/* Google Elevation data gives the stylised 3D holes their real slopes.
 * Results are cached per hole on-device — one API hit per hole, ever. */
const ELEV_CACHE_KEY = 'gb.elev.v1';

let elevationError = null;
/** Why the last elevation fetch failed (null = it worked / not tried). */
export function lastElevationError() { return elevationError; }

export async function getGoogleElevations(latlngs, cacheKey) {
  try {
    const all = JSON.parse(localStorage.getItem(ELEV_CACHE_KEY)) || {};
    if (cacheKey && all[cacheKey]?.length === latlngs.length) return all[cacheKey];
  } catch { /* corrupt cache */ }
  if (!window.google?.maps?.importLibrary) {
    elevationError = 'Google Maps not loaded — add an API key in Settings';
    return null;
  }
  try {
    const { ElevationService } = await google.maps.importLibrary('elevation');
    const { results } = await new ElevationService()
      .getElevationForLocations({ locations: latlngs });
    if (!results || results.length !== latlngs.length) {
      elevationError = 'Elevation API returned no data';
      return null;
    }
    elevationError = null;
    const data = results.map(r => Math.round(r.elevation * 10) / 10);
    if (cacheKey) {
      try {
        const all = JSON.parse(localStorage.getItem(ELEV_CACHE_KEY)) || {};
        const keys = Object.keys(all);
        for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete all[k];
        all[cacheKey] = data;
        localStorage.setItem(ELEV_CACHE_KEY, JSON.stringify(all));
      } catch { /* quota — skip caching */ }
    }
    return data;
  } catch (e) {
    console.warn('Elevation API unavailable', e);
    elevationError = String(e?.message || e).slice(0, 120);
    return null;
  }
}

export class CourseMap {
  constructor(container) {
    this.container = container;
    this.mode = 'none'; // 'photo3d' | 'sat' | 'none'
    this.el = null;
    this.map2d = null;
    this.overlays = [];
  }

  async init(apiKey) {
    if (!apiKey) return false;
    try {
      await loadGoogleMaps(apiKey);
      await google.maps.importLibrary('maps3d');
      this.el = document.createElement('gmp-map-3d');
      this.el.setAttribute('mode', 'satellite');
      this.el.style.cssText = 'width:100%;height:100%;display:block';
      this.container.replaceChildren(this.el);
      this.mode = 'photo3d';
      return true;
    } catch (e) {
      console.warn('3D map unavailable, falling back to tilted satellite', e);
      return this._initSat(apiKey);
    }
  }

  async _initSat(apiKey) {
    try {
      await loadGoogleMaps(apiKey);
      const { Map } = await google.maps.importLibrary('maps');
      const div = document.createElement('div');
      div.style.cssText = 'width:100%;height:100%';
      this.container.replaceChildren(div);
      this.map2d = new Map(div, {
        mapTypeId: 'satellite',
        zoom: 17,
        center: { lat: 0, lng: 0 },
        tilt: 45,
        disableDefaultUI: true,
        gestureHandling: 'greedy',
      });
      this.mode = 'sat';
      return true;
    } catch (e) {
      console.warn('Google Maps failed to load', e);
      this.mode = 'none';
      return false;
    }
  }

  _clearOverlays() {
    if (this.mode === 'photo3d') {
      for (const o of this.overlays) o.remove();
    } else if (this.mode === 'sat') {
      for (const o of this.overlays) o.setMap(null);
    }
    this.overlays = [];
  }

  /** Fly the camera in behind the tee, looking down the hole at the green. */
  async showHole(hole, playerPos) {
    if (this.mode === 'none') return;
    this._clearOverlays();
    const { bearing, dist, destination } = await import('./geo.js');
    const holeBearing = bearing(hole.tee, hole.greenCenter);
    const lengthM = dist(hole.tee, hole.greenCenter);

    if (this.mode === 'photo3d') {
      await customElements.whenDefined('gmp-map-3d');

      const line = document.createElement('gmp-polyline-3d');
      line.setAttribute('altitude-mode', 'clamp-to-ground');
      line.setAttribute('stroke-color', 'rgba(255, 213, 74, 0.95)');
      line.setAttribute('stroke-width', '7');
      line.coordinates = hole.line.map(p => ({ lat: p.lat, lng: p.lng }));
      this.el.append(line);
      this.overlays.push(line);

      for (const [pos, color] of [[hole.tee, '#3ddc84'], [hole.greenCenter, '#ffffff']]) {
        const m = document.createElement('gmp-marker-3d');
        m.setAttribute('altitude-mode', 'clamp-to-ground');
        m.position = { lat: pos.lat, lng: pos.lng };
        this.el.append(m);
        this.overlays.push(m);
        void color; // marker glyph colouring varies by API version; default pin is fine
      }

      const camBase = playerPos && dist(playerPos, hole.greenCenter) < lengthM
        ? playerPos : hole.tee;
      const behind = destination(camBase, 60, (holeBearing + 180) % 360);
      const cam = {
        center: { lat: behind.lat, lng: behind.lng, altitude: 0 },
        tilt: 66,
        range: Math.max(280, lengthM * 1.35),
        heading: holeBearing,
      };
      try {
        this.el.flyCameraTo({ endCamera: cam, durationMillis: 2200 });
      } catch {
        Object.assign(this.el, cam);
      }
    } else if (this.mode === 'sat') {
      const mid = destination(hole.tee, lengthM / 2, holeBearing);
      this.map2d.moveCamera({
        center: mid, zoom: 17, tilt: 45, heading: holeBearing,
      });
      const line = new google.maps.Polyline({
        path: hole.line,
        strokeColor: '#ffd54a',
        strokeWeight: 5,
        map: this.map2d,
      });
      this.overlays.push(line);
    }
  }

  /**
   * Resolves once the photorealistic view has finished streaming tiles for
   * the current camera (or after timeoutMs — a partial map still beats a
   * spinner). Immediate for the non-3D modes.
   */
  whenSteady(timeoutMs = 12000) {
    if (this.mode !== 'photo3d' || !this.el) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.el.removeEventListener('gmp-steadychange', onSteady);
        resolve();
      };
      const onSteady = (e) => { if (e.isSteady) finish(); };
      this.el.addEventListener('gmp-steadychange', onSteady);
      setTimeout(finish, timeoutMs);
    });
  }

  /** Keep a marker on the player as they walk. */
  async updatePlayer(pos) {
    if (this.mode === 'sat') {
      if (!this.playerDot) {
        this.playerDot = new google.maps.Marker({
          map: this.map2d,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8, fillColor: '#4da3ff', fillOpacity: 1,
            strokeColor: '#fff', strokeWeight: 2,
          },
        });
      }
      this.playerDot.setPosition(pos);
    } else if (this.mode === 'photo3d' && this.el) {
      if (!this.playerDot) {
        this.playerDot = document.createElement('gmp-marker-3d');
        this.playerDot.setAttribute('altitude-mode', 'clamp-to-ground');
        this.el.append(this.playerDot);
      }
      this.playerDot.position = { lat: pos.lat, lng: pos.lng };
    }
  }
}
