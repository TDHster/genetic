// 3D VIEW of the turning rotor (three.js). Nothing here affects evolution.
//
// One unit = one metre. three's y is up; the model's wind blows along +x, the model's y (across the wind) is three's −z,
// so a counter-clockwise turn seen from above is a positive rotation around three's y, as in the model.
// The rotor stands on a mast above a flat roof.
//   - Blades are real NACA 00xx sections swept along the blade curve. Their colour is the angle of attack right now,
//     taken from the same DMST solution as the score: blue - lift works, yellow - near stall, red - stalled.
//   - Wind particles move with the speeds of the model's streamtubes: slowed down by the upwind half,
//     slowed again by the downwind half, a slow wake behind.
//
// This is an ES module (three.js is one). The classic scripts find it as window.View3D.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MAST = 2.2;           // m from the roof to the bottom of the rotor
const STATIONS = 40;        // sections along a blade
const SECTION = 24;         // points around a section
const PARTICLES = 2600;
const FIELD = { x0: -7, x1: 9, y: 3.6 };  // where the wind particles live (model x, |model y|)

// Half thickness of a NACA 00xx section at chord position x (0 = leading edge, 1 = trailing edge), share of the chord.
const nacaHalf = (x, t) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);

function create(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a1222');
  scene.fog = new THREE.Fog('#0a1222', 14, 34);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(-6.2, 4.6, 6.8);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, MAST + BOX.height / 2 - 0.3, 0);
  controls.maxPolarAngle = Math.PI * 0.53;
  controls.minDistance = 3;
  controls.maxDistance = 22;
  controls.update();

  scene.add(new THREE.HemisphereLight('#c8dcff', '#2a2418', 1.0));
  const sun = new THREE.DirectionalLight('#fff1dc', 2.0);
  sun.position.set(-6, 10, 4);
  scene.add(sun);
  const rim = new THREE.DirectionalLight('#6fa8ff', 0.8);
  rim.position.set(6, 3, -6);
  scene.add(rim);

  // Roof and mast
  const roof = new THREE.Mesh(new THREE.CircleGeometry(16, 64), new THREE.MeshStandardMaterial({ color: '#1a2030', roughness: 0.95 }));
  roof.rotation.x = -Math.PI / 2;
  scene.add(roof);
  const grid = new THREE.GridHelper(32, 32, '#2c3858', '#1d2640');
  grid.position.y = 0.002;
  scene.add(grid);
  const steel = new THREE.MeshStandardMaterial({ color: '#9aa4b8', metalness: 0.7, roughness: 0.35 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, MAST, 20), steel);
  mast.position.y = MAST / 2;
  scene.add(mast);

  const rotor = new THREE.Group();
  rotor.position.y = MAST;
  scene.add(rotor);

  // Wind particles
  const pPos = new Float32Array(PARTICLES * 3), pCol = new Float32Array(PARTICLES * 3);
  const model = new Float32Array(PARTICLES * 3); // model coordinates x, y, z (z from the rotor bottom)
  const spawn = (p, anywhere) => {
    model[3 * p] = anywhere ? FIELD.x0 + Math.random() * (FIELD.x1 - FIELD.x0) : FIELD.x0;
    model[3 * p + 1] = (Math.random() * 2 - 1) * FIELD.y;
    model[3 * p + 2] = -0.6 + Math.random() * (BOX.height + 1.2);
  };
  for (let p = 0; p < PARTICLES; p++) spawn(p, true);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.045, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(points);
  const fast = new THREE.Color('#9fd4ff'), slow = new THREE.Color('#ff7a2e'), tmp = new THREE.Color();

  let genome = null, analysis = null, blades = [];

  function clear() {
    for (const obj of [...rotor.children]) {
      rotor.remove(obj);
      obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    blades = [];
  }

  // One blade: STATIONS+1 sections of SECTION points, in the rotor frame at ψ = 0.
  function bladeMesh(g, k) {
    const pos = new Float32Array((STATIONS + 1) * SECTION * 3);
    const col = new Float32Array(pos.length);
    const pitch = g.pitch * Math.PI / 180;
    const half = SECTION / 2;
    // chord positions: cosine spacing, upper surface LE -> TE, lower TE -> LE
    const xs = [], sides = [];
    for (let m = 0; m < half; m++) { xs.push((1 - Math.cos(Math.PI * m / (half - 1))) / 2); sides.push(1); }
    for (let m = 0; m < half; m++) { xs.push((1 + Math.cos(Math.PI * m / (half - 1))) / 2); sides.push(-1); }
    for (let i = 0; i <= STATIONS; i++) {
      const p = bladePoint(g, i / STATIONS);
      const ang = p.phi + 2 * Math.PI * k / g.blades;
      const tx = -Math.sin(ang), ty = Math.cos(ang);          // direction of motion
      const nx = Math.cos(ang), ny = Math.sin(ang);           // out of the circle
      const lx = tx * Math.cos(pitch) - nx * Math.sin(pitch), ly = ty * Math.cos(pitch) - ny * Math.sin(pitch); // to the nose
      const wx = nx * Math.cos(pitch) + tx * Math.sin(pitch), wy = ny * Math.cos(pitch) + ty * Math.sin(pitch); // thickness
      for (let m = 0; m < SECTION; m++) {
        const along = p.c * (0.25 - xs[m]);                   // the quarter chord sits on the blade curve
        const across = sides[m] * p.c * nacaHalf(xs[m], g.thickness);
        const mx = p.r * nx + lx * along + wx * across, my = p.r * ny + ly * along + wy * across;
        const v = 3 * (i * SECTION + m);
        pos[v] = mx; pos[v + 1] = p.z; pos[v + 2] = -my;
      }
    }
    const index = [];
    for (let i = 0; i < STATIONS; i++) {
      for (let m = 0; m < SECTION - 1; m++) {
        const a = i * SECTION + m, b = a + 1, c = a + SECTION, d = c + 1;
        index.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.25, roughness: 0.45, side: THREE.DoubleSide,
    }));
    return mesh;
  }

  function build(g, a) {
    clear();
    genome = g;
    analysis = a;
    if (!g) return;
    for (let k = 0; k < g.blades; k++) {
      const mesh = bladeMesh(g, k);
      rotor.add(mesh);
      blades.push(mesh);
    }
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, BOX.height + 0.2, 16), steel);
    shaft.position.y = BOX.height / 2;
    rotor.add(shaft);
    // Struts: an arm from the shaft to every blade end that is far from it
    for (const s of [0, 1]) {
      const p = bladePoint(g, s);
      if (p.r <= STRUT_MIN) continue;
      for (let k = 0; k < g.blades; k++) {
        const ang = p.phi + 2 * Math.PI * k / g.blades;
        const strut = new THREE.Mesh(new THREE.BoxGeometry(p.r, 0.025, STRUT_CHORD), steel);
        strut.position.set(Math.cos(ang) * p.r / 2, p.z + (s ? -0.03 : 0.03), -Math.sin(ang) * p.r / 2);
        strut.rotation.y = ang;
        rotor.add(strut);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 20), steel);
      hub.position.y = p.z + (s ? -0.03 : 0.03);
      rotor.add(hub);
    }
  }

  // Angle of attack -> colour: blue (well below stall) .. yellow (at stall) .. red (stalled).
  function alphaColor(ratio, out) {
    if (ratio < 0.7) out.setHSL(0.56 - 0.1 * ratio / 0.7, 0.75, 0.55);
    else if (ratio < 1.0) out.setHSL(0.46 - 0.32 * (ratio - 0.7) / 0.3, 0.85, 0.55);
    else out.setHSL(Math.max(0, 0.14 - 0.14 * (ratio - 1) / 0.6), 0.9, Math.max(0.35, 0.55 - 0.1 * (ratio - 1)));
    return out;
  }

  function paintBlades(live) {
    const solved = analysis.table.details[live.li];
    const n = solved.length;
    const c = new THREE.Color();
    blades.forEach((mesh, k) => {
      const col = mesh.geometry.attributes.color.array;
      for (let i = 0; i <= STATIONS; i++) {
        const s = i / STATIONS;
        const slice = solved[Math.min(n - 1, Math.floor(s * n))];
        const p = bladePoint(genome, s);
        let theta = live.psi + p.phi + 2 * Math.PI * k / genome.blades;
        theta -= 2 * Math.PI * Math.floor(theta / (2 * Math.PI));
        const alpha = Math.abs(slice.alpha[Math.min(AZIMUTHS - 1, Math.floor(theta / AZ_STEP))]);
        alphaColor(Math.min(alpha, Math.PI - alpha) / slice.stall + (alpha > Math.PI / 2 ? 0.6 : 0), c);
        for (let m = 0; m < SECTION; m++) {
          const v = 3 * (i * SECTION + m);
          col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b;
        }
      }
      mesh.geometry.attributes.color.needsUpdate = true;
    });
  }

  // Wind speed at a model point, from the streamtubes of the nearest slice (keypoints along x, linear in between).
  function windAt(x, y, z, live) {
    const v = live.v;
    if (!analysis || z < 0 || z > BOX.height) return v;
    const solved = analysis.table.details[live.li];
    const k = Math.min(solved.length - 1, Math.floor(z / BOX.height * solved.length));
    const r = analysis.table.slices[k].r;
    if (Math.abs(y) >= r) return v;
    const scale = v / AERO.vRef;
    const theta = Math.PI - Math.asin(y / r);                    // upwind crossing
    const j = Math.min(AZIMUTHS - 1, Math.floor(theta / AZ_STEP));
    const d = partner(j);
    const sl = solved[k];
    const uUp = sl.u[j] * scale, ve = v * Math.max(AERO.minWake, 1 - 2 * sl.a[j]);
    const uDown = sl.u[d] * scale, wake = ve * Math.max(AERO.minWake, 1 - 2 * sl.a[d]);
    const xd = Math.sqrt(r * r - y * y), xu = -xd;
    const keys = [[xu - 1.5 * r, v], [xu, uUp], [(xu + xd) / 2, ve], [xd, uDown], [xd + 1.5 * r, wake], [xd + 14, (wake + v) / 2]];
    if (x <= keys[0][0]) return v;
    for (let i = 1; i < keys.length; i++) {
      if (x <= keys[i][0]) {
        const t = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
        return keys[i - 1][1] + t * (keys[i][1] - keys[i - 1][1]);
      }
    }
    return keys[keys.length - 1][1];
  }

  function moveParticles(dt, live) {
    for (let p = 0; p < PARTICLES; p++) {
      const x = model[3 * p], y = model[3 * p + 1], z = model[3 * p + 2];
      const u = windAt(x, y, z, live);
      model[3 * p] = x + u * dt;
      if (model[3 * p] > FIELD.x1) spawn(p, false);
      pPos[3 * p] = model[3 * p];
      pPos[3 * p + 1] = model[3 * p + 2] + MAST;
      pPos[3 * p + 2] = -model[3 * p + 1];
      tmp.copy(slow).lerp(fast, Math.max(0, Math.min(1, (u / live.v - 0.3) / 0.7)));
      pCol[3 * p] = tmp.r; pCol[3 * p + 1] = tmp.g; pCol[3 * p + 2] = tmp.b;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
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
    setRotor(g, a) { build(g, a); },
    // live: { psi (rotor angle, rad), li (row of the torque table), v (wind, m/s), dt (model seconds of this frame) }
    render(live) {
      if (genome && live) {
        rotor.rotation.y = live.psi;
        paintBlades(live);
        moveParticles(Math.min(0.2, live.dt), live);
      }
      controls.update();
      renderer.render(scene, camera);
    },
  };
}

window.View3D = { create };
window.dispatchEvent(new Event('view3d-ready'));
