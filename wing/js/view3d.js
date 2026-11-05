// 3D WIND TUNNEL (three.js). Nothing here affects evolution.
//
// One unit = one metre. The flow goes along +x, three's y is up, z is across the tunnel (the span).
// The model wing (chord CHORD) spans the test section from wall to wall - so the flow around it is two-dimensional,
// exactly the flow the evolution scores. The wing turns about its quarter chord on a turntable in the back wall.
//   - Wing colour: pressure coefficient Cp from the same panel solution (blue - suction, red - stagnation).
//   - Smoke: streamlines of the same panel solution, started from a rake of nozzles upstream. Puffs are released
//     at the same moment from all nozzles; lines join the puffs of one release (a "timeline"). Behind the wing a
//     simple wake (Gaussian speed deficit carrying the drag) is added - that part is an illustration, not the model.
//   - White line on the wing - where the boundary layer turns turbulent; red - where it separates.
//     Behind a separation a cloud of slow, churning smoke is drawn (also an illustration).
//   - Arrows: lift (green) and drag ×20 (red) on the balance.
//
// This is an ES module (three.js is one). The classic scripts find it as window.View3D.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const CHORD = 0.4;                                     // m, the model in the tunnel
const SECTION = { x0: -1.2, x1: 1.8, h: 0.55, w: 0.5 }; // test section: x from..to, half height, half width (m)
const RAKE_X = -1.05;                                   // m: smoke nozzles
const LINES = 17;                                       // smoke lines per plane
const PLANES = [-0.2, 0.3];                             // z of the smoke planes (m); the last one is the nearest to the camera
const PULSE = 0.35;                                     // time between puffs, in chord/V units
const FRONT_EVERY = 3;                                  // timelines join every 3rd release
const MAX_TIME = 40;                                    // longest smoke line, chord/V units
const CLOUD = 500;                                      // particles in the separated region
const DRAG_SCALE = 20;
const FORCE_SCALE = 0.2;                                // m of arrow per unit of Cl

