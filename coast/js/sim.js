'use strict';
// WAVE MODEL: a strip of coast seen from above, waves come from the sea and run up the beach.
//
// Coordinates (metres): x along the shore (0..LX), y from the open sea to the land (0..LY),
// z up, 0 = still water level. The grid has square cells of size dx.
//
//   y = 0      open sea, depth SEA_DEPTH; waves are generated here
//   ...        sea bed rises linearly to the shoreline (z = 0 at SHORE_Y)
//   WALL_Y     the promenade wall: one row of cells with the crest at WALL_CREST
//   behind     the promenade (PROMENADE_Z); water that gets here has OVERTOPPED the wall
//   x = 0, LX  rocky headlands: solid side walls that reflect waves
//
// Physics: nonlinear shallow-water equations (water is a thin layer, pressure is hydrostatic):
//   dh/dt + div(h u) = 0                                   - mass
//   du/dt + (u . grad) u = -g grad(eta) - friction         - momentum
// h = eta - z is the depth, eta the water surface, u the depth-averaged velocity.
// Breaking needs no extra model: a steep wave turns into a bore (a moving step of water).
// Limitation: no dispersion. Real short waves travel slower than shallow-water waves and do not
// steepen as fast; here every wave behaves like a long wave. Good enough for teaching, not for design.
//
// Numerics (in the spirit of Stelling & Duinmeijer 2003, simplified):
//   - staggered grid: eta in cell centres, u on x-faces, v on y-faces;
//   - depth on a face is taken from the upstream cell (upwind), the face bed is the higher of the two:
//     this keeps water from flowing out of a dry cell and lets flow go over the wall crest correctly;
//   - first-order upwind advection, semi-implicit Manning friction (h^(4/3) from a table: Math.cbrt
//     on every face was the slowest part of the model);
//   - outflow of a cell is limited to the water it has, so depths never go negative;
//   - open sea boundary: Flather condition. It lets the incident wave in and the reflected wave out;
//   - the last row of the promenade is a drain: overtopped water leaves and does not flow back.
//
// OVERTOPPING. A 4 m grid cannot resolve the jet that shoots up a vertical wall, so water hardly
// ever pours over the crest in the model itself (we tried: zero even for a low wall in a big storm).
// So we do what coastal engineers do: the wave model gives the waves at the TOE of the wall,
// empirical formulas give the overtopping, q in m3/s per metre of wall (EurOtop 2018, chapter 7):
//   non-impulsive (deep toe):  q = 0.047 * sqrt(g Hm0^3) * exp(-(2.35 Rc / Hm0)^1.3)
//   impulsive (shallow toe, h^2 / (Hm0 L) < 0.23 - waves break ON the wall), the larger of that and
//     Rc/Hm0 < 1.35:  q = 0.011  * sqrt(g Hm0^3) * sqrt(Hm0 / (h s)) * exp(-2.2 Rc / Hm0)
//     Rc/Hm0 > 1.35:  q = 0.0014 * sqrt(g Hm0^3) * sqrt(Hm0 / (h s)) * (Rc / Hm0)^-3
// Rc - freeboard (crest above the storm water level), h - depth at the toe, L - deep-water wave length,
// s = Hm0 / L - wave steepness. Hm0 = 4 * std of the INCIDENT surface at the toe, at most
// BREAKING x depth (the usual depth-limited breaking rule; the model alone overshoots it). The depth is the
// mean over FORESHORE metres in front of the toe: a broken wave does not lose its height at once.
// The wall reflects waves, and right in front of it incident and reflected waves add up; the
// shallow-water split eta_in = (eta + q/c) / 2 (q - landward flux, c = sqrt(g h)) keeps only the incident part.
// Toe of a column = the cell nearest to the wall with at least TOE_DEPTH of water at the storm level.
// A mound piled against the wall moves the toe seaward, into bigger waves. But waves then break and
// run up a rough slope of blocks, not a smooth wall, so such a column uses the rubble-mound formula:
//   q = 0.09 * sqrt(g Hm0^3) * exp(-(1.5 Rc / (Hm0 gammaF))^1.3)
// gammaF - roughness of the blocks (rock 0.55, concrete armour units 0.4).
// Lesson learnt: with the non-impulsive formula alone, a cheap fill in front of the wall made the
// toe shallow, the waves small and the overtopping zero. Real waves on a shallow toe slam into the wall.
// Water that does pour over the crest in the model ("green water") is added on top.

