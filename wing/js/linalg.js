'use strict';
// Dense linear algebra: LU decomposition with partial pivoting.
// The panel method has one matrix per airfoil and many right-hand sides (every angle of attack,
// every boundary-layer pass), so the matrix is decomposed once and every solve is cheap (n² instead of n³).

// a: Float64Array n*n, row-major; decomposed in place. Returns the row permutation.
function luDecompose(a, n) {
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;
  for (let k = 0; k < n; k++) {
    let p = k, big = Math.abs(a[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]);
      if (v > big) { big = v; p = i; }
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) { const t = a[k * n + j]; a[k * n + j] = a[p * n + j]; a[p * n + j] = t; }
      const t = piv[k]; piv[k] = piv[p]; piv[p] = t;
    }
    const d = a[k * n + k];
    if (d === 0) continue; // singular - the caller sees NaN later
    for (let i = k + 1; i < n; i++) {
      const f = (a[i * n + k] /= d);
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) a[i * n + j] -= f * a[k * n + j];
    }
  }
  return piv;
}

// Solves A x = b with the decomposition from luDecompose. Returns a new array x.
function luSolve(a, piv, n, b) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[piv[i]];
    for (let j = 0; j < i; j++) s -= a[i * n + j] * x[j];
    x[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= a[i * n + j] * x[j];
    x[i] = s / a[i * n + i];
  }
  return x;
}

// Small systems (least squares fits): solve in one call.
function solveDense(rows) {
  const n = rows.length;
  const a = new Float64Array(n * n), b = new Float64Array(n);
  rows.forEach((r, i) => { for (let j = 0; j < n; j++) a[i * n + j] = r[j]; b[i] = r[n]; });
  const piv = luDecompose(a, n);
  return Array.from(luSolve(a, piv, n, b));
}
