// 3D VIEW of the running storm (three.js). Nothing here affects evolution.
//
// One unit = one metre; three's x = along the shore, three's z = towards the land, y = up.
// Heights are exaggerated (VERTICAL x): the bay is 240 m wide, the waves are only a few metres high.
// The water is the same grid as the model, drawn SUB times finer with bilinear interpolation
// (the model itself runs on 4 m cells, exactly as in the evaluation).
//
// This is an ES module (three.js is one). The classic scripts find it as window.View3D.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const SUB = 3;

function create(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1426');
  scene.fog = new THREE.Fog('#0b1426', 350, 700);
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);
  camera.position.set(-80, 120, -125);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -6, 18);
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();

  scene.add(new THREE.HemisphereLight('#bcd4ff', '#3a3020', 0.9));
  const sun = new THREE.DirectionalLight('#fff3e0', 1.5);
  sun.position.set(-120, 200, -60);
  scene.add(sun);

  let view = { vertical: 2 };
  let sim = null, parts = null;

  // ---- building the scene for one simulation ----
  function clear() {
    if (!parts) return;
    for (const m of parts.meshes) {
      scene.remove(m);
      m.geometry.dispose();
      if (m.material.dispose) m.material.dispose();
    }
    parts = null;
  }

  function gridGeometry(nxv, nyv) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nxv * nyv * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nxv * nyv * 3), 3));
    const index = [];
    for (let j = 0; j < nyv - 1; j++) {
      for (let i = 0; i < nxv - 1; i++) {
        const a = j * nxv + i, b = a + 1, c = a + nxv, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    g.setIndex(index);
    return g;
  }

  function build(newSim) {
    clear();
    sim = newSim;
    if (!sim) return;
    const { nx, dx, world } = sim;
    const rows = world.wallRow;                       // water and sea bed: rows in front of the wall
    const nxv = (nx - 1) * SUB + 1, nyv = (rows - 1) * SUB + 1;
    const X = (fi) => (fi + 0.5) * dx - WORLD.LX / 2;  // fractional cell index -> metres
    const Z = (fj) => (fj + 0.5) * dx - WORLD.LY / 2;
    const meshes = [];

    // Sea bed (the bare coast; structures are separate boxes).
    const bed = gridGeometry(nxv, nyv);
    const bare = makeWorld(dx).z;
    {
      const pos = bed.attributes.position.array, col = bed.attributes.color.array;
      for (let vj = 0; vj < nyv; vj++) {
        for (let vi = 0; vi < nxv; vi++) {
          const v = vj * nxv + vi, fj = vj / SUB, fi = vi / SUB;
          const zb = bare[Math.round(fj) * nx + Math.round(fi)];
          pos[3 * v] = X(fi); pos[3 * v + 1] = zb * view.vertical; pos[3 * v + 2] = Z(fj);
          const t = Math.max(0, Math.min(1, (zb + 8) / 10)); // deep bed dark, shallow bed sandy
          col[3 * v] = 0.12 + 0.6 * t * t; col[3 * v + 1] = 0.14 + 0.5 * t * t; col[3 * v + 2] = 0.18 + 0.28 * t * t;
        }
      }
      bed.computeVertexNormals();
    }
    meshes.push(new THREE.Mesh(bed, new THREE.MeshLambertMaterial({ vertexColors: true })));

    // Water surface.
    const water = gridGeometry(nxv, nyv);
    const waterMesh = new THREE.Mesh(water, new THREE.MeshPhongMaterial({
      vertexColors: true, transparent: true, opacity: 0.78, shininess: 90, specular: new THREE.Color('#9fb8ff'),
    }));
    meshes.push(waterMesh);

    // Wall and promenade: one box per column, the promenade coloured by the overtopping.
    const box = new THREE.BoxGeometry(1, 1, 1);
    const wallTop = WORLD.WALL_CREST, wallFoot = bare[(rows - 1) * nx];
    const wall = new THREE.Mesh(box.clone(), new THREE.MeshLambertMaterial({ color: '#d9dce4' }));
    wall.scale.set(WORLD.LX, (wallTop - wallFoot) * view.vertical, dx);
    wall.position.set(0, (wallTop + wallFoot) / 2 * view.vertical, Z(rows));
    meshes.push(wall);
    const promDepth = WORLD.LY - (rows + 1) * dx;
    const promenade = new THREE.InstancedMesh(box.clone(), new THREE.MeshLambertMaterial(), nx);
    const m = new THREE.Matrix4();
    for (let i = 0; i < nx; i++) {
      m.makeScale(dx, (WORLD.PROMENADE_Z + 2) * view.vertical, promDepth);
      m.setPosition(X(i), (WORLD.PROMENADE_Z - 2) / 2 * view.vertical, (rows + 1) * dx + promDepth / 2 - WORLD.LY / 2);
      promenade.setMatrixAt(i, m);
      promenade.setColorAt(i, new THREE.Color('#6d7486'));
    }
    meshes.push(promenade);

    // Rocky headlands at both sides of the bay (the reflecting side walls of the model)
    // and a dark cut through the sea at the open boundary.
    const rock = new THREE.MeshLambertMaterial({ color: '#5b5247' });
    for (const side of [-1, 1]) {
      const head = new THREE.Mesh(box.clone(), rock);
      head.scale.set(10, (WORLD.WALL_CREST + 2 + WORLD.SEA_DEPTH + 1) * view.vertical, rows * dx + dx);
      head.position.set(side * (WORLD.LX / 2 + 5), (WORLD.WALL_CREST + 2 - WORLD.SEA_DEPTH - 1) / 2 * view.vertical, Z(rows / 2 - 0.5));
      meshes.push(head);
    }
    const cut = new THREE.Mesh(box.clone(), new THREE.MeshLambertMaterial({ color: '#0d2340' }));
    cut.scale.set(WORLD.LX, (WORLD.SEA_DEPTH + 1 + sim.storm.surge) * view.vertical, 0.5);
    cut.position.set(0, (sim.storm.surge - WORLD.SEA_DEPTH - 1) / 2 * view.vertical, Z(0) - 0.3);
    meshes.push(cut);

    // Blocks of the structures.
    const b = sim.blocks;
    let blocks = null;
    if (b && b.cells.length) {
      blocks = new THREE.InstancedMesh(box.clone(), new THREE.MeshLambertMaterial(), b.cells.length);
      meshes.push(blocks);
    }

    // Spray over the wall.
    const SPRAY = 1500;
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPRAY * 3), 3));
    const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({ color: '#eef6ff', size: 1.6, transparent: true, opacity: 0.85 }));
    meshes.push(spray);
    const sprayState = { v: new Float32Array(SPRAY * 3), life: new Float32Array(SPRAY), next: 0 };

    for (const mesh of meshes) scene.add(mesh);
    parts = { meshes, water, waterMesh, nxv, nyv, X, Z, promenade, blocks, spray, sprayGeo, sprayState, rows };
    update(0);
  }

  // ---- every frame ----
  const tmpColor = new THREE.Color(), FOAM = new THREE.Color(0.93, 0.96, 1), RED = new THREE.Color('#ff4030');
  function bilinear(field, fi, fj, nx) {
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, parts.rows - 1);
    const ti = fi - i0, tj = fj - j0;
    return (field[j0 * nx + i0] * (1 - ti) + field[j0 * nx + i1] * ti) * (1 - tj) +
      (field[j1 * nx + i0] * (1 - ti) + field[j1 * nx + i1] * ti) * tj;
  }

  function update(frameDt) {
    if (!sim || !parts) return;
    const { nx, dx, eta, z } = sim;
    const surge = sim.storm.surge, V = view.vertical;
    const { water, nxv, nyv, X, Z } = parts;
    const pos = water.attributes.position.array, col = water.attributes.color.array;
    const depth = parts.depth || (parts.depth = new Float64Array(nx * parts.rows));
    for (let c = 0; c < nx * parts.rows; c++) depth[c] = eta[c] - z[c];
    for (let vj = 0; vj < nyv; vj++) {
      for (let vi = 0; vi < nxv; vi++) {
        const v = vj * nxv + vi, fi = vi / SUB, fj = vj / SUB;
        const e = bilinear(eta, fi, fj, nx), d = bilinear(depth, fi, fj, nx);
        const wet = d > 0.05;
        pos[3 * v] = X(fi);
        pos[3 * v + 1] = (wet ? e : e - 1.5) * V;
        pos[3 * v + 2] = Z(fj);
        // Colour: deep blue in the troughs, light on the crests, white foam on steep fronts and in the shallows.
        const a = Math.max(0, Math.min(1, (e - surge + 2.5) / 5));
        const ec = eta[Math.min(parts.rows - 1, Math.round(fj)) * nx + Math.min(nx - 1, Math.round(fi))];
        const en = eta[Math.max(0, Math.round(fj) - 1) * nx + Math.min(nx - 1, Math.round(fi))];
        const foam = Math.max(0, Math.min(1, (Math.abs(ec - en) - 0.4) / 0.8 + (d < 0.8 && wet ? 0.3 : 0)));
        tmpColor.setRGB(0.02 + 0.2 * a, 0.1 + 0.35 * a, 0.28 + 0.4 * a);
        tmpColor.lerp(FOAM, foam);
        col[3 * v] = tmpColor.r; col[3 * v + 1] = tmpColor.g; col[3 * v + 2] = tmpColor.b;
      }
    }
    water.attributes.position.needsUpdate = true;
    water.attributes.color.needsUpdate = true;
    water.computeVertexNormals();

    // Blocks: height from the bed to the current top, red where blocks were washed away.
    const b = sim.blocks, m = new THREE.Matrix4();
    if (parts.blocks) {
      for (let k = 0; k < b.cells.length; k++) {
        const c = b.cells[k], j = Math.floor(c / nx), i = c - j * nx;
        const top = z[c], base = b.zBase[k];
        const hgt = Math.max(0.01, top - base);
        m.makeScale(dx * 0.96, hgt * V, dx * 0.96);
        m.setPosition(X(i), (top + base) / 2 * V, Z(j));
        parts.blocks.setMatrixAt(k, m);
        const lost = (b.zTop[k] - top) / Math.max(0.01, b.zTop[k] - base);
        tmpColor.set(BLOCKS[b.type[k]].color).lerp(RED, Math.min(1, lost * 2.5));
        parts.blocks.setColorAt(k, tmpColor);
      }
      parts.blocks.instanceMatrix.needsUpdate = true;
      parts.blocks.instanceColor.needsUpdate = true;
    }

    // Promenade colour: overtopping so far; spray where a wave hits the wall now.
    const o = sim.toeSamples > 0 ? sim.overtopping() : null;
    const wallFront = (parts.rows - 1) * nx;
    const sp = parts.sprayState, spPos = parts.sprayGeo.attributes.position.array;
    const Rc = WORLD.WALL_CREST - surge;
    for (let i = 0; i < nx; i++) {
      const q = o ? o.q[i] * 1000 : 0;
      tmpColor.set(q > 0.05 ? overtopColor(q) : '#6d7486');
      parts.promenade.setColorAt(i, tmpColor);
      // Emit spray: the higher the wave at the wall and the bigger q, the more.
      const rise = (eta[wallFront + i] - surge) / Rc;
      const n = rise > 0.35 ? Math.min(6, Math.round(frameDt * 60 * (rise * 2 + Math.log10(1 + q)))) : 0;
      for (let k = 0; k < n; k++) {
        const p = sp.next; sp.next = (sp.next + 1) % sp.life.length;
        spPos[3 * p] = X(i) + (Math.random() - 0.5) * dx;
        spPos[3 * p + 1] = WORLD.WALL_CREST * V;
        spPos[3 * p + 2] = Z(parts.rows) - dx / 2;
        sp.v[3 * p] = (Math.random() - 0.5) * 3;
        sp.v[3 * p + 1] = (4 + 10 * Math.random()) * Math.min(1.5, rise) * V;
        sp.v[3 * p + 2] = 2 + 6 * Math.random();
        sp.life[p] = 1.4;
      }
    }
    parts.promenade.instanceColor.needsUpdate = true;
    for (let p = 0; p < sp.life.length; p++) {
      if (sp.life[p] <= 0) { spPos[3 * p + 1] = -1000; continue; }
      sp.life[p] -= frameDt;
      sp.v[3 * p + 1] -= 9.81 * V * frameDt;
      for (let a = 0; a < 3; a++) spPos[3 * p + a] += sp.v[3 * p + a] * frameDt;
    }
    parts.sprayGeo.attributes.position.needsUpdate = true;
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
    setSim(newSim) { build(newSim); },
    setVertical(v) { view.vertical = v; build(sim); },
    render(frameDt) {
      update(frameDt);
      controls.update();
      renderer.render(scene, camera);
    },
  };
}

window.View3D = { create };
window.dispatchEvent(new Event('view3d-ready'));
