// 3D view (three.js): replays a structure step by step with the same Trial the evaluation uses.
// The view only reads body positions from Rapier; it never changes the simulation,
// so the replayed height equals the score the worker computed.
//
// Construction: each new stone falls in from above over a few frames (a visual effect only),
// with scaffolding a wooden post holds it until the release. The construction takes about
// BUILD_FRAMES frames whatever the number of stones (several stones per frame for big ones).
// Tests run in real time at 1x.
// All stones are one InstancedMesh of a box scaled to each stone's size (one draw call for 2000
// stones); the ±4 mm corner errors of the real collider are not drawn.
// A gravity tilt is shown by tilting the whole scene the other way, so "down" stays down on screen.

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { Trial, GATE_HEIGHT, GATE_DEPTH, PIT_DEPTH } from './physics.js';

const DROP_FRAMES = 6;
const BUILD_FRAMES = 480;
const DROP_HEIGHT = 0.4;
const PHASE_NAMES = {
  settle: 'оседание',
  tilt: 'наклон',
  turn: 'наклон',
  hold: 'наклон',
  untilt: 'возврат',
  rest: 'покой',
};

export class StructureView {
  constructor(canvas, label, R) {
    this.canvas = canvas;
    this.label = label;
    this.R = R;
    this.speed = 4;            // physics steps per frame during the tests
    this.trial = null;
    this.iter = null;
    this.stones = [];          // [{dropFrames}] parallel to trial.items
    this.stoneMesh = null;     // InstancedMesh of all stones, recreated when more are needed
    this.postMesh = null;      // InstancedMesh of the scaffolding posts
    this.capacity = 0;
    this.buildBudget = 0;      // stones that may be placed this frame (fractional)
    this.onDone = null;
    this.finished = true;
    this.building = false;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070f);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    this.camera.position.set(3, 2, 3);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.5, 0);
    this.controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3020, 1.2));
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
    sun.position.set(3, 6, 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -5; sc.right = 5; sc.top = 6; sc.bottom = -1; sc.near = 0.5; sc.far = 25;
    this.sun = sun;
    scene.add(sun);

    // Everything that tilts during the test lives in `world`.
    this.world = new THREE.Group();
    scene.add(this.world);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(8, 64),
      new THREE.MeshStandardMaterial({ color: 0x2a3148, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.world.add(ground);
    const grid = new THREE.GridHelper(10, 20, 0x3b4668, 0x3b4668);  // 0.5 m cells
    grid.position.y = 0.001;
    this.world.add(grid);
    this.groundMesh = ground;
    this.gridMesh = grid;
    // Pedestal mode: the pedestal stands in a pit; the ground and the grid go down to the pit's floor.
    this.pedestalMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x59617d, roughness: 1 }));
    this.pedestalMesh.receiveShadow = this.pedestalMesh.castShadow = true;
    this.pedestalMesh.visible = false;
    this.world.add(this.pedestalMesh);

    // Height marker: a thin translucent disc at the final height.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.32, 48),
      new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    this.world.add(this.marker);

    this.box = new THREE.BoxGeometry(1, 1, 1);
    // Gate mode: the passage (blue, stays) and its centering (wood, goes with the scaffolding).
    this.passage = new THREE.Mesh(this.box, new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true,
      opacity: 0.18, depthWrite: false }));
    this.centeringMesh = new THREE.Mesh(this.box, new THREE.MeshStandardMaterial({ color: 0x9a6b3c, transparent: true,
      opacity: 0.45 }));
    // Round centering: a half-cylinder along z (a cylinder of radius 1 and length 1, scaled).
    this.archMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32, 1, false, -Math.PI / 2, Math.PI),
      this.centeringMesh.material);
    this.archMesh.rotation.x = Math.PI / 2;
    this.passage.visible = this.centeringMesh.visible = this.archMesh.visible = false;
    this.world.add(this.passage, this.centeringMesh, this.archMesh);
    this.stoneMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    this.postMaterial = new THREE.MeshStandardMaterial({ color: 0x9a6b3c, transparent: true, opacity: 0.55 });
    this.tmp = { m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(),
      c: new THREE.Color() };
    this.tiltTarget = new THREE.Quaternion();

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Makes room for n stones (and posts).
  ensureCapacity(n) {
    if (n <= this.capacity) return;
    for (const m of [this.stoneMesh, this.postMesh]) if (m) { this.world.remove(m); m.dispose(); }
    this.capacity = n;
    this.stoneMesh = new THREE.InstancedMesh(this.box, this.stoneMaterial, n);
    this.stoneMesh.castShadow = true;
    this.stoneMesh.receiveShadow = true;
    this.stoneMesh.frustumCulled = false;
    this.postMesh = new THREE.InstancedMesh(this.box, this.postMaterial, n);
    this.postMesh.frustumCulled = false;
    this.world.add(this.stoneMesh, this.postMesh);
  }

  clear() {
    this.stones = [];
    if (this.stoneMesh) { this.stoneMesh.count = 0; this.postMesh.count = 0; this.postMesh.visible = true; }
    if (this.trial) this.trial.free();
    this.trial = null;
    this.iter = null;
    this.marker.visible = false;
  }

  // Starts a replay. expectedHeight frames the camera; onDone(result) is called at the end.
  show(quarry, genome, opts, expectedHeight, onDone) {
    this.clear();
    this.opts = opts;
    this.trial = new Trial(this.R, quarry, genome, opts);
    this.iter = this.trial.run();
    this.ensureCapacity(quarry.length);
    const ped = opts.pedestal || 0;
    this.pedestalMesh.visible = ped > 0;
    this.pedestalMesh.scale.set(2 * ped, PIT_DEPTH, 2 * ped);
    this.pedestalMesh.position.y = -PIT_DEPTH / 2;
    this.groundMesh.position.y = ped ? -PIT_DEPTH : 0;
    this.gridMesh.position.y = (ped ? -PIT_DEPTH : 0) + 0.001;
    const gw = opts.gateWidth || 0;
    for (const m of [this.passage, this.centeringMesh]) {
      m.scale.set(gw, GATE_HEIGHT, GATE_DEPTH);
      m.position.set(0, GATE_HEIGHT / 2, 0);
    }
    this.passage.visible = gw > 0 && !opts.gateArch;
    this.centeringMesh.visible = gw > 0 && opts.scaffold && !opts.gateArch;
    this.archMesh.visible = gw > 0 && opts.scaffold && !!opts.gateArch;
    this.archMesh.scale.set(gw / 2, GATE_DEPTH, gw / 2);
    // Stones per frame while building: the construction takes about BUILD_FRAMES frames.
    this.buildRate = Math.max(1 / DROP_FRAMES, this.trial.plan.length / BUILD_FRAMES);
    this.buildBudget = 0;
    this.onDone = onDone;
    this.finished = false;
    this.building = true;
    this.world.quaternion.identity();
    this.tiltTarget.identity();
    this.frame(expectedHeight);
    this.setLabel('стройка');
  }

  frame(height) {
    const h = Math.max(0.6, height || 1);
    this.controls.target.set(0, h * 0.45, 0);
    const d = Math.max(2.2, h * 2.1);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.15) dir.set(1, 0.5, 1).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, d);
    this.sun.shadow.camera.top = h + 1;
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  setLabel(text) { this.label.textContent = text; }

  addStone(item) {
    const i = this.stones.length;
    const { m, p, q, s, c } = this.tmp;
    this.stoneMesh.setColorAt(i, c.setRGB(...item.stone.color));
    this.stoneMesh.instanceColor.needsUpdate = true;
    // A post from the ground to the stone's centre: the scaffolding that holds it (none for low stones).
    const len = this.opts.scaffold && item.placedY > 0.12 ? item.placedY : 0;
    p.set(item.body.translation().x, len / 2, item.body.translation().z);
    m.compose(p, q.identity(), s.set(len ? 0.025 : 0, len, len ? 0.025 : 0));
    this.postMesh.setMatrixAt(i, m);
    this.postMesh.count = i + 1;
    this.postMesh.instanceMatrix.needsUpdate = true;
    // Big structures are built several stones per frame: no time for the falling-in effect. In stacking mode
    // a brick is set on its parent, not lowered - no falling-in either.
    this.stones.push({ dropFrames: this.buildRate < 1 && !this.opts.stack ? DROP_FRAMES : 0 });
  }

  syncMeshes() {
    const { m, p, q, s } = this.tmp;
    this.trial.items.forEach((it, i) => {
      const st = this.stones[i];
      const t = it.body.translation();
      const r = it.body.rotation();
      const lift = st.dropFrames > 0 ? DROP_HEIGHT * (st.dropFrames / DROP_FRAMES) ** 2 : 0;
      m.compose(p.set(t.x, t.y + lift, t.z), q.set(r.x, r.y, r.z, r.w), s.set(...it.stone.size));
      this.stoneMesh.setMatrixAt(i, m);
      if (st.dropFrames > 0) st.dropFrames--;
    });
    this.stoneMesh.count = this.trial.items.length;
    this.stoneMesh.instanceMatrix.needsUpdate = true;
  }

  // Advances the replay by one animation frame.
  advance() {
    if (!this.iter || this.finished) return;
    // Construction: run the bedding steps up to the next stone, buildRate stones per frame.
    if (this.building) {
      this.buildBudget += this.buildRate;
      while (this.buildBudget >= 1) {
        this.buildBudget -= 1;
        for (;;) {
          const r = this.iter.next();
          if (r.done) return this.finish(r.value);
          const ev = r.value;
          if (ev.phase === 'place') {
            this.addStone(this.trial.items[ev.index]);
            this.setLabel(`стройка: камень ${ev.index + 1} из ${this.trial.plan.length}`);
            break;
          }
          if (ev.phase === 'remove') {
            // Stacking without scaffolding: the last brick did not stay and was taken away.
            this.stones.pop();
            continue;
          }
          if (ev.phase === 'release') {
            this.postMesh.visible = false;
            this.centeringMesh.visible = this.archMesh.visible = false;
            this.building = false;
            this.setLabel('леса убраны');
            return;
          }
          if (ev.phase !== 'build') {
            this.building = false;
            this.onTestEvent(ev);
            return;
          }
        }
      }
      return;
    }
    for (let i = 0; i < this.speed; i++) {
      const r = this.iter.next();
      if (r.done) return this.finish(r.value);
      this.onTestEvent(r.value);
    }
  }

  onTestEvent(ev) {
    if (!PHASE_NAMES[ev.phase]) return;
    // Rotate the scene so that the tilted gravity points straight down on screen.
    const g = this.trial.world.gravity;
    const deg = Math.atan2(Math.hypot(g.x, g.z), -g.y) * 180 / Math.PI;
    const dir = (Math.atan2(g.z, g.x) * 180 / Math.PI + 360) % 360;
    const tilt = deg > 0.05 ? ` ${deg.toFixed(1)}°, направление ${dir.toFixed(0)}°` : '';
    this.setLabel(`испытание: ${PHASE_NAMES[ev.phase]}${tilt}`);
    const gv = new THREE.Vector3(g.x, g.y, g.z).normalize();
    this.tiltTarget.setFromUnitVectors(gv, new THREE.Vector3(0, -1, 0));
  }

  finish(result) {
    this.finished = true;
    // Aim the camera at the highest stone (keeping the viewing offset): the tower may stand off-centre.
    // Step back far enough for the whole structure: wide piles of 1000+ stones, not only tall towers.
    let top = null;
    const pos = this.trial.items.map((it) => it.body.translation());
    for (const t of pos) if (!top || t.y > top.y) top = t;
    if (top) {
      // 90th percentile of the distances: a few stones rolled far away should not shrink the picture.
      const dist = pos.map((t) => Math.hypot(t.x - top.x, t.z - top.z)).sort((x, y) => x - y);
      const radius = dist[Math.floor(0.9 * (dist.length - 1))];
      const target = new THREE.Vector3(top.x, result.height * 0.45, top.z);
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      const d = Math.max(2.2, result.height * 2.1, radius * 2);
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, d);
    }
    this.marker.position.set(top ? top.x : 0, result.height, top ? top.z : 0);
    this.marker.visible = true;
    this.setLabel(`итог: ${result.height.toFixed(2)} м`);
    if (this.onDone) this.onDone(result);
  }

  // Called every animation frame by the app.
  render() {
    this.advance();
    if (this.trial) this.syncMeshes();
    this.world.quaternion.slerp(this.tiltTarget, 0.15);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
