import type { Ray } from 'three'
import { covarianceSize, surfaceDeviations } from './ellipsoidGeometry.ts'

// The nearest of a set of ellipsoids along a ray, which the splat styles pick their atoms by: the same crossing of a
// ray with an ellipsoid that each pixel draws them by

// An ellipsoid's surface lies where its own measure of distance from its centre, squared, is this
const surfaceDistanceSquared = surfaceDeviations * surfaceDeviations

export interface EllipsoidHit {
  // The ellipsoid's place in the list, or -1 when the ray meets none
  index: number
  // How far along the ray it's entered
  distance: number
}

// Writes the inverse of a covariance, a symmetric 3×3 matrix in the order [xx, xy, xz, yy, yz, zz], in the same
// order. A covariance is positive definite, so its determinant is above 0
export function invertCovariance(
  source: ArrayLike<number>,
  sourceOffset: number,
  target: Float32Array | Float64Array,
  targetOffset: number,
) {
  const xx = source[sourceOffset]
  const xy = source[sourceOffset + 1]
  const xz = source[sourceOffset + 2]
  const yy = source[sourceOffset + 3]
  const yz = source[sourceOffset + 4]
  const zz = source[sourceOffset + 5]
  // The cofactors, which are the inverse times the determinant
  const cxx = yy * zz - yz * yz
  const cxy = xz * yz - xy * zz
  const cxz = xy * yz - xz * yy
  const cyy = xx * zz - xz * xz
  const cyz = xy * xz - xx * yz
  const czz = xx * yy - xy * xy
  const determinant = xx * cxx + xy * cxy + xz * cxz
  target[targetOffset] = cxx / determinant
  target[targetOffset + 1] = cxy / determinant
  target[targetOffset + 2] = cxz / determinant
  target[targetOffset + 3] = cyy / determinant
  target[targetOffset + 4] = cyz / determinant
  target[targetOffset + 5] = czz / determinant
}

// The inverses of a list of covariances, six floats each
export function invertCovariances(covariances: Float32Array) {
  const inverses = new Float32Array(covariances.length)
  for (let offset = 0; offset < covariances.length; offset += covarianceSize) {
    invertCovariance(covariances, offset, inverses, offset)
  }
  return inverses
}

// Writes into hit the ellipsoid the ray meets first, among those a test accepts by their place in the list, where one
// is given: the ray passes through the rest. Nothing is drawn nearer along the ray than the cut, so an ellipsoid
// wholly nearer is passed through, and one the cut crosses is met at its cut face. Centres are x, y, z triples, the
// inverses those of the ellipsoids' covariances, and the ray's direction has unit length
export function nearestEllipsoid(
  ray: Ray,
  centers: Float32Array,
  inverses: Float32Array,
  cut: number,
  hit: EllipsoidHit,
  accepts?: (index: number) => boolean,
) {
  const { origin, direction } = ray
  const count = centers.length / 3
  hit.index = -1
  hit.distance = Infinity
  for (let i = 0; i < count; i++) {
    const at = i * covarianceSize
    const xx = inverses[at]
    const xy = inverses[at + 1]
    const xz = inverses[at + 2]
    const yy = inverses[at + 3]
    const yz = inverses[at + 4]
    const zz = inverses[at + 5]
    const ox = origin.x - centers[i * 3]
    const oy = origin.y - centers[i * 3 + 1]
    const oz = origin.z - centers[i * 3 + 2]
    // The inverse times the direction, how steeply the ellipsoid's measure climbs along the ray, and how far along
    // the ray passes the centre nearest by that measure
    const sx = xx * direction.x + xy * direction.y + xz * direction.z
    const sy = xy * direction.x + yy * direction.y + yz * direction.z
    const sz = xz * direction.x + yz * direction.y + zz * direction.z
    const steepness = direction.x * sx + direction.y * sy + direction.z * sz
    const nearest = -(ox * sx + oy * sy + oz * sz) / steepness
    const mx = ox + direction.x * nearest
    const my = oy + direction.y * nearest
    const mz = oz + direction.z * nearest
    const distanceSquared =
      mx * (xx * mx + xy * my + xz * mz) + my * (xy * mx + yy * my + yz * mz) + mz * (xz * mx + yz * my + zz * mz)
    if (distanceSquared > surfaceDistanceSquared) continue
    const half = Math.sqrt((surfaceDistanceSquared - distanceSquared) / steepness)
    if (nearest + half < cut) continue
    const distance = Math.max(nearest - half, cut)
    if (distance >= hit.distance) continue
    if (accepts?.(i) === false) continue
    hit.index = i
    hit.distance = distance
  }
}