function create(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a1222');
  scene.fog = new THREE.Fog('#0a1222', 6, 14);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 50);
  camera.position.set(-0.3, 0.32, 1.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.12, -0.02, 0);
  controls.minDistance = 0.4;
  controls.maxDistance = 6;
  controls.update();

  scene.add(new THREE.HemisphereLight('#c8dcff', '#202634', 1.1));
  const sun = new THREE.DirectionalLight('#fff1dc', 1.8);
  sun.position.set(-2, 4, 3);
  scene.add(sun);
  const rim = new THREE.DirectionalLight('#6fa8ff', 0.7);
  rim.position.set(3, -1, -2);
  scene.add(rim);

  buildTunnel(scene);

  // ---- the wing and everything that turns with it ----
  const wing = new THREE.Group();
  scene.add(wing);
  const pointer = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.3, 0, -SECTION.w + 0.004), new THREE.Vector3(0.3, 0, -SECTION.w + 0.004)]),
    new THREE.LineBasicMaterial({ color: '#ffb547' }));
  scene.add(pointer);

  // ---- smoke ----
  const smoke = new THREE.Group();
  scene.add(smoke);
  const puffGeo = new THREE.BufferGeometry();
  const puffs = new THREE.Points(puffGeo, new THREE.PointsMaterial({
    size: 0.011, color: '#eaf3ff', transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  smoke.add(puffs);
  const frontGeo = new THREE.BufferGeometry();
  const fronts = new THREE.LineSegments(frontGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4 }));
  smoke.add(fronts);

  // ---- separated region: slow churning smoke ----
  const cloudPos = new Float32Array(CLOUD * 3), cloudVel = new Float32Array(CLOUD * 2), cloudAge = new Float32Array(CLOUD);
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute('position', new THREE.BufferAttribute(cloudPos, 3));
  const cloud = new THREE.Points(cloudGeo, new THREE.PointsMaterial({
    size: 0.014, color: '#ff8f7a', transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(cloud);

  // ---- forces ----
  const arrowStyle = (arrow) => {
    for (const m of [arrow.line.material, arrow.cone.material]) { m.depthTest = false; m.transparent = true; }
    arrow.renderOrder = 10;
    return arrow;
  };
  const liftArrow = arrowStyle(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.3, '#5fd47d', 0.05, 0.03));
  const dragArrow = arrowStyle(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.1, '#ff6b5e', 0.04, 0.025));
  scene.add(liftArrow, dragArrow);

  let state = null;            // { g, at, alpha, ca, sa, lines, te, cd, sepCloud }
  let modelTime = 0;
  const options = { smoke: true, pressure: false, forces: true };

  // ---- coordinates: airfoil (chord units, nose at 0) <-> tunnel (metres, quarter chord at the origin) ----
  const toTunnel = (s, x, y) => {
    const dx = x - 0.25;
    return [(dx * s.ca + y * s.sa) * CHORD, (-dx * s.sa + y * s.ca) * CHORD];
  };
  const toAirfoil = (s, X, Y) => {
    const rx = X / CHORD, ry = Y / CHORD;
    return [0.25 + rx * s.ca - ry * s.sa, rx * s.sa + ry * s.ca];
  };

  // Air velocity at a tunnel point (in units of the free-stream speed): panel solution + the illustrated wake.
  const tmp = [0, 0];
  function velocity(s, X, Y, out) {
    const [x, y] = toAirfoil(s, X, Y);
    flowVelocity(s.at.P, s.at.sol, x, y, tmp);
    let u = tmp[0] * s.ca + tmp[1] * s.sa;
    const v = -tmp[0] * s.sa + tmp[1] * s.ca;
    const dx = (X - s.te[0]) / CHORD;
    if (dx > 0) {
      const w = 0.03 + 0.08 * dx;
      u -= Math.min(0.6, s.cd / (2 * w * Math.sqrt(Math.PI))) * Math.exp(-(((Y - s.te[1]) / CHORD / w) ** 2));
    }
    out[0] = u; out[1] = v;
    return out;
  }

  // One smoke line from the rake: points (m) and the time to reach each of them (chord/V units).
  function streamline(s, y0) {
    const xs = [RAKE_X], ys = [y0], ts = [0], speeds = [1];
    const a = [0, 0], b = [0, 0];
    let X = RAKE_X, Y = y0, t = 0;
    for (let step = 0; step < 900 && X < SECTION.x1 && t < MAX_TIME; step++) {
      const dist = Math.hypot(X, Y) / CHORD;
      const ds = CHORD * (0.012 + 0.05 * Math.min(2, Math.max(0, dist - 0.8)));
      velocity(s, X, Y, a);
      const sa = Math.hypot(a[0], a[1]);
      if (sa < 0.03) break;                          // ran into the stagnation point
      velocity(s, X + 0.5 * ds * a[0] / sa, Y + 0.5 * ds * a[1] / sa, b);
      const sb = Math.hypot(b[0], b[1]);
      if (sb < 0.03) break;
      X += ds * b[0] / sb; Y += ds * b[1] / sb;
      t += ds / CHORD / sb;
      xs.push(X); ys.push(Y); ts.push(t); speeds.push(sb);
    }
    return { xs, ys, ts, speeds };
  }

  function speedColor(v, out) {
    const slow = new THREE.Color('#6f7dff'), mid = new THREE.Color('#e8eefc'), fast = new THREE.Color('#ffb547');
    if (v < 1) out.copy(slow).lerp(mid, Math.max(0, (v - 0.5) / 0.5));
    else out.copy(mid).lerp(fast, Math.min(1, (v - 1) / 0.6));
    return out;
  }

  function cpColor(cp, out) {
    const neutral = new THREE.Color('#d8dde8');
    if (cp <= 0) {
      const s = Math.min(1, -cp / 2.5);
      return s < 0.5 ? out.copy(neutral).lerp(new THREE.Color('#42d4ff'), s * 2) : out.set('#42d4ff').lerp(new THREE.Color('#2f6bff'), (s - 0.5) * 2);
    }
    const s = Math.min(1, cp);
    return s < 0.5 ? out.copy(neutral).lerp(new THREE.Color('#ff9a3c'), s * 2) : out.set('#ff9a3c').lerp(new THREE.Color('#ff3b30'), (s - 0.5) * 2);
  }

  function clearGroup(group, keep) {
    for (const obj of [...group.children]) {
      if (keep && keep.includes(obj)) continue;
      group.remove(obj);
      obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
  }

  // ---- building ----

  function buildWing(s) {
    clearGroup(wing);
    const P = s.at.P, n = P.n, half = SECTION.w - 0.002;
    const nodes = n + 1, pos = new Float32Array(nodes * 2 * 3), col = new Float32Array(nodes * 2 * 3);
    const c = new THREE.Color();
    for (let j = 0; j < nodes; j++) {
      const x = j < n ? P.x0[j] : P.x0[0], y = j < n ? P.y0[j] : P.y0[0];
      const cp = j === 0 ? s.at.sol.cp[0] : j === n ? s.at.sol.cp[n - 1] : (s.at.sol.cp[j - 1] + s.at.sol.cp[j]) / 2;
      cpColor(cp, c);
      for (let side = 0; side < 2; side++) {
        const v = 3 * (2 * j + side);
        pos[v] = (x - 0.25) * CHORD; pos[v + 1] = y * CHORD; pos[v + 2] = side ? half : -half;
        col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b;
      }
    }
    const index = [];
    for (let j = 0; j < n; j++) {
      const a = 2 * j, b = a + 1, cc = a + 2, d = a + 3;
      index.push(a, cc, b, b, cc, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    wing.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide })));

    // end caps: the airfoil outline filled at both walls, so the wing is a solid, not an open tube
    const outline = [];
    for (let j = 0; j < n; j++) outline.push(new THREE.Vector2((P.x0[j] - 0.25) * CHORD, P.y0[j] * CHORD));
    const capGeo = new THREE.ShapeGeometry(new THREE.Shape(outline));
    const capMat = new THREE.MeshStandardMaterial({ color: '#4a5878', roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide });
    for (const z of [-half, half]) {
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.z = z;
      wing.add(cap);
    }

    // transition (white) and separation (red) lines along the span
    const spanLine = (side, x, color) => {
      const k = side.idx.reduce((best, i) => (Math.abs(P.xm[i] - x) < Math.abs(P.xm[best] - x) ? i : best), side.idx[0]);
      const px = (P.xm[k] + P.nx[k] * 0.004 - 0.25) * CHORD, py = (P.ym[k] + P.ny[k] * 0.004) * CHORD;
      wing.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(px, py, -half), new THREE.Vector3(px, py, half)]),
        new THREE.LineBasicMaterial({ color })));
    };
    for (const side of [s.at.upper, s.at.lower]) {
      if (side.transitionX !== null) spanLine(side, side.transitionX, '#ffffff');
      if (side.separationX !== null && side.separationX < 0.99) spanLine(side, side.separationX, '#ff4a3d');
    }

    // pressure "brush" at the near wall: out of the surface for suction, into it for pressure
    if (options.pressure) {
      const seg = [], segCol = [], z = half - 0.01;
      for (let i = 0; i < n; i += 2) {
        const cp = s.at.sol.cp[i], L = Math.min(2.5, Math.abs(cp)) * 0.05;
        const x0 = (P.xm[i] - 0.25) * CHORD, y0 = P.ym[i] * CHORD;
        seg.push(x0, y0, z, x0 + P.nx[i] * L, y0 + P.ny[i] * L, z);
        cpColor(Math.max(-2.5, Math.min(1, cp * 1.5)), c);
        segCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(segCol, 3));
      wing.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true })));
    }
    wing.rotation.z = -s.alpha;
    pointer.rotation.z = -s.alpha;
  }

  function buildSmoke(s) {
    clearGroup(smoke, [puffs, fronts]);
    s.lines = [];
    for (let k = 0; k < LINES; k++) {
      const y0 = (k / (LINES - 1) - 0.5) * 2 * SECTION.h * 0.6;
      const line = streamline(s, y0);
      // which side of the wing the line passes (timelines are not drawn across the wing)
      let side = 0;
      for (let i = 0; i < line.xs.length; i++) if (line.xs[i] >= s.te[0]) { side = line.ys[i] > s.te[1] ? 1 : -1; break; }
      line.side = line.xs[line.xs.length - 1] < s.te[0] ? 0 : side; // 0 - stopped at the nose
      s.lines.push(line);
    }
    const c = new THREE.Color();
    PLANES.forEach((z, p) => {
      for (const line of s.lines) {
        const pos = new Float32Array(line.xs.length * 3), col = new Float32Array(line.xs.length * 3);
        for (let i = 0; i < line.xs.length; i++) {
          pos[3 * i] = line.xs[i]; pos[3 * i + 1] = line.ys[i]; pos[3 * i + 2] = z;
          speedColor(line.speeds[i], c);
          col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        smoke.add(new THREE.Line(g, new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity: p === PLANES.length - 1 ? 0.5 : 0.18, depthWrite: false,
        })));
      }
    });
    const longest = Math.max(...s.lines.map((l) => l.ts[l.ts.length - 1]));
    s.releases = Math.ceil(longest / PULSE) + 1;
    puffGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINES * PLANES.length * s.releases * 3), 3));
    frontGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LINES - 1) * s.releases * 6), 3));
  }

  // Position of a puff of age t on a line, or null if it has left the line.
  function along(line, t, out) {
    const ts = line.ts;
    if (t > ts[ts.length - 1]) return null;
    let lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    const f = ts[hi] > ts[lo] ? (t - ts[lo]) / (ts[hi] - ts[lo]) : 0;
    out[0] = line.xs[lo] + f * (line.xs[hi] - line.xs[lo]);
    out[1] = line.ys[lo] + f * (line.ys[hi] - line.ys[lo]);
    return out;
  }

  function movePuffs(s) {
    const pos = puffGeo.attributes.position.array, fpos = frontGeo.attributes.position.array;
    const phase = modelTime % PULSE, p = [0, 0], q = [0, 0];
    let v = 0;
    for (let m = 0; m < s.releases; m++) {
      const age = phase + m * PULSE;
      for (let k = 0; k < LINES; k++) {
        const ok = along(s.lines[k], age, p);
        for (const z of PLANES) {
          pos[v++] = ok ? p[0] : 0; pos[v++] = ok ? p[1] : -50; pos[v++] = z;
        }
      }
    }
    let w = 0;
    const zf = PLANES[PLANES.length - 1];
    for (let m = 0; m < s.releases; m++) {
      const age = phase + m * PULSE;
      for (let k = 0; k < LINES - 1; k++) {
        const a = s.lines[k], b = s.lines[k + 1];
        const ok = m % FRONT_EVERY === 0 && a.side !== 0 && a.side === b.side && along(a, age, p) && along(b, age, q);
        fpos[w++] = ok ? p[0] : 0; fpos[w++] = ok ? p[1] : -50; fpos[w++] = zf;
        fpos[w++] = ok ? q[0] : 0; fpos[w++] = ok ? q[1] : -50; fpos[w++] = zf;
      }
    }
    puffGeo.attributes.position.needsUpdate = true;
    frontGeo.attributes.position.needsUpdate = true;
  }

  // Separated region: particles born on the surface behind the separation point, drifting slowly and churning.
  function spawnCloud(s, p) {
    const sides = [s.at.upper, s.at.lower].filter((d) => d.separationX !== null && d.separationX < 0.97);
    if (!sides.length) { cloudPos[3 * p + 1] = -50; cloudAge[p] = 1e9; return; }
    const side = sides[Math.floor(Math.random() * sides.length)];
    const P = s.at.P, from = side.idx.findIndex((i) => P.xm[i] >= side.separationX);
    const i = side.idx[from + Math.floor(Math.random() * (side.idx.length - from))];
    const depth = 0.25 * (P.xm[i] - side.separationX) * Math.random() + 0.005;
    const [X, Y] = toTunnel(s, P.xm[i] + P.nx[i] * depth, P.ym[i] + P.ny[i] * depth);
    cloudPos[3 * p] = X; cloudPos[3 * p + 1] = Y; cloudPos[3 * p + 2] = (Math.random() * 2 - 1) * (SECTION.w - 0.01);
    cloudVel[2 * p] = 0.1 + 0.2 * Math.random(); cloudVel[2 * p + 1] = (Math.random() - 0.5) * 0.2;
    cloudAge[p] = -2 * Math.random();
  }

  function moveCloud(s, dt) {
    if (!s.sepCloud) { cloud.visible = false; return; }
    cloud.visible = true;
    for (let p = 0; p < CLOUD; p++) {
      cloudAge[p] += dt;
      if (cloudAge[p] > 2.5 || cloudPos[3 * p] > SECTION.x1) { spawnCloud(s, p); continue; }
      if (cloudAge[p] < 0) continue;
      cloudVel[2 * p] += (Math.random() - 0.5) * 2 * dt;
      cloudVel[2 * p + 1] += (Math.random() - 0.5) * 2 * dt;
      cloudVel[2 * p] = Math.max(-0.2, Math.min(0.6, cloudVel[2 * p]));
      const behind = cloudPos[3 * p] > s.te[0];
      cloudPos[3 * p] += (cloudVel[2 * p] + (behind ? 0.3 : 0)) * dt * CHORD;
      cloudPos[3 * p + 1] += cloudVel[2 * p + 1] * dt * CHORD;
    }
    cloudGeo.attributes.position.needsUpdate = true;
  }

  function placeForces(s) {
    const w = s.at;
    const lift = w.cl * FORCE_SCALE, drag = w.cd * DRAG_SCALE * FORCE_SCALE;
    liftArrow.setDirection(new THREE.Vector3(0, Math.sign(lift) || 1, 0));
    liftArrow.setLength(Math.max(0.02, Math.abs(lift)), 0.05, 0.03);
    dragArrow.setDirection(new THREE.Vector3(1, 0, 0));
    dragArrow.setLength(Math.max(0.02, drag), 0.04, 0.025);
    liftArrow.visible = dragArrow.visible = options.forces;
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  return {
    // g - genome, at - analyzeAt(...) with .P at the angle at.alpha (degrees).
    setFlow(g, at) {
      if (!at) { state = null; return; }
      const alpha = at.alpha * Math.PI / 180;
      const s = { g, at, alpha, ca: Math.cos(alpha), sa: Math.sin(alpha), cd: at.cd };
      s.te = toTunnel(s, 1, 0);
      s.sepCloud = [at.upper, at.lower].some((d) => d.separationX !== null && d.separationX < 0.97);
      state = s;
      buildWing(s);
      buildSmoke(s);
      placeForces(s);
      for (let p = 0; p < CLOUD; p++) spawnCloud(s, p);
      smoke.visible = options.smoke;
    },
    setOptions(o) {
      Object.assign(options, o);
      smoke.visible = options.smoke;
      if (state) { buildWing(state); placeForces(state); }
    },
    // dt - real seconds of this frame; rate - chord/V time units per real second (slow motion).
    render(dt, rate) {
      if (state) {
        const step = Math.min(0.1, dt) * rate;
        modelTime += step;
        if (options.smoke) movePuffs(state);
        moveCloud(state, step);
      }
      controls.update();
      renderer.render(scene, camera);
    },
  };
}

