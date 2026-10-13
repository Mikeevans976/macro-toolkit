/**
 * Small dense linear-algebra helpers used by in-browser PCA / OLS.
 * Previously copy-pasted into every regional heatmap page; kept operation-for-
 * operation identical to those copies so results are unchanged.
 */

export function matTranspose(A: number[][]): number[][] {
  return A[0].map((_, j) => A.map(r => r[j]))
}

export function matMul(A: number[][], B: number[][]): number[][] {
  return Array.from({ length: A.length }, (_, i) =>
    Array.from({ length: B[0].length }, (_, j) =>
      Array.from({ length: B.length }, (_, k) => A[i][k] * B[k][j]).reduce((a, b) => a + b, 0),
    ),
  )
}

export function matVecMul(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0))
}

/** Gauss–Jordan inverse with partial pivoting. */
export function matInv(A: number[][]): number[][] {
  const n = A.length
  const aug = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let mx = col
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[mx][col])) mx = r;
    [aug[col], aug[mx]] = [aug[mx], aug[col]]
    const pv = aug[col][col]
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pv
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = aug[r][col]
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= f * aug[col][j]
    }
  }
  return aug.map(row => row.slice(n))
}

export interface OLSResult {
  coefficients: number[]
  tStats: number[]
  rSquared: number
  adjRSquared: number
  fitted: number[]
  residuals: number[]
}

/** Ordinary least squares (no implicit intercept — include a ones column in X if needed). */
export function ols(y: number[], X: number[][]): OLSResult {
  const N = y.length, K = X[0].length
  const Xt = matTranspose(X), XtX = matMul(Xt, X), Xty = matVecMul(Xt, y)
  const beta = matVecMul(matInv(XtX), Xty)
  const fitted = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0))
  const residuals = y.map((yi, i) => yi - fitted[i])
  const yMean = y.reduce((s, v) => s + v, 0) / N
  const TSS = y.reduce((s, v) => s + (v - yMean) ** 2, 0)
  const RSS = residuals.reduce((s, r) => s + r ** 2, 0)
  const rSquared = 1 - RSS / TSS
  const adjRSquared = 1 - (RSS / (N - K)) / (TSS / (N - 1))
  const sigma2 = RSS / (N - K)
  const XtXinv = matInv(XtX)
  return { coefficients: beta, tStats: beta.map((b, j) => b / Math.sqrt(sigma2 * XtXinv[j][j])), rSquared, adjRSquared, fitted, residuals }
}

/** Symmetric eigendecomposition (cyclic Jacobi); eigenpairs sorted by descending eigenvalue. */
export function jacobiEigen(mat: number[][]): { values: number[]; vectors: number[][] } {
  const n = mat.length
  const a = mat.map(r => [...r])
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  )
  for (let iter = 0; iter < 500; iter++) {
    let maxVal = 0, p = 0, q = 1
    for (let i = 0; i < n - 1; i++)
      for (let j = i + 1; j < n; j++)
        if (Math.abs(a[i][j]) > maxVal) { maxVal = Math.abs(a[i][j]); p = i; q = j }
    if (maxVal < 1e-12) break
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(1 + theta * theta))
    const c = 1 / Math.sqrt(1 + t * t), s = t * c
    const app = a[p][p], aqq = a[q][q], apq = a[p][q]
    a[p][p] = app - t * apq; a[q][q] = aqq + t * apq; a[p][q] = 0; a[q][p] = 0
    for (let i = 0; i < n; i++) {
      if (i !== p && i !== q) {
        const aip = a[i][p], aiq = a[i][q]
        a[i][p] = a[p][i] = c * aip - s * aiq
        a[i][q] = a[q][i] = s * aip + c * aiq
      }
    }
    for (let i = 0; i < n; i++) {
      const vip = v[i][p], viq = v[i][q]
      v[i][p] = c * vip - s * viq; v[i][q] = s * vip + c * viq
    }
  }
  const pairs = Array.from({ length: n }, (_, k) => ({
    val: a[k][k], vec: Array.from({ length: n }, (_, r) => v[r][k]),
  })).sort((x, y) => y.val - x.val)
  return { values: pairs.map(p => p.val), vectors: pairs.map(p => p.vec) }
}