const G = 9.81;

// h^(4/3) for the friction, every centimetre up to 30 m, linear in between (relative error < 1e-4
// except in films thinner than a few cm, where friction stops the water anyway). Used inline in step().
const POW43_STEP = 100, POW43 = Float64Array.from({ length: 3001 }, (_, k) => Math.pow(k / POW43_STEP, 4 / 3));

const WORLD = {
  LX: 240,            // m along the shore
  LY: 120,            // m from the open sea to the back of the promenade
  SEA_DEPTH: 8,       // m, depth at the sea boundary
  SHORE_Y: 130,       // m, where the sea bed would reach still water (behind the wall: the wall stands in the sea)
  WALL_Y: 96,         // m, seaward face of the wall (the wall is one cell thick)
  WALL_CREST: 4.5,    // m above still water
  PROMENADE_Z: 3.0,   // m above still water
  MANNING: 0.025,     // bed roughness
  H_MIN: 0.01,        // m, thinner water counts as dry
  TOE_DEPTH: 0.5,     // m of water at the storm level that makes a cell the toe of the wall
  FAIL_TIME: 0.5,     // s above the critical speed that washes out one layer of blocks
  BREAKING: 0.55,     // Hm0 at the toe cannot exceed this share of the water depth in front of it
  FORESHORE: 24,      // m in front of the toe over which that depth is averaged (~1/4 wave length)
  TURBULENCE: 1.3,    // near-bed speed in breaking waves / depth-averaged speed of the model
};

// The storm everybody is tested against (a once-in-100-years storm). Same seed -> the same waves for every design.
// Waves are measured at the toe from `measureFrom` seconds on: after the ramp and the travel to the wall.
const STORM = { surge: 1.5, Hs: 4.5, Tp: 9, dir: 0, spread: 15, components: 7, seed: 7, ramp: 15, measureFrom: 30, duration: 100 };
// A calm day: nothing should come over the wall.
const CALM = { surge: 0, Hs: 0.6, Tp: 7, dir: 0, spread: 10, components: 5, seed: 7, ramp: 10, measureFrom: 25, duration: 80 };

// The bare coast: bed level of every cell, no structures.
function makeWorld(dx) {
  const nx = Math.round(WORLD.LX / dx), ny = Math.round(WORLD.LY / dx);
  const z = new Float64Array(nx * ny);
  const wallRow = Math.floor(WORLD.WALL_Y / dx);
  const footZ = (WORLD.WALL_Y - WORLD.SHORE_Y) * WORLD.SEA_DEPTH / WORLD.SHORE_Y; // beach keeps the sea slope
  for (let j = 0; j < ny; j++) {
    const y = (j + 0.5) * dx;
    let zj;
    if (j < wallRow) zj = Math.min(footZ, -WORLD.SEA_DEPTH + y * WORLD.SEA_DEPTH / WORLD.SHORE_Y);
    else if (j === wallRow) zj = WORLD.WALL_CREST;
    else zj = WORLD.PROMENADE_Z;
    for (let i = 0; i < nx; i++) z[j * nx + i] = zj;
  }
  return { nx, ny, dx, z, wallRow };
}

// Irregular sea: a sum of sine waves around the peak period, with a little spread in direction.
// Amplitudes follow a simple peaked spectrum, scaled so that the significant height is Hs.
function makeWaves(storm, depth) {
  const rng = makeRng(storm.seed);
  const n = storm.components;
  const waves = [];
  let energy = 0;
  for (let k = 0; k < n; k++) {
    const T = storm.Tp * (0.7 + 0.6 * (k + rng.next()) / n);        // periods 0.7..1.3 Tp
    const f = 1 / T, fp = 1 / storm.Tp;
    const s = Math.pow(fp / f, 5) * Math.exp(-1.25 * Math.pow(fp / f, 4)); // Pierson-Moskowitz shape
    const omega = 2 * Math.PI / T;
    const dir = (storm.dir + storm.spread * (2 * rng.next() - 1)) * Math.PI / 180;
    const kWave = omega / Math.sqrt(G * depth);                     // long-wave dispersion, as in the model
    waves.push({ a: s, omega, kx: kWave * Math.sin(dir), phase: 2 * Math.PI * rng.next() });
    energy += s * s / 2;
  }
  const scale = storm.Hs / (4 * Math.sqrt(energy));                 // Hs = 4 sqrt(variance)
  for (const w of waves) w.a *= scale;
  return waves;
}

