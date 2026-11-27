// The morph: how a level's instance grows out of its parent, its residue's blob for an atom and its chain's for a
// residue's blob, as the fraction its piece has grown runs from 0 to 1. Of each parent's children the one whose centre
// lies nearest the parent's carries it, mixed from the parent's centre, covariance and paint to its own, so that at 0
// it's the parent. Every other child starts tiny inside the parent and grows out as the carrier shrinks onto its own
// shape: its centre moves from a point inside the parent to its own, its covariance grows from its own shrunk almost to
// nothing, and its paint is mixed from the parent's to its own, while its share of the soft sums rises from nothing.
// Every size changes evenly as the fraction runs, so that nothing rushes at either end.
// So at 0 the picture is the parent's in every composite, the others hidden inside the carrier or adding nothing, and
// at 1 it's the children's. A mix of two positive definite covariances, or one scaled by a positive factor, is
// positive definite, so every shape on the way is drawable. The vertex stage draws it, and these are its rules, which
// the pools are filled by
import { covarianceSize, startScale, surfaceDeviations } from './ellipsoidGeometry.ts'
import { invertCovariance } from './rayEllipsoids.ts'

// How far out of its parent, in the parent's standard deviations, a child that doesn't carry it starts at most: within
// the parent's ellipsoid at half its size, so that its own pixel or so of widening keeps it inside the parent's
// surface wherever the parent is a few pixels across
export const startDepth = surfaceDeviations / 2

// A parent's covariance inverted, reused by every start point
const inverse = new Float64Array(covarianceSize)

// Writes into target at an offset the shape a child grows from, its centre's x, y and z and then its covariance, from
// its own centre and covariance, and its parent's centre and covariance, each at an offset: the parent's own for the
// child that carries it; and for any other, its own covariance times the start's scale, about its own centre where
// that lies within the parent's ellipsoid at half its size, and otherwise where the line from the parent's centre to
// its own leaves that ellipsoid
export function writeStart(
  target: Float32Array,
  at: number,
  centres: ArrayLike<number>,
  centreAt: number,
  covariances: ArrayLike<number>,
  covarianceAt: number,
  parentCentres: ArrayLike<number>,
  parentCentreAt: number,
  parentCovariances: ArrayLike<number>,
  parentCovarianceAt: number,
  carries: boolean,
) {
  if (carries) {
    for (let k = 0; k < 3; k++) target[at + k] = parentCentres[parentCentreAt + k]
    for (let k = 0; k < covarianceSize; k++) target[at + 3 + k] = parentCovariances[parentCovarianceAt + k]
    return
  }
  const dx = centres[centreAt] - parentCentres[parentCentreAt]
  const dy = centres[centreAt + 1] - parentCentres[parentCentreAt + 1]
  const dz = centres[centreAt + 2] - parentCentres[parentCentreAt + 2]
  invertCovariance(parentCovariances, parentCovarianceAt, inverse, 0)
  // The child's distance from the parent's centre in the parent's standard deviations, squared
  const depth =
    dx * (inverse[0] * dx + inverse[1] * dy + inverse[2] * dz) +
    dy * (inverse[1] * dx + inverse[3] * dy + inverse[4] * dz) +
    dz * (inverse[2] * dx + inverse[4] * dy + inverse[5] * dz)
  const along = depth > startDepth * startDepth ? startDepth / Math.sqrt(depth) : 1
  target[at] = parentCentres[parentCentreAt] + dx * along
  target[at + 1] = parentCentres[parentCentreAt + 1] + dy * along
  target[at + 2] = parentCentres[parentCentreAt + 2] + dz * along
  for (let k = 0; k < covarianceSize; k++) target[at + 3 + k] = covariances[covarianceAt + k] * startScale
}

// The mix of two values a fraction of the way from the first to the second, as the vertex stage takes it, which is
// the first exactly at 0 and the second exactly at 1
export function mixed(from: number, to: number, t: number) {
  return from * (1 - t) + to * t
}

// How far a child's covariance has gone from the one it grows from to its own at a fraction, as the vertex stage
// takes it: so that its size, which goes as the covariance's root, runs evenly rather than rushing at one end. The
// carrier's parent's share falls as (1 − t)², so that the carrier shrinks onto itself as fast at the start as at the
// end and settles there; any other child's own grows as t², so that it grows outward as evenly. Both are 0 exactly at
// 0 and 1 exactly at 1
export function shapeShare(t: number, carries: boolean) {
  return carries ? t * (2 - t) : t * t
}

// A child's share of its alpha in the soft sums at a fraction: all of it for the carrier, which is its parent at 0,
// and for any other child rising from nothing at 0 to all of it at 1
export function shareAt(t: number, carries: boolean) {
  return carries ? 1 : t
}

// The shape a child is drawn with at a fraction, its centre and then its covariance, as the vertex stage takes it from
// its own and the one it grows from, both laid out so, into target: its centre mixed evenly, and its covariance by its
// shape's share
export function grownShape(own: ArrayLike<number>, start: ArrayLike<number>, t: number, carries: boolean, target: Float64Array) {
  const shaped = shapeShare(t, carries)
  for (let k = 0; k < 3; k++) target[k] = mixed(start[k], own[k], t)
  for (let k = 3; k < 3 + covarianceSize; k++) target[k] = mixed(start[k], own[k], shaped)
}
