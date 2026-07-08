/* hole3d.js — a stunning stylised 3D hole, built with Three.js.
 *
 * The shapes (green, fairway, tees, bunkers, water) come from the course
 * geometry we already have; real slopes come from Google's Elevation data
 * when an API key is present (flat but still pretty without). The look is
 * deliberate low-poly flat shading — crisp beautiful regions you can read
 * at a glance: where the fairway is, where the trouble is, where the pin is.
 *
 * Local frame: green centre at the origin, the hole playing down -Z toward
 * the camera-side tee at +Z. X is right-of-line. Y is up (meters).
 */

import * as THREE from './vendor/three.module.js';
import { dist, toRad } from './geo.js';

const PALETTE = {
  bg: 0x0d1d15,
  rough: 0x1e4a2c,
  roughDark: 0x184025,
  fairway: 0x3e8b4f,
  green: 0x5fbc72,
  tee: 0x4a9c5b,
  bunker: 0xe3cf9d,
  water: 0x3a6ea8,
  pole: 0xf2ead8,
  flag: 0xc25b4e,
  line: 0xc8a96a,
  ball: 0xf6f2e7,
};

const CELL_M = 2.5;         // terrain facet size — small enough to read breaks
const MAX_CELLS = 260;      // per axis, keeps long par 5s in budget
const MARGIN_M = 45;        // rough shown around the hole corridor

export class Hole3D {
  constructor(container) {
    this.container = container;
    this.renderer = null;
    this.running = false;
    this.playerLocal = null;
  }

