import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeCovariance } from 'three/addons/utils/GaussianSplatUtils.js'
import {
  groupBy,
  levelPixels,
  levels,
  levelToDraw,
  mergeGaussians,
  pixelsPerUnit,
  typicalDiameter,
} from '../src/viewer/levels.ts'

// The levels of detail: the moment-matched merge of Gaussians into groups, the typical drawn diameter and the switch rule

// three draws a splat out to two standard deviations
const cutoff = 2

// The covariances are written in single precision
const tolerance = 1e-6

// Round Gaussians of one standard deviation each at the given centres, in three's covariance order
function round(centers: number[][], sigma = 1) {
  const positions = new Float32Array(centers.flat())
  const covariances = new Float32Array(centers.length * 6)
  centers.forEach((_, i) => writeCovariance(covariances, i * 6, sigma, sigma, sigma, 0, 0, 0, 1))
  return { positions, covariances }
}

const near = (actual: ArrayLike<number>, expected: number[], message?: string) => {
  assert.equal(actual.length, expected.length, message)
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance * Math.max(1, Math.abs(expected[i])), `${message ?? ''} [${i}]: ${actual[i]} is not ${expected[i]}`)
  }
}

void test('groupBy numbers the groups in the order they first appear', () => {
  const items = ['b', 'a', 'b', 'c', 'a']
  const grouping = groupBy(items, (item) => item)
  assert.deepEqual([...grouping.groups], [0, 1, 0, 2, 1])
  assert.equal(grouping.count, 3)
  assert.deepEqual(groupBy([], () => ''), { groups: new Uint32Array(0), count: 0 })
})

void test("one atom's group is that atom", () => {
  const { positions, covariances } = round([[1, 2, 3]], 0.7)
  const merged = mergeGaussians(positions, covariances, [5], { groups: new Uint32Array([0]), count: 1 })
  near(merged.centers, [1, 2, 3])
  near(merged.covariances, [0.49, 0, 0, 0.49, 0, 0.49])
  assert.deepEqual([...merged.weights], [5])
  assert.deepEqual([...merged.counts], [1])
})

void test('two equal atoms at ±d along x give the mean at the origin, the x variance σ² + d² and the others σ²', () => {
  const d = 1.5
  const sigma = 0.8
  const { positions, covariances } = round(
    [
      [-d, 0, 0],
      [d, 0, 0],
    ],
    sigma,
  )
  const merged = mergeGaussians(positions, covariances, [2, 2], { groups: new Uint32Array([0, 0]), count: 1 })
  near(merged.centers, [0, 0, 0])
  near(merged.covariances, [sigma * sigma + d * d, 0, 0, sigma * sigma, 0, sigma * sigma])
  assert.deepEqual([...merged.weights], [4])
  assert.deepEqual([...merged.counts], [2])
})

void test("a group's covariance is symmetric and positive definite, and a group's scatter stays about its own mean", () => {
  // Three atoms in a triangle away from the origin, two of them in one group and the third alone
  const { positions, covariances } = round(
    [
      [10, 20, 30],
      [12, 21, 30.5],
      [-5, 0, 2],
    ],
    0.5,
  )
  const merged = mergeGaussians(positions, covariances, [1, 3, 2], { groups: new Uint32Array([0, 0, 1]), count: 2 })
  // The pair's mean, three quarters of the way to the heavier atom
  near(merged.centers, [11.5, 20.75, 30.375, -5, 0, 2])
  const [xx, xy, xz, yy, yz, zz] = merged.covariances
  // The scatter of ±(2, 1, 0.5) about the mean, at the weights' shares, plus σ² on the diagonal
  const spread = (a: number, b: number) => (1 * (0.75 * a) * (0.75 * b) + 3 * (0.25 * a) * (0.25 * b)) / 4
  near([xx, xy, xz, yy, yz, zz], [
    0.25 + spread(2, 2),
    spread(2, 1),
    spread(2, 0.5),
    0.25 + spread(1, 1),
    spread(1, 0.5),
    0.25 + spread(0.5, 0.5),
  ])
  // Positive definite by Sylvester's criterion: every leading minor is positive
  assert.ok(xx > 0)
  assert.ok(xx * yy - xy * xy > 0)
  const determinant = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz)
  assert.ok(determinant > 0)
  near(merged.covariances.subarray(6), [0.25, 0, 0, 0.25, 0, 0.25])
  assert.deepEqual([...merged.weights], [4, 2])
  assert.deepEqual([...merged.counts], [2, 1])
})

