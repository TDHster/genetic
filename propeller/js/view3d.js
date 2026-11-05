// 3D VIEW of the turning propeller at the stern of the submarine (three.js). Nothing here affects evolution.
//
// One unit = one metre. three's x is the shaft: the boat moves towards −x, the water flows past it towards +x.
// Angles round the shaft are counted from the top (three's +y) towards +z; the propeller turns that way
// (clockwise seen from behind, from +x).
//   - Blades are real sections (NACA thickness + parabolic camber) wrapped on cylinders along the helix of their
//     pitch, swept back by the skew. Their colour is the cavitation margin right now (suction / σ at this place
//     in the turn - the same numbers as the score): blue - safe, yellow - close, red - the water boils.
//   - Where a section boils, bubbles come off it; where the tip vortex boils, a white thread trails from the tip.
//   - Water particles: slow behind the fins and the hull, faster and swirling behind the propeller.
//   - A pump-jet: a half-transparent ring round the rotor and the stator vanes in front of it.
//
// This is an ES module (three.js is one). The classic scripts find it as window.View3D.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const STATIONS = 30;        // sections along a blade
const SECTION = 26;         // points round a section
const HULL = { radius: 3.5, start: -18, end: -1.0 };  // the tapering stern
const FIN = { from: -6.2, to: -3.6, tip: 3.6, thick: 0.14 };
const BUBBLES = 1500;
const WATER_PARTICLES = 1800;

// Half thickness of a NACA 4-digit section at chord position u (0 = leading edge, 1 = trailing edge), share of the chord.
const nacaHalf = (u, t) => 5 * t * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);

// Radius of the hull at x (smooth taper to the hub).
function hullRadius(x, hub) {
  const t = Math.max(0, Math.min(1, (x - HULL.start) / (HULL.end - HULL.start)));
  return hub + (HULL.radius - hub) * (1 - t ** 1.7) ** 0.8;
}

// Chord positions: cosine spacing, back side LE -> TE, face TE -> LE.
const us = [], sides = [];
for (let m = 0; m < SECTION / 2; m++) { us.push((1 - Math.cos(Math.PI * m / (SECTION / 2 - 1))) / 2); sides.push(-1); }
for (let m = 0; m < SECTION / 2; m++) { us.push((1 + Math.cos(Math.PI * m / (SECTION / 2 - 1))) / 2); sides.push(1); }

// One blade k, in the propeller frame at the rotation 0 (with a colour attribute for painting).
function bladeMesh(g, k, stations, material) {
  const pos = new Float32Array((STATIONS + 1) * SECTION * 3);
  const col = new Float32Array(pos.length).fill(1);
  const base = 2 * Math.PI * k / g.blades;
  stations.forEach((s, i) => {
    const cb = Math.cos(s.pitchAngle), sb = Math.sin(s.pitchAngle);
    for (let m = 0; m < SECTION; m++) {
      const u = us[m];
      const xi = s.c * (0.5 - u);                                      // along the chord, + towards the leading edge
      const eta = -4 * s.f * s.c * u * (1 - u) + sides[m] * nacaHalf(u, s.tau) * s.c; // + towards the face (aft)
      const ang = base - s.skew + (xi * cb + eta * sb) / s.r;
      const x = -xi * sb + eta * cb;
      const v = 3 * (i * SECTION + m);
      pos[v] = x; pos[v + 1] = s.r * Math.cos(ang); pos[v + 2] = s.r * Math.sin(ang);
    }
  });
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
  return new THREE.Mesh(geo, material);
}

// Sections along the blade, denser near the tip.
function bladeStations(g) {
  const stations = [];
  for (let i = 0; i <= STATIONS; i++) {
    const x = BOAT.hubRatio * 0.97 + (1 - BOAT.hubRatio * 0.97) * (1 - Math.cos(Math.PI / 2 * i / STATIONS) ** 1.2);
    stations.push(sectionAt(g, Math.min(1, x)));
  }
  return stations;
}

