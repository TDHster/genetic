// 3D VIEW of the fan in a dark bedroom (three.js). Nothing here affects evolution.
//
// One unit = one metre. The fan blows towards +z (towards the camera and the bed); the rotor turns counter-clockwise
// seen from the front. Inside the rotor group the shaft is the local x (as in the propeller project): the blades are
// built along x and the group is turned so that local x becomes world +z; angles round the shaft are counted from the
// top (+y) towards local +z (world −x).
//   - Blades are real sections (thin NACA thickness + parabolic camber) wrapped on cylinders along the helix of their
//     pitch, swept by the sweep. Their colour is the stall margin right now (angle of attack / stall angle at this place
//     in the turn - the same numbers as the score): blue - far, yellow - close, red - stalled.
//   - Behind the rotor: the motor, the rear guard with INFLOW.spokes radial spokes and the pole - the wakes of the physics.
//   - Air particles: sucked in from behind, through the disc at the induced speed w, blown forward at ~2w with swirl.
//
// This is an ES module (three.js is one). The classic scripts find it as window.View3D.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const STATIONS = 30;        // sections along a blade
const SECTION = 22;         // points round a section
const AIR_PARTICLES = 1600;
const GUARD_R = FAN.maxDiameter / 2 + 0.015;
const FLOOR_Y = -1.05;

// Half thickness of a NACA 4-digit section at chord position u (0 = leading edge, 1 = trailing edge), share of the chord.
const nacaHalf = (u, t) => 5 * t * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);

// Chord positions: cosine spacing, back side LE -> TE, face TE -> LE.
const us = [], sides = [];
for (let m = 0; m < SECTION / 2; m++) { us.push((1 - Math.cos(Math.PI * m / (SECTION / 2 - 1))) / 2); sides.push(-1); }
for (let m = 0; m < SECTION / 2; m++) { us.push((1 + Math.cos(Math.PI * m / (SECTION / 2 - 1))) / 2); sides.push(1); }

// One blade at the angle base, in the rotor frame (shaft = local x), with a colour attribute for painting.
function bladeMesh(base, stations, material) {
  const pos = new Float32Array((STATIONS + 1) * SECTION * 3);
  const col = new Float32Array(pos.length).fill(1);
  stations.forEach((s, i) => {
    const cb = Math.cos(s.pitchAngle), sb = Math.sin(s.pitchAngle);
    for (let m = 0; m < SECTION; m++) {
      const u = us[m];
      const xi = s.c * (0.5 - u);                                                    // along the chord, + towards the leading edge
      const eta = -4 * s.f * s.c * u * (1 - u) + sides[m] * nacaHalf(u, Math.max(0.012, s.tau)) * s.c; // + towards the face (downstream)
      const ang = base - s.sweep + (xi * cb + eta * sb) / s.r;
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
    const x = FAN.hubRatio * 0.97 + (1 - FAN.hubRatio * 0.97) * (1 - Math.cos(Math.PI / 2 * i / STATIONS) ** 1.2);
    stations.push(sectionAt(g, Math.min(1, x)));
  }
  return stations;
}

// The rotor: blades, hub and spinner into `group` (shaft = local x). mats: { blade, hub }. Returns { blades, stations, angles }.
function buildRotor(g, group, mats) {
  const R = fanDiameter(g) / 2, hubR = R * FAN.hubRatio;
  const stations = bladeStations(g);
  const { angles } = bladeAngles(g);
  const blades = angles.map((a) => {
    const mesh = bladeMesh(a, stations, mats.blade);
    group.add(mesh);
    return mesh;
  });
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, 0.05, 40), mats.hub);
  hub.rotation.z = -Math.PI / 2;
  group.add(hub);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(hubR, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mats.hub);
  cap.rotation.z = -Math.PI / 2;
  cap.scale.set(1, 0.6, 1);
  cap.position.x = 0.025;
  group.add(cap);
  return { blades, stations, angles };
}