class WaveSim {
  // world: from makeWorld (z may already contain structures); storm: STORM or CALM.
  constructor(world, storm) {
    const { nx, ny, dx } = world;
    this.world = world;
    this.storm = storm;
    this.nx = nx; this.ny = ny; this.dx = dx;
    this.z = world.z.slice();                       // bed, may change when blocks are washed away
    this.eta = new Float64Array(nx * ny);
    this.u = new Float64Array((nx + 1) * ny);       // x-faces: face i of row j sits left of cell i
    this.v = new Float64Array(nx * (ny + 1));       // y-faces: face j of column i sits below cell row j
    this.qu = new Float64Array((nx + 1) * ny);      // fluxes h*u through the faces
    this.qv = new Float64Array(nx * (ny + 1));
    this.limit = new Float64Array(nx * ny);         // outflow scaling per cell (positivity)
    for (let c = 0; c < nx * ny; c++) this.eta[c] = Math.max(this.z[c], storm.surge);
    this.depth0 = WORLD.SEA_DEPTH + storm.surge;
    this.c0 = Math.sqrt(G * this.depth0);
    this.waves = makeWaves(storm, this.depth0);
    // Fixed time step from the fastest possible signal: deterministic and simple.
    // Courant number 0.75 of a generous speed bound (wave speed + 8 m/s of current). It was 0.45:
    // stable as well, but 1.6 times more steps; the overtopping changed by less than 10%.
    this.dt = 0.75 * dx / (Math.sqrt(G * (this.depth0 + storm.Hs)) + 8);
    this.t = 0;
    this.overtopped = 0;                            // m3 over the whole wall since the start
    this.overtopByColumn = new Float64Array(nx);    // m3 per cell column, for the picture
    this.maxSpeed = new Float64Array(nx * ny);      // largest speed next to each cell, for damage
    this.toeSum = new Float64Array(nx);             // incident surface at the toe: sum, sum of squares
    this.toeSq = new Float64Array(nx);
    this.toeSamples = 0;
    // Structures (from buildWorld in design.js): cells, block type, bed under the mound, crest.
    const b = world.blocks;
    this.blocks = b || null;
    this.washed = 0;                                     // m3 of blocks washed away
    if (b) {
      this.ucr = Float64Array.from(b.type, (t) => BLOCKS[t].ucr);
      this.layer = Float64Array.from(b.type, (t) => BLOCKS[t].D);
      this.overTime = new Float64Array(b.cells.length); // time above the critical speed so far
      this.blockAt = new Int32Array(nx * ny).fill(-1);  // cell -> index in b.cells
      b.cells.forEach((c, k) => { this.blockAt[c] = k; });
    }
    this.findToes();
  }

  // Blocks under water faster than their critical speed for FAIL_TIME lose their top layer.
  damage() {
    const b = this.blocks, { z, eta, dt, overTime, ucr, maxSpeed } = this;
    const hMin = WORLD.H_MIN, turbulence = WORLD.TURBULENCE, failTime = WORLD.FAIL_TIME;
    let changed = false;
    for (let k = 0; k < b.cells.length; k++) {
      const c = b.cells[k];
      if (z[c] <= b.zBase[k]) { overTime[k] = 0; continue; }
      const speed = turbulence * this.attackSpeed(c);
      if (speed > maxSpeed[c]) maxSpeed[c] = speed;
      if (speed <= ucr[k]) { overTime[k] = 0; continue; }
      overTime[k] += dt;
      if (overTime[k] < failTime) continue;
      overTime[k] = 0;
      const lower = Math.max(b.zBase[k], z[c] - this.layer[k]);
      this.washed += (z[c] - lower) * this.dx * this.dx;
      z[c] = lower;  // the water level stays: the hole fills with water
      changed = true;
    }
    if (changed) this.findToes();
  }