// The whole propeller unit: blades, hub and cap into `turning`; a pump-jet ring and stator vanes into `fixed`.
// mats: { blade(k) -> material, bronze, duct }. Returns { blades, stations }.
function buildUnit(g, turning, fixed, mats) {
  const R = propDiameter(g) / 2, hubR = R * BOAT.hubRatio;
  const stations = bladeStations(g);
  const blades = [];
  for (let k = 0; k < g.blades; k++) {
    const mesh = bladeMesh(g, k, stations, mats.blade(k));
    turning.add(mesh);
    blades.push(mesh);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, 1.7, 40), mats.bronze);
  hub.rotation.z = -Math.PI / 2;
  hub.position.x = -0.35;
  turning.add(hub);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(hubR, hubR * 1.6, 40), mats.bronze);
  cap.rotation.z = -Math.PI / 2;
  cap.position.x = 0.5 + hubR * 0.8;
  turning.add(cap);
  if (g.duct) {
    // How far the blades reach along the shaft (pitch and skew make them long): the stator stands in front of them
    // with a gap, the ring covers both (it is drawn not shorter than that, even if the gene says shorter).
    let front = Infinity, back = -Infinity;
    for (const b of blades) {
      const pos = b.geometry.attributes.position.array;
      for (let v = 0; v < pos.length; v += 3) { front = Math.min(front, pos[v]); back = Math.max(back, pos[v]); }
    }
    const gap = 0.08 * R, vaneChord = Math.min(0.5, 0.25 * R);
    const vaneX = front - gap - vaneChord / 2;
    const aft = back + 0.05 * R;
    const fore = Math.min(aft - g.ductLength * 2 * R, vaneX - vaneChord / 2 - 0.05 * R);
    const L = aft - fore;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.04, R * 1.04 / Math.sqrt(g.slowdown), L, 64, 1, true), mats.duct);
    ring.rotation.z = -Math.PI / 2;
    ring.position.x = (aft + fore) / 2;
    fixed.add(ring);
    for (let k = 0; k < g.stators; k++) {
      const vane = new THREE.Mesh(new THREE.BoxGeometry(vaneChord, R * (1.03 - BOAT.hubRatio), 0.05), mats.duct);
      const holder = new THREE.Group();
      vane.position.set(vaneX, R * (1.03 + BOAT.hubRatio) / 2, 0);
      vane.rotation.x = 0.25;
      holder.add(vane);
      holder.rotation.x = 2 * Math.PI * (k + 0.5) / g.stators;
      fixed.add(holder);
    }
  }
  return { blades, stations };
}