  /** WebGL can be missing/blocked — callers fall back to the 2D canvas. */
  supported() {
    if (this.renderer) return true;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.container.appendChild(this.renderer.domElement);
      this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
      this._bindControls();
      return true;
    } catch (e) {
      console.warn('WebGL unavailable', e);
      this.renderer = null;
      return false;
    }
  }

  /* -------------------------------------------------- local projection */

  _frame(hole) {
    const o = hole.greenCenter;
    const a = bearingRad(hole.tee, o);
    const cosLat = Math.cos(toRad(o.lat));
    const M = 111320; // meters per degree latitude
    return {
      toLocal: (p) => {
        const e = (p.lng - o.lng) * M * cosLat;
        const n = (p.lat - o.lat) * M;
        return {
          x: e * Math.cos(a) - n * Math.sin(a),
          z: -(e * Math.sin(a) + n * Math.cos(a)),
        };
      },
      toWorld: (x, z) => {
        const s = -z;
        const e = x * Math.cos(a) + s * Math.sin(a);
        const n = -x * Math.sin(a) + s * Math.cos(a);
        return { lat: o.lat + n / M, lng: o.lng + e / (M * cosLat) };
      },
    };
  }

  /**
   * Build and show a hole.
   * @param getElevations async (latlngs[]) => meters[] | null — Google data
   */
  async show(hole, features, getElevations) {
    if (!this.renderer) return;
    this.hole = hole;
    this.frame = this._frame(hole);
    const { toLocal, toWorld } = this.frame;

    // ---- extent of the scene in local meters
    const pts = hole.line.map(toLocal);
    let minX = -MARGIN_M, maxX = MARGIN_M, minZ = -MARGIN_M - 15, maxZ = MARGIN_M;
    for (const p of pts) {
      minX = Math.min(minX, p.x - MARGIN_M); maxX = Math.max(maxX, p.x + MARGIN_M);
      minZ = Math.min(minZ, p.z - MARGIN_M); maxZ = Math.max(maxZ, p.z + MARGIN_M);
    }
    const w = maxX - minX, d = maxZ - minZ;
    const nx = Math.min(MAX_CELLS, Math.max(24, Math.round(w / CELL_M)));
    const nz = Math.min(MAX_CELLS, Math.max(24, Math.round(d / CELL_M)));

    // ---- real terrain heights from Google Elevation (coarse grid, lerped)
    const heights = await this._heights(getElevations, toWorld, minX, minZ, w, d);
    this._hm = { heights, minX, minZ, w, d };

    // ---- region polygons near this hole, in local coords
    const near = (poly) => poly.some(p =>
      dist(p, hole.greenCenter) < 900 || dist(p, hole.tee) < 900);
    const local = (polys) => polys.filter(near).map(poly => poly.map(toLocal));
    const regions = [
      { polys: local(features.water), color: new THREE.Color(PALETTE.water), flat: true },
      { polys: local(features.bunkers), color: new THREE.Color(PALETTE.bunker) },
      { polys: local(features.tees), color: new THREE.Color(PALETTE.tee) },
      { polys: hole.green ? local([hole.green]) : [], color: new THREE.Color(PALETTE.green) },
      { polys: local(features.fairways), color: new THREE.Color(PALETTE.fairway) },
    ];

    // ---- scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.bg);
    scene.fog = new THREE.Fog(PALETTE.bg, d * 1.1, d * 2.6);
    this.scene = scene;

    scene.add(new THREE.HemisphereLight(0xdff2e0, 0x0e2418, 1.05));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.35);
    sun.position.set(-w, Math.max(80, d * 0.4), d * 0.4);
    scene.add(sun);

    scene.add(this._terrain(minX, minZ, w, d, nx, nz, heights, regions));
    this._addPin(heights, minX, minZ, w, d);
    this._addHoleLine(pts, heights, minX, minZ, w, d);
    this._ball = this._addBall();

    // ---- camera: raised behind the tee side, looking down the hole
    const tee = toLocal(hole.tee);
    const cam = new THREE.PerspectiveCamera(50, 1, 1, 6000);
    this.camera = cam;
    this.camTarget = new THREE.Vector3(
      tee.x * 0.25, this._h(heights, 0, 0, minX, minZ, w, d), tee.z * 0.5);
    this.orbit = {
      radius: Math.max(140, tee.z * 0.85),
      azimuth: Math.atan2(tee.x * 0.3, tee.z),   // roughly up the hole line
      elevation: 0.52,
    };
    this._applyOrbit();

    if (this.playerLocal) this.updatePlayerLocal(this.playerLocal);
    this.resize();
    this.setVisible(this.visible !== false);
  }

  /* ------------------------------------------------------- elevation */

  async _heights(getElevations, toWorld, minX, minZ, w, d) {
    const GX = 15, GZ = 31; // 496 samples — under Google's 512/request cap
    const grid = { GX, GZ, data: null };
    if (!getElevations) return grid;
    try {
      const latlngs = [];
      for (let j = 0; j <= GZ; j++) {
        for (let i = 0; i <= GX; i++) {
          latlngs.push(toWorld(minX + (i / GX) * w, minZ + (j / GZ) * d));
        }
      }
      const elev = await getElevations(latlngs);
      if (elev && elev.length === latlngs.length) {
        const min = Math.min(...elev);
        grid.data = elev.map(e => e - min);
      }
    } catch (e) { console.warn('elevation unavailable', e); }
    return grid;
  }

  /** Bilinear height (m) at local x,z. */
  _h(grid, x, z, minX, minZ, w, d) {
    if (!grid?.data) return 0;
    const { GX, GZ, data } = grid;
    const fx = Math.min(GX - 1e-6, Math.max(0, ((x - minX) / w) * GX));
    const fz = Math.min(GZ - 1e-6, Math.max(0, ((z - minZ) / d) * GZ));
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const at = (ii, jj) => data[jj * (GX + 1) + ii];
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) +
           (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
  }

  /* --------------------------------------------------------- meshes */

  _terrain(minX, minZ, w, d, nx, nz, heights, regions) {
    // Non-indexed grid so every facet gets a single crisp colour.
    const positions = [], colors = [];
    const rough = new THREE.Color(PALETTE.rough);
    const tmp = new THREE.Color();

    const classify = (x, z) => {
      const p = this._localPoint(x, z);
      for (const r of regions) {
        for (const poly of r.polys) if (inLocalPoly(p, poly)) return r;
      }
      return null;
    };

    const H = (x, z) => this._h(heights, x, z, minX, minZ, w, d);

    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x0 = minX + (i / nx) * w, x1 = minX + ((i + 1) / nx) * w;
        const z0 = minZ + (j / nz) * d, z1 = minZ + ((j + 1) / nz) * d;
        const corners = [
          [x0, H(x0, z0), z0], [x1, H(x1, z0), z0],
          [x1, H(x1, z1), z1], [x0, H(x0, z1), z1],
        ];
        for (const tri of [[0, 2, 1], [0, 3, 2]]) {
          const cx = (corners[tri[0]][0] + corners[tri[1]][0] + corners[tri[2]][0]) / 3;
          const cz = (corners[tri[0]][2] + corners[tri[1]][2] + corners[tri[2]][2]) / 3;
          const region = classify(cx, cz);
          if (region) tmp.copy(region.color);
          else tmp.copy(rough);
          // mowing stripes across the hole + gentle per-facet variation
          const stripe = Math.floor(j / 10) % 2 ? 1.035 : 0.965;
          const v = stripe * (1 + (hash2(i, j + (tri[0] ? 7 : 0)) - 0.5) * 0.05);
          for (const k of tri) {
            const y = region?.flat ? Math.min(corners[k][1], H(cx, cz)) - 0.25 : corners[k][1];
            positions.push(corners[k][0], y, corners[k][2]);
            colors.push(tmp.r * v, tmp.g * v, tmp.b * v);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    return new THREE.Mesh(geo, mat);
  }

  _localPoint(x, z) { return { x, z }; }

  _addPin(heights, minX, minZ, w, d) {
    const y = this._h(heights, 0, 0, minX, minZ, w, d);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 9, 6),
      new THREE.MeshLambertMaterial({ color: PALETTE.pole }));
    pole.position.set(0, y + 4.5, 0);
    this.scene.add(pole);

    this.flag = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 2.2),
      new THREE.MeshLambertMaterial({ color: PALETTE.flag, side: THREE.DoubleSide }));
    this.flag.position.set(1.8, y + 7.8, 0);
    this.scene.add(this.flag);

    // glow ring on the green so the pin reads from any distance
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 4.2, 40),
      new THREE.MeshBasicMaterial({ color: PALETTE.line, transparent: true, opacity: 0.55 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, y + 0.25, 0);
    this.scene.add(ring);
  }

  _addHoleLine(pts, heights, minX, minZ, w, d) {
    const v = pts.map(p => new THREE.Vector3(
      p.x, this._h(heights, p.x, p.z, minX, minZ, w, d) + 0.6, p.z));
    const curve = new THREE.CatmullRomCurve3(v);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(80));
    const line = new THREE.Line(geo,
      new THREE.LineDashedMaterial({ color: PALETTE.line, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.9 }));
    line.computeLineDistances();
    this.scene.add(line);
  }

  _addBall() {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 18, 14),
      new THREE.MeshLambertMaterial({ color: PALETTE.ball }));
    ball.position.y = 1.4;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.4, 3.1, 36),
      new THREE.MeshBasicMaterial({ color: PALETTE.ball, transparent: true, opacity: 0.5 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;
    g.add(ball, ring);
    g.visible = false;
    this.scene?.add(g);
    return g;
  }

  /** Move the player ball (world lat/lng). */
  updatePlayer(pos) {
    if (!this.frame) { this.playerLocal = null; return; }
    this.updatePlayerLocal(this.frame.toLocal(pos));
  }

  updatePlayerLocal(p) {
    this.playerLocal = p;
    if (!this._ball || !this.scene) return;
    if (!this._ball.parent) this.scene.add(this._ball);
    this._ball.visible = true;
    const y = this._hm
      ? this._h(this._hm.heights, p.x, p.z, this._hm.minX, this._hm.minZ, this._hm.w, this._hm.d)
      : 0;
    this._ball.position.set(p.x, y, p.z);
  }

  /* --------------------------------------------------- camera + loop */

  _applyOrbit() {
    const { radius, azimuth, elevation } = this.orbit;
    const t = this.camTarget;
    this.camera.position.set(
      t.x + radius * Math.cos(elevation) * Math.sin(azimuth),
      t.y + radius * Math.sin(elevation),
      t.z + radius * Math.cos(elevation) * Math.cos(azimuth));
    this.camera.lookAt(t);
  }

  _bindControls() {
    const el = this.renderer.domElement;
    let drag = null, pinch = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || !this.orbit) return;
      this.orbit.azimuth -= (e.clientX - drag.x) * 0.005;
      this.orbit.elevation = Math.min(1.35, Math.max(0.15,
        this.orbit.elevation + (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
      this._applyOrbit();
    });
    el.addEventListener('pointerup', () => { drag = null; });
    el.addEventListener('wheel', (e) => {
      if (!this.orbit) return;
      e.preventDefault();
      this.orbit.radius = Math.min(2200, Math.max(60, this.orbit.radius * (1 + e.deltaY * 0.001)));
      this._applyOrbit();
    }, { passive: false });
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) pinch = touchDist(e);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch && this.orbit) {
        const nd = touchDist(e);
        this.orbit.radius = Math.min(2200, Math.max(60, this.orbit.radius * pinch / nd));
        pinch = nd;
        this._applyOrbit();
      }
    }, { passive: true });
  }

  setVisible(v) {
    this.visible = v;
    if (v && !this.running && this.renderer && this.scene) {
      this.running = true;
      const loop = (t) => {
        if (!this.running) return;
        requestAnimationFrame(loop);
        if (this.flag) this.flag.rotation.y = Math.sin(t / 900) * 0.35;
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

function hash2(i, j) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function touchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy);
}