  // Toe cell of every column: the nearest to the wall with TOE_DEPTH of water at the storm level.
  // Blocks between the toe and the wall make the column a rubble mound (gammaF < 1).
  findToes() {
    const { nx, z } = this;
    this.toe = new Int32Array(nx).fill(-1);
    this.gammaF = new Float64Array(nx).fill(1);
    for (let i = 0; i < nx; i++) {
      for (let j = this.world.wallRow - 1; j >= 0; j--) {
        const c = j * nx + i;
        if (this.storm.surge - z[c] >= WORLD.TOE_DEPTH) { this.toe[i] = c; break; }
        const k = this.blockAt ? this.blockAt[c] : -1;
        if (k >= 0 && z[c] > this.blocks.zBase[k]) this.gammaF[i] = Math.min(this.gammaF[i], BLOCKS[this.blocks.type[k]].gammaF);
      }
    }
  }

  // Record the incident wave at the toe of every column (called once per step).
  measureToes() {
    const { nx, eta, z, v, toe } = this;
    const surge = this.storm.surge, hMin = WORLD.H_MIN, g = G, sqrt = Math.sqrt;
    for (let i = 0; i < nx; i++) {
      const c = toe[i];
      if (c < 0) continue;
      const h = eta[c] - z[c];
      const q = h > hMin ? 0.5 * (v[c] + v[c + nx]) * h : 0;
      const e = 0.5 * (eta[c] - surge + (h > hMin ? q / sqrt(g * h) : 0));
      this.toeSum[i] += e;
      this.toeSq[i] += e * e;
    }
    this.toeSamples++;
  }

  // Overtopping from the waves recorded so far. Returns per column Hm0 (m) and q (m3/s per m).
  overtopping() {
    const { nx } = this;
    const n = Math.max(1, this.toeSamples);
    const Rc = WORLD.WALL_CREST - this.storm.surge;
    const Tm = this.storm.Tp / 1.1;                    // spectral period T_m-1,0
    const L = G * Tm * Tm / (2 * Math.PI);             // deep-water wave length
    const Hm0 = new Float64Array(nx), q = new Float64Array(nx);
    let sum = 0;
    for (let i = 0; i < nx; i++) {
      const mean = this.toeSum[i] / n;
      const toeDepth = this.toe[i] >= 0 ? this.storm.surge - this.z[this.toe[i]] : 0;
      // Depth-limited: waves higher than BREAKING x depth have already broken. A broken wave (a bore)
      // keeps its height for a while, so the depth is averaged over FORESHORE metres in front of the toe.
      let foreshore = 0, cells = 0;
      for (let c = this.toe[i]; c >= 0 && cells * this.dx < WORLD.FORESHORE; c -= nx, cells++) {
        foreshore += Math.max(0, this.storm.surge - this.z[c]);
      }
      foreshore /= Math.max(1, cells);
      const H = Math.min(WORLD.BREAKING * foreshore, 4 * Math.sqrt(Math.max(0, this.toeSq[i] / n - mean * mean)));
      Hm0[i] = H;
      q[i] = 0;
      if (H >= 0.01) {
        const scale = Math.sqrt(G * H * H * H), r = Rc / H;
        if (this.gammaF[i] < 1) q[i] = 0.09 * scale * Math.exp(-Math.pow(1.5 * r / this.gammaF[i], 1.3));
        else {
          q[i] = 0.047 * scale * Math.exp(-Math.pow(2.35 * r, 1.3));
          if (toeDepth * toeDepth / (H * L) < 0.23) {
            const shallow = Math.sqrt(L / toeDepth); // sqrt(Hm0 / (h s)) with s = Hm0 / L
            const impulsive = scale * shallow * (r < 1.35 ? 0.011 * Math.exp(-2.2 * r) : 0.0014 / (r * r * r));
            if (impulsive > q[i]) q[i] = impulsive;
          }
        }
      }
      q[i] += this.overtopByColumn[i] / this.dx / Math.max(1e-9, this.t); // + green water
      sum += q[i];
    }
    return { Hm0, q, mean: sum / nx }; // mean: m3/s per metre of wall
  }