// The tunnel itself: test section with glass walls, turntable, contraction with honeycomb, diffuser, stand.
function buildTunnel(scene) {
  const { x0, x1, h, w } = SECTION;
  const edge = new THREE.LineBasicMaterial({ color: '#3d5080' });
  const glass = new THREE.MeshStandardMaterial({ color: '#7fa6ff', transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: '#111a30', roughness: 0.9, side: THREE.DoubleSide });

  const box = new THREE.BoxGeometry(x1 - x0, 2 * h, 2 * w);
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(box), edge);
  frame.position.x = (x0 + x1) / 2;
  scene.add(frame);
  // back wall (dark, with a grid), floor, glass ceiling and front
  const back = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, 2 * h), dark);
  back.position.set((x0 + x1) / 2, 0, -w);
  scene.add(back);
  const gridPts = [];
  for (let x = Math.ceil(x0 * 10) / 10; x <= x1 + 1e-9; x += 0.1) gridPts.push(new THREE.Vector3(x, -h, -w + 0.002), new THREE.Vector3(x, h, -w + 0.002));
  for (let y = -0.5; y <= 0.5 + 1e-9; y += 0.1) gridPts.push(new THREE.Vector3(x0, y, -w + 0.002), new THREE.Vector3(x1, y, -w + 0.002));
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPts), new THREE.LineBasicMaterial({ color: '#1a2542' })));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, 2 * w), dark);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((x0 + x1) / 2, -h, 0);
  scene.add(floor);
  for (const [y, z, rx] of [[h, 0, Math.PI / 2], [0, w, 0]]) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, rx ? 2 * w : 2 * h), glass);
    pane.rotation.x = rx;
    pane.position.set((x0 + x1) / 2, y, z);
    scene.add(pane);
  }

  // turntable on the back wall with ticks every 5°
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.275, 64), new THREE.MeshBasicMaterial({ color: '#2c3a66' }));
  ring.position.z = -w + 0.003;
  scene.add(ring);
  const ticks = [];
  for (let d = -30; d <= 30; d += 5) {
    const a = Math.PI + d * Math.PI / 180, r0 = d % 10 === 0 ? 0.24 : 0.25;
    ticks.push(new THREE.Vector3(Math.cos(a) * r0, Math.sin(a) * r0, -w + 0.004), new THREE.Vector3(Math.cos(a) * 0.275, Math.sin(a) * 0.275, -w + 0.004));
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), new THREE.LineBasicMaterial({ color: '#6c7cab' })));

  // contraction (wide mouth upstream) with a honeycomb, diffuser downstream
  const funnel = (xa, xb, sa, sb) => {
    const pts = [];
    for (const [sy, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      pts.push(new THREE.Vector3(xa, sy * h * sa, sz * w * sa), new THREE.Vector3(xb, sy * h * sb, sz * w * sb));
    }
    const rect = (x, s) => {
      const c = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
      for (let i = 0; i < 4; i++) {
        const [ya, za] = c[i], [yb, zb] = c[(i + 1) % 4];
        pts.push(new THREE.Vector3(x, ya * h * s, za * w * s), new THREE.Vector3(x, yb * h * s, zb * w * s));
      }
    };
    rect(xa, sa);
    rect(xb, sb);
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), edge));
  };
  funnel(x0 - 1.0, x0, 1.9, 1);
  funnel(x1, x1 + 1.3, 1, 1.35);
  const comb = [];
  for (let i = -6; i <= 6; i++) {
    comb.push(new THREE.Vector3(x0 - 1.0, i / 6 * h * 1.9, -w * 1.9), new THREE.Vector3(x0 - 1.0, i / 6 * h * 1.9, w * 1.9));
    comb.push(new THREE.Vector3(x0 - 1.0, -h * 1.9, i / 6 * w * 1.9), new THREE.Vector3(x0 - 1.0, h * 1.9, i / 6 * w * 1.9));
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(comb), new THREE.LineBasicMaterial({ color: '#26355c' })));
  // legs and the floor of the lab
  const steel = new THREE.MeshStandardMaterial({ color: '#8e98ae', metalness: 0.6, roughness: 0.4 });
  for (const x of [x0 + 0.2, x1 - 0.2]) {
    for (const z of [-w + 0.05, w - 0.05]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.45, 8), steel);
      leg.position.set(x, -h - 0.225, z);
      scene.add(leg);
    }
  }
  const lab = new THREE.GridHelper(12, 48, '#1d2640', '#151c30');
  lab.position.y = -h - 0.45;
  scene.add(lab);
}

window.View3D = { create };
window.dispatchEvent(new Event('view3d-ready'));
