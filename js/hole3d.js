/* hole3d.js — the stylised 3D hole, rebuilt for polish.
 *
 * - Terrain: smooth-shaded mesh displaced by real Google Elevation data,
 *   painted by a high-resolution canvas texture (soft anti-aliased edges,
 *   green fringes, mowing stripes, edge fade) instead of hard facets.
 * - Slope flow: animated particles drift downhill like the slope lines in
 *   golf video games — brighter and faster where the ground tilts more.
 * - Shot preview: a landing ring at the recommended club's carry (sized by
 *   your ± consistency) and a simulated roll-out line from the pitch point
 *   that follows the terrain, colour-coded by where the ball likely ends.
 * - Camera: orbits YOUR BALL with damped, game-feel controls (drag to
 *   orbit, pinch/wheel to zoom), not the middle of the hole.
 *
 * Local frame: green centre at origin, hole playing down -Z (tee at +Z).
 */

import * as THREE from './vendor/three.module.js';
import { dist, toRad } from './geo.js';

const COL = {
  bg: 0x0d1d15,
  rough: '#20502f',
  roughStripe: 'rgba(0,0,0,0.05)',
  semiRough: '#2a6039',
  woodsFloor: '#173d22',
  trunk: 0x5c4632,
  canopy: 0x2c6b3c,
  fairway: '#3f8f52',
  fairwayStripe: 'rgba(255,255,255,0.045)',
  green: '#5fc474',
  fringe: '#4aa95f',
  tee: '#3f8f52',
  bunker: '#e6d3a3',
  bunkerEdge: '#c9b587',
  water: '#3f78b8',
  waterDeep: '#2f5f96',
  pole: 0xf2ead8,
  flag: 0xc25b4e,
  line: 0xc8a96a,
  ball: 0xf6f2e7,
  flow: new THREE.Color(0xfff3d0),
  rollGood: 0x8df5a2,
  rollNeutral: 0xffd97a,
  rollBad: 0xff8a7a,
};

const CELL_M = 3;         // mesh resolution — smooth shading hides the grid
const MAX_CELLS = 220;
const MARGIN_M = 50;
const FLOW_N = 1100;      // slope particles

export class Hole3D {
  constructor(container) {
    this.container = container;
    this.renderer = null;
    this.running = false;
    this.playerLocal = null;
    this.lastPrediction = null;
    this._previewKey = '';
    this.follow = true;              // camera tracks the ball until you pan
    this.onFollowChange = null;      // app hook for the recenter button
    this._ray = new THREE.Raycaster();
    this._panVel = new THREE.Vector3();
  }