function clearGroup(group) {
  for (const obj of [...group.children]) {
    group.remove(obj);
    obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
}

// The fixed parts: motor, pole, base, rear and front guard (world frame, fan centre at the origin).
function buildBody(scene) {
  const white = new THREE.MeshStandardMaterial({ color: '#d9dce8', roughness: 0.45, metalness: 0.1 });
  const grey = new THREE.MeshStandardMaterial({ color: '#8e93a8', roughness: 0.5, metalness: 0.3 });
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.13, 40), white);
  motor.rotation.x = Math.PI / 2;
  motor.position.z = -0.1;
  scene.add(motor);
  const back = new THREE.Mesh(new THREE.SphereGeometry(0.075, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), white);
  back.rotation.x = -Math.PI / 2;
  back.position.z = -0.165;
  back.scale.set(1, 0.6, 1);
  scene.add(back);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.12, 20), white);
  neck.position.set(0, -0.1, -0.11);
  scene.add(neck);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, -0.15 - FLOOR_Y, 20), grey);
  pole.position.set(0, (FLOOR_Y - 0.15) / 2, -0.11);
  scene.add(pole);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.035, 48), white);
  base.position.set(0, FLOOR_Y + 0.017, -0.11);
  scene.add(base);
  // guard: wires as line segments, rims as thin tori
  const wire = new THREE.LineBasicMaterial({ color: '#c8ccdd', transparent: true, opacity: 0.55 });
  const pts = [];
  const rearAt = (r) => -0.045 - 0.06 * (1 - r / GUARD_R) ** 1.5;
  const frontAt = (r) => 0.035 + 0.05 * (1 - (r / GUARD_R) ** 2);
  for (let k = 0; k < INFLOW.spokes; k++) {
    const a = 2 * Math.PI * k / INFLOW.spokes;
    const dir = (r) => [-Math.sin(a) * r, Math.cos(a) * r];
    for (let s = 0; s < 8; s++) {
      const r0 = 0.08 + (GUARD_R - 0.08) * s / 8, r1 = 0.08 + (GUARD_R - 0.08) * (s + 1) / 8;
      pts.push(...dir(r0), rearAt(r0), ...dir(r1), rearAt(r1));
    }
  }
  const front = 36;
  for (let k = 0; k < front; k++) {
    const a = 2 * Math.PI * (k + 0.5) / front;
    for (let s = 0; s < 8; s++) {
      // a gentle spiral: the front wires curl a little, as on many fans
      const r0 = 0.05 + (GUARD_R - 0.05) * s / 8, r1 = 0.05 + (GUARD_R - 0.05) * (s + 1) / 8;
      const a0 = a + 0.5 * (r0 / GUARD_R), a1 = a + 0.5 * (r1 / GUARD_R);
      pts.push(-Math.sin(a0) * r0, Math.cos(a0) * r0, frontAt(r0), -Math.sin(a1) * r1, Math.cos(a1) * r1, frontAt(r1));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(geo, wire));
  for (const [r, z] of [[GUARD_R, 0], [GUARD_R * 0.7, frontAt(GUARD_R * 0.7)], [GUARD_R * 0.7, rearAt(GUARD_R * 0.7)], [GUARD_R * 0.4, frontAt(GUARD_R * 0.4)]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r === GUARD_R ? 0.006 : 0.0015, 8, 96), white);
    ring.position.z = z;
    scene.add(ring);
  }
  const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 40), white);
  badge.rotation.x = Math.PI / 2;
  badge.position.z = frontAt(0.05) + 0.004;
  scene.add(badge);
}

function makeRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  return renderer;
}

function watchSize(container, renderer, camera) {
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();
}

// Stall margin -> colour: blue (far) .. yellow (close) .. red (stalled).
function marginColor(ratio, out) {
  if (ratio < 0.6) out.setHSL(0.57 - 0.05 * Math.max(0, ratio) / 0.6, 0.7, 0.62);
  else if (ratio < 1.0) out.setHSL(0.52 - 0.38 * (ratio - 0.6) / 0.4, 0.8, 0.58);
  else out.setHSL(Math.max(0, 0.06 - 0.06 * (ratio - 1) / 0.5), 0.9, 0.55);
  return out;
}

