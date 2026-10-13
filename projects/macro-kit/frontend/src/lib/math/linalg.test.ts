import { describe, expect, it } from 'vitest'
import { jacobiEigen, matInv, matMul, matTranspose, ols } from './linalg'

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('linalg', () => {
  it('matInv inverts a matrix that needs pivoting', () => {
    const A = [[0, 2, 1], [1, 1, 0], [3, 0, 1]]
    const I = matMul(A, matInv(A))
    I.forEach((row, i) => row.forEach((v, j) => close(v, i === j ? 1 : 0)))
  })

  it('matTranspose', () => {
    expect(matTranspose([[1, 2, 3], [4, 5, 6]])).toEqual([[1, 4], [2, 5], [3, 6]])
  })

  it('ols recovers exact coefficients with R² = 1', () => {
    const X = Array.from({ length: 20 }, (_, i) => [1, i, (i * 7) % 5])
    const y = X.map(([c, a, b]) => 2 * c - 0.5 * a + 3 * b)
    const r = ols(y, X)
    close(r.coefficients[0], 2); close(r.coefficients[1], -0.5); close(r.coefficients[2], 3)
    close(r.rSquared, 1)
  })

  it('jacobiEigen matches a known symmetric decomposition, sorted descending', () => {
    const { values, vectors } = jacobiEigen([[2, 1], [1, 2]])
    close(values[0], 3); close(values[1], 1)
    close(Math.abs(vectors[0][0]), Math.SQRT1_2); close(Math.abs(vectors[0][1]), Math.SQRT1_2)
  })
})
