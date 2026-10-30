'use strict';
// TRUSS ANALYSIS: what happens to a set of bars and hinges under a load.
//
// This is the "direct stiffness method" that engineers use (and every structural program inside).
// A truss is made of straight bars joined by hinges (nodes). A bar only pulls or pushes along itself:
//   force in the bar N = E·A / L · (how much it got longer),
//   E - stiffness of steel, A - area of the section, L - length.
// Every free node can move by (u, v). Every bar adds its stiffness to the nodes at its ends, and we get
// a system of linear equations K · d = F: K - stiffness matrix (2 rows per free node),
// d - displacements of the nodes, F - loads on the nodes. Supports do not move: their rows are not in K.
//
// If the system has no unique solution, the truss is a MECHANISM: some part of it can move without
// stretching any bar (a node hanging on one bar, a square without a diagonal). Such a "bridge" folds up.
// We solve K by Cholesky (K = L·Lᵀ). A zero pivot means a direction where nothing resists:
// we count these "free modes" - the more of them, the further the structure is from standing.
//
// Usage: const t = makeTruss(nodes, bars); nodes: [{x, y, fixed}], bars: [{a, b, A}] (a, b - node indices).
//   t.mechanism - number of free modes (0 = stands);
//   t.solve(loads) -> { forces: N of every bar (+ tension, − compression), disp: [{u, v}] for every node }.
//   loads: [{fx, fy}] per node. Many load cases share one factorization: solving is cheap.

const STEEL_E = 2.1e8; // kN/m², Young's modulus of steel (210 GPa)

function makeTruss(nodes, bars) {
  // Numbering of unknowns: 2 per free node, supports have none.
  const dof = new Int32Array(nodes.length).fill(-1);
  let n = 0;
  for (let i = 0; i < nodes.length; i++) if (!nodes[i].fixed) { dof[i] = n; n += 2; }

  // Geometry of the bars: length and direction cosines.
  const geo = bars.map((b) => {
    const p = nodes[b.a], q = nodes[b.b];
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    return { L, c: (q.x - p.x) / L, s: (q.y - p.y) / L, k: STEEL_E * b.A / L };
  });

  // Assemble K. A bar adds k·[c², cs; cs, s²] to its two ends with + on the diagonal blocks, − between them.
  const K = new Float64Array(n * n);
  const add = (i, j, v) => { if (i >= 0 && j >= 0) K[i * n + j] += v; };
  bars.forEach((b, e) => {
    const { k, c, s } = geo[e];
    const m = [k * c * c, k * c * s, k * s * s];
    const ia = dof[b.a], ib = dof[b.b];
    const block = (i, j, sign) => {
      if (i < 0 || j < 0) return;
      add(i, j, sign * m[0]); add(i, j + 1, sign * m[1]);
      add(i + 1, j, sign * m[1]); add(i + 1, j + 1, sign * m[2]);
    };
    block(ia, ia, 1); block(ib, ib, 1); block(ia, ib, -1); block(ib, ia, -1);
  });

  // Cholesky K = L·Lᵀ in place (lower triangle). A pivot much smaller than the diagonal it started from
  // is a free mode: we count it and zero that column, so the count of all free modes is correct.
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) diag[i] = K[i * n + i];
  const dead = new Uint8Array(n);
  let mechanism = 0;
  for (let j = 0; j < n; j++) {
    let d = K[j * n + j];
    for (let k = 0; k < j; k++) d -= K[j * n + k] * K[j * n + k];
    if (!(d > 1e-9 * diag[j])) {
      mechanism++;
      dead[j] = 1;
      for (let i = j; i < n; i++) K[i * n + j] = 0;
      continue;
    }
    const ljj = Math.sqrt(d);
    K[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let v = K[i * n + j];
      for (let k = 0; k < j; k++) v -= K[i * n + k] * K[j * n + k];
      K[i * n + j] = v / ljj;
    }
  }

  function solve(loads) {
    const disp = nodes.map(() => ({ u: 0, v: 0 }));
    const forces = new Float64Array(bars.length);
    if (mechanism) return { disp, forces };
    // Forward and back substitution: L·y = F, Lᵀ·d = y.
    const x = new Float64Array(n);
    for (let i = 0; i < nodes.length; i++) {
      if (dof[i] < 0) continue;
      x[dof[i]] = loads[i] ? loads[i].fx : 0;
      x[dof[i] + 1] = loads[i] ? loads[i].fy : 0;
    }
    for (let i = 0; i < n; i++) {
      let v = x[i];
      for (let k = 0; k < i; k++) v -= K[i * n + k] * x[k];
      x[i] = v / K[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let v = x[i];
      for (let k = i + 1; k < n; k++) v -= K[k * n + i] * x[k];
      x[i] = v / K[i * n + i];
    }
    for (let i = 0; i < nodes.length; i++) {
      if (dof[i] >= 0) disp[i] = { u: x[dof[i]], v: x[dof[i] + 1] };
    }
    // Force in a bar from how much it got longer: N = k · (displacement of b − of a) along the bar.
    bars.forEach((b, e) => {
      const { k, c, s } = geo[e];
      const da = disp[b.a], db = disp[b.b];
      forces[e] = k * ((db.u - da.u) * c + (db.v - da.v) * s);
    });
    return { disp, forces };
  }

  return { mechanism, solve, lengths: geo.map((g) => g.L) };
}