function create(container) {
  const renderer = makeRenderer(container);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#090a14');
  scene.fog = new THREE.Fog('#090a14', 4, 9);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 40);
  camera.position.set(0.95, 0.35, 1.25);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -0.12, 0);
  controls.minDistance = 0.4;
  controls.maxDistance = 5;
  controls.update();

  // moonlight through a window on the left, a warm night lamp behind on the right
  scene.add(new THREE.HemisphereLight('#9fb4ff', '#1a1420', 0.7));
  const moon = new THREE.DirectionalLight('#b8c8ff', 2.0);
  moon.position.set(-3, 3, 2);
  scene.add(moon);
  const lamp = new THREE.PointLight('#ffb070', 3.0, 6, 1.5);
  lamp.position.set(1.4, 0.2, -1.2);
  scene.add(lamp);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ color: '#2a2018', roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  scene.add(floor);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), new THREE.MeshStandardMaterial({ color: '#1b1d33', roughness: 0.95 }));
  wall.position.set(0, FLOOR_Y + 2.5, -1.8);
  scene.add(wall);
  buildBody(scene);

  const holder = new THREE.Group();   // turns the rotor frame: local x -> world +z
  holder.rotation.y = -Math.PI / 2;
  scene.add(holder);
  const rotor = new THREE.Group();
  holder.add(rotor);
  const bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.05, side: THREE.DoubleSide,
    transparent: true, opacity: 0.85 });
  const hubMat = new THREE.MeshStandardMaterial({ color: '#e6e8f2', roughness: 0.35, metalness: 0.1 });

  // air particles
  const pos = new Float32Array(AIR_PARTICLES * 3).fill(1e4);
  const airGeo = new THREE.BufferGeometry();
  airGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(airGeo, new THREE.PointsMaterial({ size: 0.006, color: '#a8e4ff', transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending })));
  const air = Array.from({ length: AIR_PARTICLES }, () => ({ z: 0, rd: 0, ang: 0 }));

  let genome = null, analysis = null, blades = [], stations = [], stripOf = [], R = 0.2;

  function build(g, a) {
    clearGroup(rotor);
    genome = g;
    analysis = a;
    blades = [];
    if (!g) return;
    R = fanDiameter(g) / 2;
    const built = buildRotor(g, rotor, { blade: bladeMat, hub: hubMat });
    blades = built.blades;
    blades.forEach((b, k) => { b.userData.angle = built.angles[k]; });
    stations = built.stations;
    stripOf = [];
    if (a.blows) {
      const strips = a.prep.strips;
      for (const s of stations) {
        let best = 0;
        strips.forEach((st, j) => { if (Math.abs(st.x - s.x) < Math.abs(strips[best].x - s.x)) best = j; });
        stripOf.push(best);
      }
    }
    air.forEach((p) => respawn(p, true));
  }

  const P = NOISE.positions;
  const positionIndex = (ang) => {
    const t = ang / (2 * Math.PI);
    return ((Math.round((t - Math.floor(t)) * P) % P) + P) % P;
  };

  function paint(psi) {
    const c = new THREE.Color();
    const strips = analysis.prep.strips;
    for (const mesh of blades) {
      const col = mesh.geometry.attributes.color.array;
      stations.forEach((s, i) => {
        const st = strips[stripOf[i]];
        const alpha = st.alpha[positionIndex(mesh.userData.angle + psi - s.sweep)];
        const ratio = alpha >= 0 ? alpha / st.stallUp : alpha / st.stallDown;
        marginColor(ratio, c);
        for (let m = 0; m < SECTION; m++) {
          const v = 3 * (i * SECTION + m);
          col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b;
        }
      });
      mesh.geometry.attributes.color.needsUpdate = true;
    }
  }

  // AIR. Every particle keeps its radius at the disc rd; upstream the stream tube is wider and slower,
  // downstream it narrows to rd/√2 and speeds up to 2w, swirling at 2b·Ω, then the jet slowly spreads.
  function respawn(p, anywhere) {
    p.z = anywhere ? -0.6 + Math.random() * 2.6 : -0.6;
    const h = FAN.hubRatio;
    p.rd = R * Math.sqrt(h * h + (1 - h * h) * Math.random());
    p.ang = Math.random() * 2 * Math.PI;
  }
  function stripAt(rd) {
    const x = rd / R;
    return analysis.op.elements.reduce((b, e) => (Math.abs(e.x - x) < Math.abs(b.x - x) ? e : b));
  }
  function moveAir(dt, s) {
    const n = analysis.n * s;
    for (let i = 0; i < AIR_PARTICLES; i++) {
      const p = air[i];
      const e = stripAt(p.rd);
      const w = e.w * s, L = 0.12;
      let v, r, spin = 0;
      if (p.z < 0) {
        const k = Math.exp(p.z / L);
        v = w * (0.25 + 0.75 * k);
        r = p.rd * (1 + 0.8 * (1 - k));
      } else {
        const k = 1 - Math.exp(-p.z / L);
        v = w * (1 + k) / (1 + 0.15 * p.z);
        r = p.rd * (1 - 0.29 * k) * (1 + 0.12 * p.z / R * 0.2);
        spin = 2 * e.b * 2 * Math.PI * n * Math.exp(-p.z / 1.5);
      }
      p.z += v * dt;
      p.ang += spin * dt;
      if (p.z > 2.0) respawn(p, false);
      pos[3 * i] = -Math.sin(p.ang) * r; pos[3 * i + 1] = Math.cos(p.ang) * r; pos[3 * i + 2] = p.z;
    }
    airGeo.attributes.position.needsUpdate = true;
  }

  watchSize(container, renderer, camera);

  return {
    setFan(g, a) { build(g, a); },
    // live: { psi (rotation, rad), dt (model seconds of this frame), s (speed scale) }
    render(live) {
      if (genome && live && analysis && analysis.blows) {
        rotor.rotation.x = live.psi;
        paint(live.psi);
        moveAir(Math.min(0.05, live.dt), live.s);
      }
      controls.update();
      renderer.render(scene, camera);
    },
  };
}