  supported() {
    if (this.renderer) return true;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.container.appendChild(this.renderer.domElement);
      this.renderer.domElement.style.cssText =
        'width:100%;height:100%;display:block;touch-action:none';
      this._bindControls();
      return true;
    } catch (e) {
      console.warn('WebGL unavailable', e);
      this.renderer = null;
      return false;
    }
  }

  /* ------------------------------------------------- projection frame */

  _frame(hole) {
    const o = hole.greenCenter;
    const a = bearingRad(hole.tee, o);
    const cosLat = Math.cos(toRad(o.lat));
    const M = 111320;
    return {
      toLocal: (p) => {
        const e = (p.lng - o.lng) * M * cosLat;
        const n = (p.lat - o.lat) * M;
        return { x: e * Math.cos(a) - n * Math.sin(a), z: -(e * Math.sin(a) + n * Math.cos(a)) };
      },
      toWorld: (x, z) => {
        const s = -z;
        const e = x * Math.cos(a) + s * Math.sin(a);
        const n = -x * Math.sin(a) + s * Math.cos(a);
        return { lat: o.lat + n / M, lng: o.lng + e / (M * cosLat) };
      },
    };
  }

  /* --------------------------------------------------------- build */

  async show(hole, features, getElevations, opts = {}) {
    if (!this.renderer) return;
    this.showTrees = opts.trees !== false;
    this.hole = hole;
    this.frame = this._frame(hole);
    this._previewKey = '';
    const { toLocal, toWorld } = this.frame;

    const linePts = hole.line.map(toLocal);
    this.linePts = linePts;

    // region polygons in local coords (near this hole only)
    const near = (poly) => poly.some(p =>
      dist(p, hole.greenCenter) < 900 || dist(p, hole.tee) < 900);
    const local = (polys) => polys.filter(near).map(poly => poly.map(toLocal));
    this.regions = {
      water: local(features.water),
      bunkers: local(features.bunkers),
      tees: local(features.tees),
      greens: hole.green ? local([hole.green]) : [],
      fairways: local(features.fairways),
      roughs: local(features.roughs || []),
      woods: local(features.woods || []),
      trees: (features.trees || [])
        .filter(p => dist(p, hole.greenCenter) < 900 || dist(p, hole.tee) < 900)
        .map(toLocal),
    };

    // ---- terrain extent: the hole corridor, then grown to fully cover any
    // fairway/green/bunker the hole plays over (St Andrews-style shared
    // fairways are far wider than the centreline strip), capped for sanity
    let minX = -MARGIN_M, maxX = MARGIN_M, minZ = -MARGIN_M - 20, maxZ = MARGIN_M;
    for (const p of linePts) {
      minX = Math.min(minX, p.x - MARGIN_M); maxX = Math.max(maxX, p.x + MARGIN_M);
      minZ = Math.min(minZ, p.z - MARGIN_M); maxZ = Math.max(maxZ, p.z + MARGIN_M);
    }
    const lineNear = (p, r) => {
      for (let i = 0; i < linePts.length - 1; i++) {
        if (segDist(p.x, p.z, linePts[i], linePts[i + 1]) < r) return true;
      }
      return Math.hypot(p.x, p.z) < r;
    };
    for (const key of ['fairways', 'greens', 'bunkers', 'tees']) {
      for (const poly of this.regions[key]) {
        if (!poly.some(p => lineNear(p, 80))) continue; // not this hole's feature
        for (const p of poly) {
          minX = Math.min(minX, p.x - 25); maxX = Math.max(maxX, p.x + 25);
          minZ = Math.min(minZ, p.z - 25); maxZ = Math.max(maxZ, p.z + 25);
        }
      }
    }
    // caps relative to the hole line so one giant shared polygon can't explode the scene
    let lMinX = Infinity, lMaxX = -Infinity, lMinZ = Infinity, lMaxZ = -Infinity;
    for (const p of linePts) {
      lMinX = Math.min(lMinX, p.x); lMaxX = Math.max(lMaxX, p.x);
      lMinZ = Math.min(lMinZ, p.z); lMaxZ = Math.max(lMaxZ, p.z);
    }
    minX = Math.max(minX, lMinX - 220); maxX = Math.min(maxX, lMaxX + 220);
    minZ = Math.max(minZ, lMinZ - 160); maxZ = Math.min(maxZ, lMaxZ + 120);

    const w = maxX - minX, d = maxZ - minZ;
    this.bounds = { minX, minZ, w, d };

    const heights = await this._heights(getElevations, toWorld, minX, minZ, w, d);
    this.heights = heights;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COL.bg);
    scene.fog = new THREE.Fog(COL.bg, d * 1.2, d * 2.8);
    this.scene = scene;

    scene.add(new THREE.HemisphereLight(0xe8f5e5, 0x0e2418, 1.1));
    const sun = new THREE.DirectionalLight(0xfff0d2, 1.2);
    sun.position.set(-w * 0.8, Math.max(90, d * 0.35), d * 0.35);
    scene.add(sun);

    scene.add(this._terrain());
    this._addPin();
    this._addHoleLine();
    if (this.showTrees !== false) this._addTrees();
    this._initFlow();
    this._ball = this._addBall();
    this._previewGroup = new THREE.Group();
    scene.add(this._previewGroup);

    // ---- camera: damped orbit around the player's ball
    this.camera = new THREE.PerspectiveCamera(48, 1, 1, 6000);
    const tee = toLocal(hole.tee);
    const anchor = this.playerLocal || tee;
    const span = Math.hypot(anchor.x, anchor.z); // ball → green
    const fx = anchor.x * 0.68, fz = anchor.z * 0.68;
    const anchorY = this._h(fx, fz);
    this.orbit = {
      target: new THREE.Vector3(fx, anchorY, fz),
      targetGoal: new THREE.Vector3(fx, anchorY, fz),
      radius: clamp(span * 1.05, 130, 620), radiusGoal: clamp(span * 1.05, 130, 620),
      azimuth: Math.atan2(anchor.x, anchor.z), azimuthGoal: Math.atan2(anchor.x, anchor.z),
      elevation: 0.55, elevationGoal: 0.55,
    };
    this._setFollow(true);
    this._panVel.set(0, 0, 0);
    this._applyOrbit();

    if (this.playerLocal) this.updatePlayerLocal(this.playerLocal);
    this.resize();
    this.setVisible(this.visible !== false);
  }

  /* ------------------------------------------------------ elevation */

  async _heights(getElevations, toWorld, minX, minZ, w, d) {
    const GX = 15, GZ = 31; // 496 samples — under the 512/request cap
    const grid = { GX, GZ, data: null };
    if (!getElevations) return grid;
    try {
      const latlngs = [];
      for (let j = 0; j <= GZ; j++) {
        for (let i = 0; i <= GX; i++) {
          latlngs.push(toWorld(minX + (i / GX) * w, minZ + (j / GZ) * d));
        }
      }
      const boundsTag = `${Math.round(minX)},${Math.round(minZ)},${Math.round(w)},${Math.round(d)}`;
      const elev = await getElevations(latlngs, boundsTag);
      if (elev && elev.length === latlngs.length) {
        const min = Math.min(...elev);
        grid.data = elev.map(e => e - min);
      }
    } catch (e) { console.warn('elevation unavailable', e); }
    return grid;
  }

  _h(x, z) {
    const g = this.heights;
    if (!g?.data) return 0;
    const { minX, minZ, w, d } = this.bounds;
    const fx = clamp(((x - minX) / w) * g.GX, 0, g.GX - 1e-6);
    const fz = clamp(((z - minZ) / d) * g.GZ, 0, g.GZ - 1e-6);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const at = (ii, jj) => g.data[jj * (g.GX + 1) + ii];
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) +
           (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
  }

  /** Downhill unit-ish gradient (dh per meter) at local x,z. */
  _grad(x, z) {
    const e = 3;
    return {
      x: (this._h(x + e, z) - this._h(x - e, z)) / (2 * e),
      z: (this._h(x, z + e) - this._h(x, z - e)) / (2 * e),
    };
  }

  /* ------------------------------------------------- painted terrain */

  _terrain() {
    const { minX, minZ, w, d } = this.bounds;
    const nx = Math.min(MAX_CELLS, Math.max(30, Math.round(w / CELL_M)));
    const nz = Math.min(MAX_CELLS, Math.max(30, Math.round(d / CELL_M)));

    const geo = new THREE.BufferGeometry();
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = minX + (i / nx) * w, z = minZ + (j / nz) * d;
        pos.push(x, this._h(x, z), z);
        uv.push(i / nx, 1 - j / nz);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const tex = new THREE.CanvasTexture(this._paint());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, transparent: true }));
  }

  /** Paint the course onto a canvas — this is where the "pretty" lives. */
  _paint() {
    const { minX, minZ, w, d } = this.bounds;
    const H = 2048;
    const W = Math.min(1280, Math.max(384, Math.round(H * (w / d))));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const X = (x) => ((x - minX) / w) * W;
    const Y = (z) => ((z - minZ) / d) * H;
    const path = (poly) => {
      g.beginPath();
      poly.forEach((p, i) => i ? g.lineTo(X(p.x), Y(p.z)) : g.moveTo(X(p.x), Y(p.z)));
      g.closePath();
    };
    const soft = (color, blurPx) => {
      g.shadowColor = color; g.shadowBlur = blurPx;
      g.fillStyle = color; g.fill();
      g.shadowBlur = 0;
    };
    const stripes = (color, phase) => {
      g.fillStyle = color;
      const band = H / Math.max(10, Math.round(d / 14)); // ~14 m mow bands
      for (let y = phase * band; y < H; y += band * 2) g.fillRect(0, y, W, band);
    };

    // rough + its mowing
    g.fillStyle = COL.rough;
    g.fillRect(0, 0, W, H);
    stripes(COL.roughStripe, 0);

    // mapped semi-rough / gorse patches, then woodland floor under the trees
    for (const rg of this.regions.roughs) { path(rg); soft(COL.semiRough, 12); }
    for (const wd of this.regions.woods) { path(wd); soft(COL.woodsFloor, 12); }

    // fairways: soft edge, brighter mow stripes clipped inside
    for (const f of this.regions.fairways) {
      path(f); soft(COL.fairway, 14);
      g.save(); path(f); g.clip(); stripes(COL.fairwayStripe, 0.5); g.restore();
    }
    for (const t of this.regions.tees) { path(t); soft(COL.tee, 8); }

    // water with a depth gradient
    for (const wtr of this.regions.water) {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, COL.water); grad.addColorStop(1, COL.waterDeep);
      path(wtr);
      g.shadowColor = COL.waterDeep; g.shadowBlur = 10;
      g.fillStyle = grad; g.fill();
      g.shadowBlur = 0;
    }

    // bunkers: sand with a soft lip
    for (const b of this.regions.bunkers) {
      path(b); soft(COL.bunker, 8);
      path(b); g.strokeStyle = COL.bunkerEdge; g.lineWidth = 3; g.stroke();
    }

    // greens: fringe ring then bright putting surface with a subtle sheen
    for (const gr of this.regions.greens) {
      path(gr);
      g.strokeStyle = COL.fringe; g.lineWidth = 16; g.stroke();
      path(gr); soft(COL.green, 10);
      let cx = 0, cz = 0;
      for (const p of gr) { cx += p.x; cz += p.z; }
      cx = X(cx / gr.length); cz = Y(cz / gr.length);
      const sheen = g.createRadialGradient(cx, cz, 4, cx, cz, 90);
      sheen.addColorStop(0, 'rgba(255,255,255,0.12)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      g.save(); path(gr); g.clip();
      g.fillStyle = sheen; g.fillRect(0, 0, W, H);
      g.restore();
    }

    // fade the rectangle edges away so the hole floats like a diorama
    g.globalCompositeOperation = 'destination-out';
    const feather = (x0, y0, x1, y1) => {
      const lg = g.createLinearGradient(x0, y0, x1, y1);
      lg.addColorStop(0, 'rgba(0,0,0,1)'); lg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = lg; g.fillRect(0, 0, W, H);
    };
    const fx = W * 0.04, fy = H * 0.03;
    feather(0, 0, fx, 0); feather(W, 0, W - fx, 0);
    feather(0, 0, 0, fy); feather(0, H, 0, H - fy);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  /* ----------------------------------------------- pin, line, ball */

  _addPin() {
    const y = this._h(0, 0);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 9, 8),
      new THREE.MeshLambertMaterial({ color: COL.pole }));
    pole.position.set(0, y + 4.5, 0);
    this.scene.add(pole);

    this.flag = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 2.1),
      new THREE.MeshLambertMaterial({ color: COL.flag, side: THREE.DoubleSide }));
    this.flag.position.set(1.7, y + 7.9, 0);
    this.scene.add(this.flag);
  }

  _addHoleLine() {
    const v = this.linePts.map(p => new THREE.Vector3(p.x, this._h(p.x, p.z) + 0.5, p.z));
    const curve = new THREE.CatmullRomCurve3(v);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(90));
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
      color: COL.line, dashSize: 5, gapSize: 6, transparent: true, opacity: 0.45,
    }));
    line.computeLineDistances();
    this.scene.add(line);
  }

  _addBall() {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1.3, 20, 16),
      new THREE.MeshLambertMaterial({ color: COL.ball }));
    ball.position.y = 1.3;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.2, 2.8, 40),
      new THREE.MeshBasicMaterial({ color: COL.ball, transparent: true, opacity: 0.45 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.25;
    g.add(ball, ring);
    g.visible = false;
    this.scene.add(g);
    return g;
  }

  /* ------------------------------------------------- low-poly trees */

  _addTrees() {
    const b = this.bounds;
    const inB = (x, z) =>
      x > b.minX + 4 && x < b.minX + b.w - 4 && z > b.minZ + 4 && z < b.minZ + b.d - 4;
    const spots = [];

    // individually mapped trees
    for (const p of this.regions.trees) {
      if (inB(p.x, p.z)) spots.push({ x: p.x, z: p.z });
    }
    // fill mapped woods with a loose scatter
    for (const poly of this.regions.woods) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, area = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], c = poly[(i + 1) % poly.length];
        area += a.x * c.z - c.x * a.z;
        x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x);
        z0 = Math.min(z0, a.z); z1 = Math.max(z1, a.z);
      }
      const n = clamp(Math.round(Math.abs(area / 2) / 140), 3, 90);
      for (let i = 0; i < n * 4 && spots.length < 240; i++) {
        const x = x0 + Math.random() * (x1 - x0);
        const z = z0 + Math.random() * (z1 - z0);
        if (inLocalPoly({ x, z }, poly) && inB(x, z)) spots.push({ x, z });
      }
    }
    if (!spots.length) return;

    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 4, 5);
    const canopyGeo = new THREE.IcosahedronGeometry(3, 0);
    const trunks = new THREE.InstancedMesh(
      trunkGeo, new THREE.MeshLambertMaterial({ color: COL.trunk }), spots.length);
    const canopies = new THREE.InstancedMesh(
      canopyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), spots.length);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const base = new THREE.Color(COL.canopy);
    for (let i = 0; i < spots.length; i++) {
      const { x, z } = spots[i];
      const y = this._h(x, z);
      const s = 0.7 + Math.random() * 0.9;
      q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, y + 2 * s, z), q, new THREE.Vector3(s, s, s));
      trunks.setMatrixAt(i, m);
      m.compose(
        new THREE.Vector3(x, y + (4 + 2.2) * s, z), q,
        new THREE.Vector3(s * (0.9 + Math.random() * 0.4), s * (1 + Math.random() * 0.5), s * (0.9 + Math.random() * 0.4)));
      canopies.setMatrixAt(i, m);
      col.copy(base).offsetHSL((Math.random() - 0.5) * 0.03, 0, (Math.random() - 0.5) * 0.06);
      canopies.setColorAt(i, col);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    this.scene.add(trunks, canopies);
  }

  /* -------------------------------------------- slope flow particles */

  _initFlow() {
    const N = FLOW_N;
    this.flowP = new Float32Array(N * 3);
    this.flowC = new Float32Array(N * 3);
    this.flow = Array.from({ length: N }, () => ({ x: 0, z: 0, life: Math.random() }));
    for (const p of this.flow) this._respawnFlow(p);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.flowP, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.flowC, 3));
    const mat = new THREE.PointsMaterial({
      size: 1.7, sizeAttenuation: true, map: dotSprite(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.flowPoints = new THREE.Points(geo, mat);
    this.flowPoints.frustumCulled = false;
    this.scene.add(this.flowPoints);
  }

  _respawnFlow(p) {
    const { minX, minZ, w, d } = this.bounds;
    // bias spawns to the playing corridor so the lines describe YOUR shot
    for (let tries = 0; tries < 8; tries++) {
      const x = minX + Math.random() * w;
      const z = minZ + Math.random() * d;
      if (this._nearCorridor(x, z, 55)) { p.x = x; p.z = z; break; }
      p.x = x; p.z = z;
    }
    p.life = 0;
    p.dur = 2.5 + Math.random() * 2.5;
  }

  _nearCorridor(x, z, r) {
    if (Math.hypot(x, z) < 45) return true; // around the green
    const pts = this.linePts;
    for (let i = 0; i < pts.length - 1; i++) {
      if (segDist(x, z, pts[i], pts[i + 1]) < r) return true;
    }
    return false;
  }

  _updateFlow(dt) {
    if (!this.flow) return;
    const hasSlope = !!this.heights?.data;
    for (let i = 0; i < this.flow.length; i++) {
      const p = this.flow[i];
      p.life += dt;
      const g = hasSlope ? this._grad(p.x, p.z) : { x: 0, z: 0 };
      const mag = Math.hypot(g.x, g.z);
      if (p.life > p.dur || mag < 0.008) {
        if (p.life > p.dur) this._respawnFlow(p);
        // invisible when flat
        this.flowC[i * 3] = this.flowC[i * 3 + 1] = this.flowC[i * 3 + 2] = 0;
        this.flowP[i * 3 + 1] = -999;
        if (mag < 0.008) p.life += dt * 2; // recycle flat spawns faster
        continue;
      }
      const speed = clamp(mag * 90, 2.5, 14); // m/s downhill drift
      p.x -= (g.x / mag) * speed * dt;
      p.z -= (g.z / mag) * speed * dt;
      const fade = Math.sin(Math.min(1, p.life / p.dur) * Math.PI);
      const a = fade * clamp(mag * 14, 0.12, 0.85);
      this.flowP[i * 3] = p.x;
      this.flowP[i * 3 + 1] = this._h(p.x, p.z) + 0.7;
      this.flowP[i * 3 + 2] = p.z;
      this.flowC[i * 3] = COL.flow.r * a;
      this.flowC[i * 3 + 1] = COL.flow.g * a;
      this.flowC[i * 3 + 2] = COL.flow.b * a;
    }
    this.flowPoints.geometry.attributes.position.needsUpdate = true;
    this.flowPoints.geometry.attributes.color.needsUpdate = true;
  }

  /* ------------------------------------------------- shot preview */

  /**
   * Landing ring + simulated roll-out for the recommended club.
   * Returns { kick:'left'|'right'|'none', endRegion, hasSlope } (also kept
   * as this.lastPrediction for the voice caddie).
   */
  setShotPreview({ carryM, spreadM, rollM }) {
    if (!this.scene || !this.playerLocal || !this.hole) return null;
    const ball = this.playerLocal;
    const key = `${Math.round(carryM / 3)}|${Math.round(ball.x / 4)}|${Math.round(ball.z / 4)}|${Math.round(rollM)}`;
    if (key === this._previewKey) return this.lastPrediction;
    this._previewKey = key;

    this._previewGroup.clear();

    // aim at the green from the ball; pitch point at carry distance
    const span = Math.hypot(ball.x, ball.z);
    if (span < 15) { this.lastPrediction = null; return null; } // on the green
    const dir = { x: -ball.x / span, z: -ball.z / span };
    const carry = Math.min(carryM, span + 30); // don't preview 80 yds past the pin
    const pitch = { x: ball.x + dir.x * carry, z: ball.z + dir.z * carry };
    const py = this._h(pitch.x, pitch.z);

    // landing ring sized by your consistency with the club
    const r = clamp(spreadM, 8, 40);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.86, r, 48),
      new THREE.MeshBasicMaterial({
        color: COL.line, transparent: true, opacity: 0.85,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pitch.x, py + 0.6, pitch.z);
    ring.renderOrder = 10; // transparent terrain must not paint over the preview
    this._previewRing = ring;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.86, 48),
      new THREE.MeshBasicMaterial({
        color: COL.line, transparent: true, opacity: 0.12,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(pitch.x, py + 0.5, pitch.z);
    disc.renderOrder = 9;
    this._previewGroup.add(ring, disc);

    // roll-out: friction + slope, curving where the ground kicks
    const path = this._simulateRoll(pitch, dir, rollM);
    const end = path[path.length - 1];
    const endRegion = this._classify(end.x, end.z);
    const lineColor = endRegion === 'green' ? COL.rollGood
      : (endRegion === 'bunker' || endRegion === 'water') ? COL.rollBad
      : COL.rollNeutral;

    if (path.length > 1) {
      const pts = path.map(p => new THREE.Vector3(p.x, this._h(p.x, p.z) + 0.6, p.z));
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: lineColor, transparent: true, opacity: 0.95, depthTest: false,
        }));
      line.renderOrder = 11;
      this._previewGroup.add(line);
    }
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 14, 10),
      new THREE.MeshBasicMaterial({ color: lineColor }));
    dot.position.set(end.x, this._h(end.x, end.z) + 1, end.z);
    dot.renderOrder = 11;
    this._previewGroup.add(dot);

    // which way did the slope take it?
    const right = { x: -dir.z, z: dir.x };
    const lateral = (end.x - pitch.x) * right.x + (end.z - pitch.z) * right.z;
    const kick = Math.abs(lateral) < 4 ? 'none' : (lateral > 0 ? 'right' : 'left');

    this.lastPrediction = { kick, endRegion, hasSlope: !!this.heights?.data };
    return this.lastPrediction;
  }

  _simulateRoll(start, dir, rollM) {
    const mu = 2.2, dt = 0.12;
    let v = { x: dir.x, z: dir.z };
    const v0 = Math.sqrt(2 * mu * Math.max(1, rollM));
    v.x *= v0; v.z *= v0;
    const path = [{ ...start }];
    let p = { ...start };
    let travelled = 0;
    for (let i = 0; i < 160; i++) {
      const g = this._grad(p.x, p.z);
      const speed = Math.hypot(v.x, v.z);
      if (speed < 0.4) break;
      v.x += (-9.8 * g.x - mu * (v.x / speed)) * dt;
      v.z += (-9.8 * g.z - mu * (v.z / speed)) * dt;
      p = { x: p.x + v.x * dt, z: p.z + v.z * dt };
      travelled += Math.hypot(v.x, v.z) * dt;
      path.push({ ...p });
      if (travelled > rollM * 3 + 45) break; // runaway slope guard
      if (this._classify(p.x, p.z) === 'water') break; // splash — stop there
    }
    return path;
  }

  _classify(x, z) {
    const pt = { x, z };
    const order = [
      ['water', this.regions.water], ['bunker', this.regions.bunkers],
      ['green', this.regions.greens], ['fairway', this.regions.fairways],
    ];
    for (const [name, polys] of order) {
      for (const poly of polys) if (inLocalPoly(pt, poly)) return name;
    }
    return 'rough';
  }

  /* ---------------------------------------------------- player */

  updatePlayer(pos) {
    if (!this.frame) { this.playerLocal = null; return; }
    this.updatePlayerLocal(this.frame.toLocal(pos));
  }

  updatePlayerLocal(p) {
    this.playerLocal = p;
    if (!this._ball || !this.scene) return;
    this._ball.visible = true;
    this._ball.position.set(p.x, this._h(p.x, p.z), p.z);
    // frame the action: focus a third of the way from the ball to the green,
    // but never fight the player's own panning
    if (this.orbit && this.follow) {
      const fx = p.x * 0.68, fz = p.z * 0.68;
      this.orbit.targetGoal.set(fx, this._h(fx, fz), fz);
    }
  }

  /** Snap back to following the ball, framed down the hole. */
  recenter() {
    if (!this.orbit) return;
    const anchor = this.playerLocal || (this.linePts ? this.linePts[0] : { x: 0, z: 0 });
    const span = Math.max(40, Math.hypot(anchor.x, anchor.z));
    const fx = anchor.x * 0.68, fz = anchor.z * 0.68;
    this.orbit.targetGoal.set(fx, this._h(fx, fz), fz);
    this.orbit.azimuthGoal = Math.atan2(anchor.x, anchor.z);
    this.orbit.radiusGoal = clamp(span * 1.05, 130, 620);
    this.orbit.elevationGoal = 0.55;
    this._panVel.set(0, 0, 0);
    this._setFollow(true);
  }

  _setFollow(v) {
    if (this.follow !== v) {
      this.follow = v;
      this.onFollowChange?.(v);
    } else {
      this.onFollowChange?.(v); // keep the app's button state in sync on show()
    }
  }

  /* ------------------------------------------- damped orbit camera */

  _applyOrbit() {
    const o = this.orbit;
    this.camera.position.set(
      o.target.x + o.radius * Math.cos(o.elevation) * Math.sin(o.azimuth),
      o.target.y + o.radius * Math.sin(o.elevation),
      o.target.z + o.radius * Math.cos(o.elevation) * Math.cos(o.azimuth));
    this.camera.lookAt(o.target);
  }

  _dampOrbit(dt) {
    const o = this.orbit;
    if (!o) return;
    // pan momentum (fling) — decays after the finger lifts
    if (!this._gestureActive && this._panVel.lengthSq() > 0.05) {
      o.target.addScaledVector(this._panVel, dt);
      o.targetGoal.copy(o.target);
      this._panVel.multiplyScalar(Math.exp(-dt * 4));
      this._clampTarget();
    }
    const k = 1 - Math.exp(-dt * 9); // smooth, frame-rate independent
    o.azimuth += (o.azimuthGoal - o.azimuth) * k;
    o.elevation += (o.elevationGoal - o.elevation) * k;
    o.radius += (o.radiusGoal - o.radius) * k;
    o.target.lerp(o.targetGoal, k);
    this._applyOrbit();
  }

  /** Where a screen point hits the ground plane (at the target's height).
   *  Points near the horizon land absurdly far away — a 1 px finger move
   *  there would fling the world — so hits are clamped to a sane distance
   *  around the current focus. */
  _groundPoint(clientX, clientY) {
    if (!this.camera || !this.orbit) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    this._ray.setFromCamera(ndc, this.camera);
    const { origin, direction } = this._ray.ray;
    const t = (this.orbit.target.y - origin.y) / direction.y;
    if (!isFinite(t) || t < 0) return null;
    const p = origin.clone().addScaledVector(direction, t);
    const maxD = this.orbit.radius * 2.2;
    const d = Math.hypot(p.x - this.orbit.target.x, p.z - this.orbit.target.z);
    if (d > maxD) {
      p.x = this.orbit.target.x + (p.x - this.orbit.target.x) * (maxD / d);
      p.z = this.orbit.target.z + (p.z - this.orbit.target.z) * (maxD / d);
    }
    return p;
  }

  _clampTarget() {
    const o = this.orbit, b = this.bounds;
    if (!b) return;
    o.target.x = clamp(o.target.x, b.minX - 40, b.minX + b.w + 40);
    o.target.z = clamp(o.target.z, b.minZ - 40, b.minZ + b.d + 40);
    o.targetGoal.x = clamp(o.targetGoal.x, b.minX - 40, b.minX + b.w + 40);
    o.targetGoal.z = clamp(o.targetGoal.z, b.minZ - 40, b.minZ + b.d + 40);
  }

  /* Google-Maps-style gestures:
   *   one finger  — pan; the ground point grabbed stays under the finger,
   *                 with fling momentum on release
   *   two fingers — pinch zooms toward the fingers, twisting rotates,
   *                 dragging both vertically tilts
   *   wheel       — zoom toward the cursor
   */
  _bindControls() {
    const el = this.renderer.domElement;
    const pointers = new Map();
    let grab = null;          // world point pinned under the single finger
    let lastMoveT = 0;
    let pinch = null;         // { dist, angle, midY }
    this._gestureActive = false;

    const interact = () => {
      this._gestureActive = true;
      if (this.follow) this._setFollow(false);
    };

    el.addEventListener('pointerdown', (e) => {
      if (!this.orbit) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      this._panVel.set(0, 0, 0);
      if (pointers.size === 1) {
        grab = this._groundPoint(e.clientX, e.clientY);
        lastMoveT = performance.now();
      } else if (pointers.size === 2) {
        grab = null;
        const [a, b] = [...pointers.values()];
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        pinch = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          angle: Math.atan2(b.y - a.y, b.x - a.x),
          midX, midY,
          startDist: Math.hypot(a.x - b.x, a.y - b.y),
          startAngle: Math.atan2(b.y - a.y, b.x - a.x),
          startMidX: midX, startMidY: midY,
          mode: null, accum: 0,
        };
        this._grabMid = this._groundPoint(midX, midY);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !this.orbit) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const o = this.orbit;

      if (pointers.size === 1 && grab) {
        // PAN: keep the grabbed ground point under the finger (1:1, no lag)
        const now = this._groundPoint(e.clientX, e.clientY);
        if (!now) return;
        interact();
        const delta = grab.clone().sub(now);
        delta.y = 0;
        o.target.add(delta);
        o.targetGoal.copy(o.target);
        this._clampTarget();
        this._applyOrbit();
        const t = performance.now();
        const dt = Math.max(0.008, (t - lastMoveT) / 1000);
        lastMoveT = t;
        // blended, capped velocity for the fling
        this._panVel.lerp(delta.divideScalar(dt), 0.35);
        const vMax = this.orbit.radius * 2.5;
        if (this._panVel.length() > vMax) this._panVel.setLength(vMax);
      } else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        interact();

        const dMidY = midY - pinch.midY;
        pinch.accum += Math.abs(midX - pinch.midX) + Math.abs(dMidY) + Math.abs(dist - pinch.dist);

        // decide once per gesture: parallel vertical slide = TILT,
        // anything else = pan/zoom/rotate around the fingers
        if (!pinch.mode && pinch.accum > 14) {
          const scaleChange = Math.abs(dist - pinch.startDist) / Math.max(1, pinch.startDist);
          let twist = angle - pinch.startAngle;
          if (twist > Math.PI) twist -= 2 * Math.PI;
          if (twist < -Math.PI) twist += 2 * Math.PI;
          const dX0 = midX - pinch.startMidX, dY0 = midY - pinch.startMidY;
          pinch.mode = (Math.abs(dY0) > 1.5 * Math.abs(dX0) &&
                        scaleChange < 0.06 && Math.abs(twist) < 0.1)
            ? 'tilt' : 'manip';
        }

        if (pinch.mode === 'tilt') {
          o.elevation = clamp(o.elevation + dMidY * 0.006, 0.18, 1.45);
          o.elevationGoal = o.elevation;
          this._applyOrbit();
        } else if (pinch.mode === 'manip') {
          // zoom + rotate…
          if (pinch.dist > 0 && dist > 0) {
            o.radius = clamp(o.radius * (pinch.dist / dist), 50, 2000);
            o.radiusGoal = o.radius;
          }
          let dA = angle - pinch.angle;
          if (dA > Math.PI) dA -= 2 * Math.PI;
          if (dA < -Math.PI) dA += 2 * Math.PI;
          o.azimuth -= dA;
          o.azimuthGoal = o.azimuth;
          this._applyOrbit();
          // …then keep the ground grabbed at gesture start pinned under the
          // fingers' midpoint — this one constraint gives Google-Maps-style
          // simultaneous two-finger pan, pinch-to-point and rotate-about-point
          const gp = this._groundPoint(midX, midY);
          if (gp && this._grabMid) {
            const dl = this._grabMid.clone().sub(gp);
            dl.y = 0;
            o.target.add(dl);
            o.targetGoal.copy(o.target);
            this._clampTarget();
            this._applyOrbit();
          }
        }

        pinch.dist = dist; pinch.angle = angle;
        pinch.midX = midX; pinch.midY = midY;
      }
    });

    const drop = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { pinch = null; this._grabMid = null; }
      if (pointers.size === 1) {
        // pinch ended with one finger down — re-grab for panning
        const p = [...pointers.values()][0];
        grab = this._groundPoint(p.x, p.y);
        this._panVel.set(0, 0, 0);
      }
      if (pointers.size === 0) {
        grab = null;
        this._gestureActive = false; // momentum takes over in the loop
      }
    };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);

    el.addEventListener('wheel', (e) => {
      if (!this.orbit) return;
      e.preventDefault();
      interact();
      const o = this.orbit;
      const scale = 1 + clamp(e.deltaY, -240, 240) * 0.0012;
      const gp = this._groundPoint(e.clientX, e.clientY);
      o.radiusGoal = clamp(o.radiusGoal * scale, 50, 2000);
      if (gp) {
        o.targetGoal.lerpVectors(gp, o.targetGoal, scale);
        this._clampTarget();
      }
      this._gestureActive = false;
    }, { passive: false });
  }

  /* ------------------------------------------------------- loop */

  setVisible(v) {
    this.visible = v;
    if (v && !this.running && this.renderer && this.scene) {
      this.running = true;
      let last = performance.now();
      const loop = (t) => {
        if (!this.running) return;
        requestAnimationFrame(loop);
        const dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        this._dampOrbit(dt);
        this._updateFlow(dt);
        if (this.flag) this.flag.rotation.y = Math.sin(t / 900) * 0.35;
        if (this._previewRing) {
          const s = 1 + Math.sin(t / 450) * 0.05; // gentle breathing pulse
          this._previewRing.scale.set(s, s, 1);
        }
        this.renderer.render(this.scene, this.camera);
      };
      requestAnimationFrame(loop);
    } else if (!v) {
      this.running = false;
    }
  }

  resize() {
    if (!this.renderer || !this.camera) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

/* ------------------------------------------------------------ helpers */

function bearingRad(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return Math.atan2(y, x);
}

function inLocalPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > pt.z) !== (b.z > pt.z) &&
        pt.x < (b.x - a.x) * (pt.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  let t = len2 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

let _dot = null;
function dotSprite() {
  if (_dot) return _dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}
