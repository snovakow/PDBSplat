// An atom's thermal ellipsoid as a splat's covariance: the region the atom spends half its time in, by its
// anisotropic displacement, or by its B-factor alike in every direction where the entry gives it none
import type { Atom } from '../pdb/mmcif.ts'

// An atom lies within its half-probability ellipsoid at a Mahalanobis distance of the square root of the median of χ²
// with three degrees of freedom, and three draws a splat out to two standard deviations. So the splat's covariance is
// U times a quarter of that median, about 0.5915, times Size squared
const medianChiSquared3 = 2.365974
const ellipsoidShare = medianChiSquared3 / 4

// The least variance along any axis, in square ångströms, at any Size: a tensor that isn't positive definite still
// draws as an ellipsoid, and an atom whose B-factor is 0 stays visible
const leastVariance = 0.05 * 0.05

// A B-factor is 8π² times its atom's mean square displacement along any one axis
const bPerU = 8 * Math.PI * Math.PI

// Jacobi's rotations visit the three off-diagonal places, each as a row and column pair
const pairs = [
  [0, 1],
  [0, 2],
  [1, 2],
] as const
const maxSweeps = 32

// The matrix being diagonalised and its eigenvectors as columns, both 3×3 in row order, reused by every call
const matrix = new Float64Array(9)
const vectors = new Float64Array(9)

// Writes the atom's ellipsoid at Size into target at offset, in three's covariance order [xx, xy, xz, yy, yz, zz],
// with every eigenvalue raised to at least the least variance
export function writeEllipsoid(target: Float32Array, offset: number, atom: Atom, scale: number) {
  const share = ellipsoidShare * scale * scale
  const u = atom.u
  if (u) {
    matrix[0] = u[0] * share
    matrix[1] = matrix[3] = u[1] * share
    matrix[2] = matrix[6] = u[2] * share
    matrix[4] = u[3] * share
    matrix[5] = matrix[7] = u[4] * share
    matrix[8] = u[5] * share
  } else {
    const variance = (Math.max(atom.bFactor, 0) / bPerU) * share
    matrix.fill(0)
    matrix[0] = matrix[4] = matrix[8] = variance
  }
  const xx = matrix[0]
  const xy = matrix[1]
  const xz = matrix[2]
  const yy = matrix[4]
  const yz = matrix[5]
  const zz = matrix[8]

  diagonalise()
  const floored = matrix[0] < leastVariance || matrix[4] < leastVariance || matrix[8] < leastVariance
  if (!floored) {
    target[offset] = xx
    target[offset + 1] = xy
    target[offset + 2] = xz
    target[offset + 3] = yy
    target[offset + 4] = yz
    target[offset + 5] = zz
    return
  }

  // Rebuilt from its eigenvectors, each scaled by its raised eigenvalue
  const out = [0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const value = Math.max(matrix[i * 4], leastVariance)
    const x = vectors[i]
    const y = vectors[3 + i]
    const z = vectors[6 + i]
    out[0] += value * x * x
    out[1] += value * x * y
    out[2] += value * x * z
    out[3] += value * y * y
    out[4] += value * y * z
    out[5] += value * z * z
  }
  for (let k = 0; k < 6; k++) target[offset + k] = out[k]
}

// Brings the symmetric matrix to diagonal form by Jacobi's rotations, leaving its eigenvalues on the diagonal and its
// eigenvectors in the columns of vectors
function diagonalise() {
  vectors.fill(0)
  vectors[0] = vectors[4] = vectors[8] = 1
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    const off = matrix[1] * matrix[1] + matrix[2] * matrix[2] + matrix[5] * matrix[5]
    const diagonal = matrix[0] * matrix[0] + matrix[4] * matrix[4] + matrix[8] * matrix[8]
    if (off <= 1e-30 * diagonal || off === 0) return
    for (const [p, q] of pairs) {
      const apq = matrix[p * 3 + q]
      if (apq === 0) continue
      // The rotation's angle that zeroes the pair's place, taken as its smaller root for stability
      const theta = (matrix[q * 4] - matrix[p * 4]) / (2 * apq)
      const t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const kp = matrix[k * 3 + p]
        const kq = matrix[k * 3 + q]
        matrix[k * 3 + p] = c * kp - s * kq
        matrix[k * 3 + q] = s * kp + c * kq
      }
      for (let k = 0; k < 3; k++) {
        const pk = matrix[p * 3 + k]
        const qk = matrix[q * 3 + k]
        matrix[p * 3 + k] = c * pk - s * qk
        matrix[q * 3 + k] = s * pk + c * qk
      }
      for (let k = 0; k < 3; k++) {
        const kp = vectors[k * 3 + p]
        const kq = vectors[k * 3 + q]
        vectors[k * 3 + p] = c * kp - s * kq
        vectors[k * 3 + q] = s * kp + c * kq
      }
    }
  }
}