// STATIC VIEW: the rotor alone, in clear blue plastic, standing still; the mouse turns the camera.
function createStatic(container) {
  const renderer = makeRenderer(container);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0e1022');
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight('#e4ecff', '#20182a', 1.1));
  const key = new THREE.DirectionalLight('#ffffff', 2.4);
  key.position.set(1.5, 2, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight('#8fc8ff', 1.0);
  fill.position.set(-2, 0.5, -1.5);
  scene.add(fill);
  const plastic = new THREE.MeshPhysicalMaterial({ color: '#5fb4ff', roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1,
    transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false });
  const hubMat = new THREE.MeshStandardMaterial({ color: '#f0f2f8', roughness: 0.3 });
  const holder = new THREE.Group();
  holder.rotation.y = -Math.PI / 2;
  scene.add(holder);
  const rotor = new THREE.Group();
  holder.add(rotor);
  let fitted = false;

  function build(g) {
    clearGroup(rotor);
    if (!g) return;
    buildRotor(g, rotor, { blade: plastic, hub: hubMat });
    const R = fanDiameter(g) / 2;
    const dist = 4.6 * R + 0.15;
    if (!fitted) {
      fitted = true;
      camera.position.set(0.55 * dist, 0.42 * dist, 0.72 * dist);
      controls.target.set(0, 0, 0);
    } else {
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, dist);
    }
    controls.minDistance = R * 1.5;
    controls.maxDistance = R * 10;
    controls.update();
  }

  watchSize(container, renderer, camera);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  return {
    setFan(g) { build(g); },
    resetView() { fitted = false; },
  };
}

window.View3D = { create, createStatic };
window.dispatchEvent(new Event('view3d-ready'));