function clearGroups(...groups) {
  for (const group of groups) {
    for (const obj of [...group.children]) {
      group.remove(obj);
      obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }
}

function create(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#05141d');
  scene.fog = new THREE.Fog('#05141d', 16, 40);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
  camera.position.set(7.5, 3.2, 8.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(-1.6, 0, 0);
  controls.minDistance = 4;
  controls.maxDistance = 30;
  controls.update();

  scene.add(new THREE.HemisphereLight('#bfe3ff', '#0b1a22', 1.1));
  const sun = new THREE.DirectionalLight('#e8f6ff', 2.0);
  sun.position.set(4, 12, 6);
  scene.add(sun);
  const rim = new THREE.DirectionalLight('#5fb6ff', 0.9);
  rim.position.set(-6, -3, -8);
  scene.add(rim);

  // The stern: a body of revolution round x, with four fins in a cross.
  const hubR = BOAT.maxDiameter * BOAT.hubRatio / 2;
  const profile = [];
  for (let k = 0; k <= 40; k++) {
    const x = HULL.start + (HULL.end - HULL.start) * k / 40;
    profile.push(new THREE.Vector2(hullRadius(x, hubR), x));
  }
  const hullMat = new THREE.MeshStandardMaterial({ color: '#1c242c', roughness: 0.7, metalness: 0.2 });
  const hull = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), hullMat);
  hull.rotation.z = -Math.PI / 2; // lathe axis y -> x
  scene.add(hull);
  for (let k = 0; k < WAKE.fins; k++) {
    const rIn = hullRadius((FIN.from + FIN.to) / 2, hubR) - 0.1;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(FIN.to - FIN.from, FIN.tip - rIn, FIN.thick), hullMat);
    const holder = new THREE.Group();
    fin.position.set((FIN.from + FIN.to) / 2, (FIN.tip + rIn) / 2, 0);
    holder.add(fin);
    holder.rotation.x = 2 * Math.PI * k / WAKE.fins;
    scene.add(holder);
  }

  const prop = new THREE.Group();
  scene.add(prop);
  const fixed = new THREE.Group();   // parts of the propeller unit that do not turn (pump-jet ring and stator)
  scene.add(fixed);
  const ductMat = new THREE.MeshStandardMaterial({ color: '#3a4654', metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide,
    transparent: true, opacity: 0.55 });
  const bronze = new THREE.MeshStandardMaterial({ color: '#b48a4a', metalness: 0.85, roughness: 0.32 });

  // Bubbles (cavitation) and water particles.
  const makePoints = (count, size, color, opacity) => {
    const pos = new Float32Array(count * 3).fill(1e4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    scene.add(pts);
    return { pos, geo };
  };
  const bubbles = makePoints(BUBBLES, 0.1, '#f4fbff', 0.9);
  const bubbleState = Array.from({ length: BUBBLES }, () => ({ life: 0, x: 0, r: 0, ang: 0, va: 0, spin: 0 }));
  let nextBubble = 0;
  const water = makePoints(WATER_PARTICLES, 0.035, '#7fd3ff', 0.55);
  const waterState = Array.from({ length: WATER_PARTICLES }, () => ({ x: 0, r: 0, ang: 0 }));

  let genome = null, analysis = null, blades = [], stripOf = [], R = 2.5;

  function clear() {
    clearGroups(prop, fixed);
    blades = [];
  }

  const paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.35, side: THREE.DoubleSide });

  function build(g, a) {
    clear();
    genome = g;
    analysis = a;
    if (!g) return;
    R = propDiameter(g) / 2;
    const unit = buildUnit(g, prop, fixed, { blade: () => paintMat, bronze, duct: ductMat });
    blades = unit.blades;
    const stations = unit.stations;
    stripOf = [];
    if (a.pushes) {
      const strips = a.prep.strips;
      stations.forEach((s) => {
        let best = 0;
        strips.forEach((st, j) => { if (Math.abs(st.x - s.x) < Math.abs(strips[best].x - s.x)) best = j; });
        stripOf.push(best);
      });
    }
    blades.stations = stations;
    for (const b of bubbleState) b.life = 0;
  }

  // Cavitation margin -> colour: blue (safe) .. yellow (close) .. red (boils).
  function marginColor(ratio, out) {
    if (ratio < 0.6) out.setHSL(0.58 - 0.06 * ratio / 0.6, 0.65, 0.5);
    else if (ratio < 1.0) out.setHSL(0.52 - 0.38 * (ratio - 0.6) / 0.4, 0.8, 0.52);
    else out.setHSL(Math.max(0, 0.08 - 0.08 * (ratio - 1) / 0.5), 0.95, 0.5);
    return out;
  }

  const P = NOISE.positions;
  const positionIndex = (ang) => {
    const t = ang / (2 * Math.PI);
    return ((Math.round((t - Math.floor(t)) * P) % P) + P) % P;
  };

  function spawnBubble(x, r, ang, va, spin) {
    const b = bubbleState[nextBubble];
    nextBubble = (nextBubble + 1) % BUBBLES;
    b.life = 0.5 + Math.random() * 0.6;
    b.x = x + (Math.random() - 0.5) * 0.15;
    b.r = r * (1 + (Math.random() - 0.5) * 0.03);
    b.ang = ang + (Math.random() - 0.5) * 0.03;
    b.va = va;
    b.spin = spin;
  }

  function paint(live) {
    const cond = live.cond, c = new THREE.Color();
    const stations = blades.stations;
    const n = cond.n, vScale = cond.V / analysis.prep.V;
    blades.forEach((mesh, k) => {
      const col = mesh.geometry.attributes.color.array;
      const base = 2 * Math.PI * k / genome.blades + live.psi;
      stations.forEach((s, i) => {
        const strip = stripOf[i];
        const ang = base - s.skew;
        const ratio = cond.strips[strip][positionIndex(ang)];
        marginColor(ratio, c);
        for (let m = 0; m < SECTION; m++) {
          const v = 3 * (i * SECTION + m);
          col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b;
        }
        // bubbles off a boiling section, more the harder it boils
        if (ratio > 1 && i % 2 === 0 && Math.random() < Math.min(1, (ratio - 1) * 3) * live.dt * 60) {
          const e = analysis.prep.strips[strip];
          spawnBubble(0, s.r, ang, e.w * 0.3 * vScale, 0.6 * 2 * Math.PI * n);
        }
      });
      mesh.geometry.attributes.color.needsUpdate = true;
      // the tip vortex
      const tipAng = base - stations[stations.length - 1].skew;
      const tr = cond.tipRatio[positionIndex(tipAng)];
      if (tr > 1) {
        const count = Math.min(6, Math.ceil((tr - 1) * 8));
        for (let q = 0; q < count; q++) spawnBubble(0.05, R * 0.99, tipAng, cond.V * 0.95, 0.8 * 2 * Math.PI * n);
      }
    });
  }

  function moveBubbles(dt) {
    const pos = bubbles.pos;
    bubbleState.forEach((b, i) => {
      if (b.life <= 0) { pos[3 * i] = 1e4; return; }
      b.life -= dt;
      b.x += b.va * dt;
      b.ang += b.spin * dt;
      pos[3 * i] = b.x; pos[3 * i + 1] = b.r * Math.cos(b.ang); pos[3 * i + 2] = b.r * Math.sin(b.ang);
    });
    bubbles.geo.attributes.position.needsUpdate = true;
  }

  // Water: axial speed V(1 − wake) before the propeller, + the induced speed after it, with swirl.
  function respawnWater(p, anywhere) {
    p.x = anywhere ? -7 + Math.random() * 16 : -7;
    p.r = (BOAT.hubRatio + Math.random() * 1.3) * R + 0.05;
    p.ang = Math.random() * 2 * Math.PI;
  }
  waterState.forEach((p) => respawnWater(p, true));
  function moveWater(dt, live) {
    const pos = water.pos, V = live.cond.V, n = live.cond.n;
    const strips = analysis && analysis.pushes ? analysis.prep.strips : null;
    waterState.forEach((p, i) => {
      const x = Math.min(1, p.r / R);
      let va = V * (1 - wakeMean(Math.max(BOAT.hubRatio, x))) * (genome && genome.duct && x < 1 ? genome.slowdown : 1), spin = 0;
      if (p.x > 0 && x < 1 && strips && analysis.op) {
        const e = analysis.op.elements.reduce((b, el) => (Math.abs(el.x - x) < Math.abs(b.x - x) ? el : b));
        const grow = Math.min(1, p.x / 1.5);
        va *= 1 + 2 * e.a * grow;
        spin = 2 * e.b * 2 * Math.PI * n;
      }
      p.x += va * dt;
      p.ang += spin * dt;
      if (p.x > 9) respawnWater(p, false);
      const hr = hullRadius(p.x, R * BOAT.hubRatio);
      const r = p.x < HULL.end ? Math.max(p.r, hr + 0.05) : p.r;
      pos[3 * i] = p.x; pos[3 * i + 1] = r * Math.cos(p.ang); pos[3 * i + 2] = r * Math.sin(p.ang);
    });
    water.geo.attributes.position.needsUpdate = true;
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
    setPropeller(g, a) { build(g, a); },
    // live: { psi (rotation, rad), dt (model seconds of this frame), cond (noiseAt at the shown speed and depth) }
    render(live) {
      if (genome && live && analysis && analysis.pushes) {
        prop.rotation.x = live.psi;
        const dt = Math.min(0.1, live.dt);
        paint({ ...live, dt });
        moveBubbles(dt);
        moveWater(dt, live);
      }
      controls.update();
      renderer.render(scene, camera);
    },
  };
}