  // Incident surface elevation (above the surge level) at the sea boundary.
  incident(x) {
    const ramp = Math.min(1, this.t / this.storm.ramp);
    const cos = Math.cos, t = this.t, waves = this.waves;
    let e = 0;
    for (let k = 0; k < waves.length; k++) {
      const w = waves[k];
      e += w.a * cos(w.kx * x - w.omega * t + w.phase);
    }
    return ramp * e;
  }

  get done() {
    return this.t >= this.storm.duration;
  }

  step() {
    const { nx, ny, dx, dt, z, eta, u, v, qu, qv, limit } = this;
    const hMin = WORLD.H_MIN;
    const fric = G * WORLD.MANNING * WORLD.MANNING;
    const abs = Math.abs, g = G, P = POW43, PS = POW43_STEP, cbrt = Math.cbrt; // locals: global lookups are slow in hot loops
    const nxf = nx + 1;

    // 1. Momentum on x-faces (side walls i = 0 and i = nx stay closed), then the flux through the face
    //    with the upstream depth (the water surface does not change until step 4, so it can be done here).
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const f = j * nxf + i, L = j * nx + i - 1, R = L + 1;
        const zf = z[L] > z[R] ? z[L] : z[R];
        const top = eta[L] > eta[R] ? eta[L] : eta[R];
        if (top - zf < hMin) { u[f] = 0; qu[f] = 0; continue; }
        const uf = u[f];
        const hf = uf > 0 ? eta[L] - zf : uf < 0 ? eta[R] - zf : top - zf;
        // advection, upwind
        let adv = uf > 0 ? uf * (uf - u[f - 1]) : uf * (u[f + 1] - uf);
        const vb = 0.25 * (v[L] + v[R] + v[L + nx] + v[R + nx]);
        if (vb > 0 && j > 0) adv += vb * (uf - u[f - nxf]);
        else if (vb < 0 && j < ny - 1) adv += vb * (u[f + nxf] - uf);
        let un = uf - dt * (g * (eta[R] - eta[L]) + adv) / dx;
        const hh = hf > hMin ? hf : hMin;
        const xu = hh * PS, ku = xu | 0;
        un /= 1 + dt * fric * abs(un) / (ku < 3000 ? P[ku] + (P[ku + 1] - P[ku]) * (xu - ku) : hh * cbrt(hh));
        un = un > 20 ? 20 : un < -20 ? -20 : un;
        u[f] = un;
        const hq = un > 0 ? eta[L] - zf : eta[R] - zf;
        qu[f] = hq > 0 ? hq * un : 0;
      }
    }

    // 2. Momentum and flux on y-faces. Face j = 0 is the sea boundary (below), face j = ny is closed.
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = j * nx + i, D = f - nx, U = f;   // cell below (seaward) and above (landward)
        const zf = z[D] > z[U] ? z[D] : z[U];
        const top = eta[D] > eta[U] ? eta[D] : eta[U];
        if (top - zf < hMin) { v[f] = 0; qv[f] = 0; continue; }
        const vf = v[f];
        const hf = vf > 0 ? eta[D] - zf : vf < 0 ? eta[U] - zf : top - zf;
        let adv = vf > 0 ? vf * (vf - v[f - nx]) : (j < ny - 1 ? vf * (v[f + nx] - vf) : 0);
        const ub = 0.25 * (u[D + j - 1] + u[D + j] + u[U + j] + u[U + j + 1]);
        if (ub > 0 && i > 0) adv += ub * (vf - v[f - 1]);
        else if (ub < 0 && i < nx - 1) adv += ub * (v[f + 1] - vf);
        let vn = vf - dt * (g * (eta[U] - eta[D]) + adv) / dx;
        const hh = hf > hMin ? hf : hMin;
        const xv = hh * PS, kv = xv | 0;
        vn /= 1 + dt * fric * abs(vn) / (kv < 3000 ? P[kv] + (P[kv + 1] - P[kv]) * (xv - kv) : hh * cbrt(hh));
        vn = vn > 20 ? 20 : vn < -20 ? -20 : vn;
        v[f] = vn;
        const hq = vn > 0 ? eta[D] - zf : eta[U] - zf;
        qv[f] = hq > 0 ? hq * vn : 0;
      }
    }

    // 3. Sea boundary (Flather): flux = c (2 * incident - actual), relative to the surge level.
    const surge = this.storm.surge;
    for (let i = 0; i < nx; i++) {
      const q = this.c0 * (2 * this.incident((i + 0.5) * dx) - (eta[i] - surge));
      qv[i] = q;
      v[i] = q / this.depth0;
    }

    // 4. Positivity: a cell cannot give away more water than it has.
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i, fx = j * nxf + i, fy = c;
        let out = 0;
        if (qu[fx] < 0) out -= qu[fx];
        if (qu[fx + 1] > 0) out += qu[fx + 1];
        if (qv[fy] < 0) out -= qv[fy];
        if (qv[fy + nx] > 0) out += qv[fy + nx];
        const h = eta[c] - z[c];
        const vol = out * dt / dx;
        limit[c] = vol > h ? (h > 0 ? h / vol : 0) : 1;
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const f = j * nxf + i, q = qu[f];
        if (q > 0) qu[f] = q * limit[j * nx + i - 1];
        else if (q < 0) qu[f] = q * limit[j * nx + i];
      }
    }
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = j * nx + i, q = qv[f];
        if (q > 0) qv[f] = q * limit[f - nx];
        else if (q < 0) qv[f] = q * limit[f];
      }
    }
    for (let i = 0; i < nx; i++) if (qv[i] < 0) qv[i] *= limit[i];

    // 5. Mass: new water surface.
    const k = dt / dx;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i, fx = j * nxf + i;
        let e = eta[c] - k * (qu[fx + 1] - qu[fx] + qv[c + nx] - qv[c]);
        if (e < z[c]) e = z[c];
        eta[c] = e;
      }
    }

    // 6. Overtopping: what crossed from the wall row onto the promenade.
    const fw = (this.world.wallRow + 1) * nx;
    for (let i = 0; i < nx; i++) {
      const q = qv[fw + i];
      if (q > 0) {
        const vol = q * dx * dt;
        this.overtopped += vol;
        this.overtopByColumn[i] += vol;
      }
    }
    // Drain at the back of the promenade.
    for (let c = (ny - 1) * nx; c < ny * nx; c++) eta[c] = z[c];

    if (this.blocks) this.damage();
    this.t += dt;
    if (this.t >= this.storm.measureFrom) this.measureToes();
  }

  // The water speed a block in cell c feels: in the cell itself if it is under water,
  // and in the wet neighbours (the flow along and against the side of the mound).
  attackSpeed(c) {
    const { nx, ny, eta, z } = this, hMin = WORLD.H_MIN;
    const j = (c / nx) | 0, i = c - j * nx;
    let s = eta[c] - z[c] > hMin ? this.speedAt(c) : 0;
    if (i > 0 && eta[c - 1] - z[c - 1] > hMin) s = Math.max(s, this.speedAt(c - 1));
    if (i < nx - 1 && eta[c + 1] - z[c + 1] > hMin) s = Math.max(s, this.speedAt(c + 1));
    if (j > 0 && eta[c - nx] - z[c - nx] > hMin) s = Math.max(s, this.speedAt(c - nx));
    if (j < ny - 1 && eta[c + nx] - z[c + nx] > hMin) s = Math.max(s, this.speedAt(c + nx));
    return s;
  }

  // Speed in a cell centre (for damage and pictures).
  speedAt(c) {
    const nx = this.nx, j = (c / nx) | 0, i = c - j * nx;
    const uc = 0.5 * (this.u[j * (nx + 1) + i] + this.u[j * (nx + 1) + i + 1]);
    const vc = 0.5 * (this.v[c] + this.v[c + nx]);
    return Math.sqrt(uc * uc + vc * vc);
  }

  // Total water volume (m3) in the domain, for mass checks.
  volume() {
    let s = 0;
    for (let c = 0; c < this.nx * this.ny; c++) s += this.eta[c] - this.z[c];
    return s * this.dx * this.dx;
  }

  run() {
    while (!this.done) this.step();
    return this;
  }
}