void test("a heavier atom pulls the mean its way by its weight's share", () => {
  const { positions, covariances } = round([
    [0, 0, 0],
    [4, 0, 0],
  ])
  for (const [light, heavy, mean] of [
    [1, 1, 2],
    [1, 3, 3],
    [3, 1, 1],
    [1, 7, 3.5],
  ]) {
    const merged = mergeGaussians(positions, covariances, [light, heavy], { groups: new Uint32Array([0, 0]), count: 1 })
    near(merged.centers, [mean, 0, 0], `weights ${light} and ${heavy}`)
    // The scatter is the weighted mean of the squared distances from the mean
    const scatter = (light * mean * mean + heavy * (4 - mean) * (4 - mean)) / (light + heavy)
    near(merged.covariances, [1 + scatter, 0, 0, 1, 0, 1], `weights ${light} and ${heavy}`)
  }
})

void test('the typical diameter of one round Gaussian is its drawn diameter, and of several their median', () => {
  const one = round([[0, 0, 0]], 0.85)
  assert.ok(Math.abs(typicalDiameter(one.covariances, cutoff) - 2 * cutoff * 0.85) <= tolerance)
  // An ellipsoid counts by the root of its mean variance
  const ellipsoid = new Float32Array([4, 0, 0, 1, 0, 1])
  assert.equal(typicalDiameter(ellipsoid, cutoff), 2 * cutoff * Math.sqrt(2))
  const sizes = [0.5, 3, 1, 2, 10]
  const several = new Float32Array(sizes.length * 6)
  sizes.forEach((sigma, i) => writeCovariance(several, i * 6, sigma, sigma, sigma, 0, 0, 0, 1))
  assert.ok(Math.abs(typicalDiameter(several, cutoff) - 2 * cutoff * 2) <= tolerance)
  // An even count takes the middle pair's mean
  assert.ok(Math.abs(typicalDiameter(several.subarray(0, 24), cutoff) - 2 * cutoff * 1.5) <= tolerance)
  assert.equal(typicalDiameter(new Float32Array(0), cutoff), 0)
})

void test('the switch rule picks the finest level still a few pixels across, or the coarsest where none is', () => {
  assert.equal(levelPixels, 4)
  assert.deepEqual(levels, ['atoms', 'residues', 'chains'])
  // Diameters in ångströms, finest first, as a protein's might be
  const diameters = [3.4, 8, 40]
  // The atoms just reach the threshold, and just fall short of it
  assert.equal(levelToDraw(diameters, levelPixels / 3.4), 0)
  assert.equal(levelToDraw(diameters, levelPixels / 3.4 - 1e-9), 1)
  assert.equal(levelToDraw(diameters, levelPixels / 8), 1)
  assert.equal(levelToDraw(diameters, levelPixels / 8 - 1e-9), 2)
  assert.equal(levelToDraw(diameters, levelPixels / 40), 2)
  // Nothing reaches it, so the coarsest is drawn
  assert.equal(levelToDraw(diameters, levelPixels / 40 - 1e-9), 2)
  assert.equal(levelToDraw(diameters, 0), 2)
  // One level alone is always drawn
  assert.equal(levelToDraw([3.4], 0), 0)
})

void test('the pixels per unit follow the viewport height, the field of view and the depth', () => {
  // At a depth where the view spans twice the depth, a 90° field of view, a unit is a pixel on a two-pixel-tall viewport
  assert.ok(Math.abs(pixelsPerUnit(2, 90, 1) - 1) <= 1e-12)
  // A 713 px viewport at 50° looking at a point 47 units away
  const expected = 713 / (2 * 47 * Math.tan((25 * Math.PI) / 180))
  assert.ok(Math.abs(pixelsPerUnit(713, 50, 47) - expected) <= 1e-12)
  // Twice the depth halves it, and twice the height doubles it
  assert.ok(Math.abs(pixelsPerUnit(713, 50, 94) - expected / 2) <= 1e-12)
  assert.ok(Math.abs(pixelsPerUnit(1426, 50, 47) - expected * 2) <= 1e-12)
})