// STATIC VIEW: the propeller alone, in bronze, standing still; the mouse turns the camera.
// The first look is from behind and above at three quarters: the skew, the twist of the pitch and the ring are all seen.
function createStatic(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1520');
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight('#dfefff', '#1a1410', 1.0));
  const key = new THREE.DirectionalLight('#fff3e0', 2.6);
  key.position.set(6, 8, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight('#8fc8ff', 1.0);
  fill.position.set(-5, 2, -6);
  scene.add(fill);
  const back = new THREE.DirectionalLight('#ffffff', 0.8);
  back.position.set(-6, -4, 4);
  scene.add(back);

  const bronze = new THREE.MeshStandardMaterial({ color: '#c49352', metalness: 0.9, roughness: 0.28, side: THREE.DoubleSide });
  const hubMat = new THREE.MeshStandardMaterial({ color: '#a77b40', metalness: 0.9, roughness: 0.32 });
  const ductMat = new THREE.MeshStandardMaterial({ color: '#56677a', metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide,
    transparent: true, opacity: 0.45, depthWrite: false });
  const steel = new THREE.MeshStandardMaterial({ color: '#7d8794', metalness: 0.8, roughness: 0.35 });
  const turning = new THREE.Group(), fixed = new THREE.Group();
  scene.add(turning, fixed);
  let shaft = null, fitted = false;

  function build(g) {
    clearGroups(turning, fixed);
    if (shaft) { scene.remove(shaft); shaft.geometry.dispose(); shaft = null; }
    if (!g) return;
    buildUnit(g, turning, fixed, { blade: () => bronze, bronze: hubMat, duct: ductMat });
    const R = propDiameter(g) / 2;
    // a piece of the shaft going forward into the (unseen) boat
    shaft = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.12, R * 0.12, 2.5, 24), steel);
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = -2.3;
    scene.add(shaft);
    // the camera keeps its angle between propellers; distance follows the size (first time - the 3/4 view)
    const dist = 4.2 * R + 2;
    if (!fitted) {
      fitted = true;
      camera.position.set(0.62 * dist, 0.42 * dist, 0.66 * dist);
      controls.target.set(-0.2, 0, 0);
    } else {
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, dist);
    }
    controls.minDistance = R * 1.5;
    controls.maxDistance = R * 10;
    controls.update();
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  return {
    setPropeller(g) { build(g); },
    // back to the first look
    resetView() { fitted = false; },
  };
}

window.View3D = { create, createStatic };
window.dispatchEvent(new Event('view3d-ready'));
