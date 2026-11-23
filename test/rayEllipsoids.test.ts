import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Ray, Vector3 } from 'three'
import { writeRound } from '../src/viewer/ellipsoidGeometry.ts'
import {
  invertCovariance,
  invertCovariances,
  nearestEllipsoid,
  type EllipsoidHit,
} from '../src/viewer/rayEllipsoids.ts'

// The pick's crossing of a ray with ellipsoids: the inverse of a covariance, the ellipsoid met first, and the cut

// A symmetric matrix in the order [xx, xy, xz, yy, yz, zz] as its nine entries, row by row
const square = (m: ArrayLike<number>) => [m[0], m[1], m[2], m[1], m[3], m[4], m[2], m[4], m[5]]

// The ray from the origin along a direction
const rayAlong = (x: number, y: number, z: number) => new Ray(new Vector3(), new Vector3(x, y, z).normalize())

// A hit to write into
const newHit = (): EllipsoidHit => ({ index: -1, distance: Infinity })

void test('the inverse of a covariance times the covariance is the identity', () => {
  const covariance = [2, 0.3, -0.4, 1.5, 0.2, 0.9]
  const inverse = new Float64Array(8)
  invertCovariance(covariance, 0, inverse, 2)
  const a = square(covariance)
  const b = square(inverse.subarray(2))
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += a[row * 3 + k] * b[k * 3 + column]
      assert.ok(Math.abs(sum - (row === column ? 1 : 0)) < 1e-12, `${row}, ${column}: ${sum}`)
    }
  }
  // Nothing is written outside the six floats
  assert.equal(inverse[0], 0)
  assert.equal(inverse[1], 0)
  // A list's inverses are each one's, in place
  const two = new Float32Array(12)
  writeRound(two, 0, 0.5)
  writeRound(two, 6, 2)
  assert.deepEqual([...invertCovariances(two)], [4, 0, 0, 4, 0, 4, 0.25, 0, 0, 0.25, 0, 0.25])
})

void test('a ray meets a round ellipsoid two standard deviations out, as it would its sphere', () => {
  // A sphere of radius 1.7, ten units down the z axis
  const centers = new Float32Array([0, 0, -10])
  const covariances = new Float32Array(6)
  writeRound(covariances, 0, 0.85)
  const inverses = invertCovariances(covariances)
  const hit = newHit()
  nearestEllipsoid(rayAlong(0, 0, -1), centers, inverses, 0, hit)
  assert.equal(hit.index, 0)
  assert.ok(Math.abs(hit.distance - 8.3) < 1e-5, String(hit.distance))
  // Through a point one unit off the centre, the ray enters where the sphere's chord begins
  const off = rayAlong(1, 0, -10)
  nearestEllipsoid(off, centers, inverses, 0, hit)
  const along = 10 * off.direction.z * -1
  const miss = Math.sqrt(100 - along * along)
  assert.equal(hit.index, 0)
  assert.ok(Math.abs(hit.distance - (along - Math.sqrt(1.7 * 1.7 - miss * miss))) < 1e-5, String(hit.distance))
  // Past its edge the ray meets nothing
  nearestEllipsoid(rayAlong(1.8, 0, -10), centers, inverses, 0, hit)
  assert.equal(hit.index, -1)
  assert.equal(hit.distance, Infinity)
})

void test('a stretched ellipsoid is met further out along its long axis than across it', () => {
  // Deviations of 2 along x and 0.5 along y and z, so it reaches 4 along x and 1 along y
  const centers = new Float32Array([0, 0, -10])
  const inverses = invertCovariances(new Float32Array([4, 0, 0, 0.25, 0, 0.25]))
  const hit = newHit()
  nearestEllipsoid(rayAlong(3, 0, -10), centers, inverses, 0, hit)
  assert.equal(hit.index, 0)
  nearestEllipsoid(rayAlong(0, 3, -10), centers, inverses, 0, hit)
  assert.equal(hit.index, -1)
  nearestEllipsoid(rayAlong(0, 0.9, -10), centers, inverses, 0, hit)
  assert.equal(hit.index, 0)
})

void test('the ellipsoid met first is found, among those the test accepts', () => {
  const centers = new Float32Array([0, 0, -20, 0, 0, -10, 5, 0, -10])
  const covariances = new Float32Array(18)
  for (let i = 0; i < 3; i++) writeRound(covariances, i * 6, 0.85)
  const inverses = invertCovariances(covariances)
  const hit = newHit()
  const ray = rayAlong(0, 0, -1)
  nearestEllipsoid(ray, centers, inverses, 0, hit)
  assert.equal(hit.index, 1)
  assert.ok(Math.abs(hit.distance - 8.3) < 1e-5)
  // The ray passes through one the test turns down, to the one behind it
  nearestEllipsoid(ray, centers, inverses, 0, hit, (index) => index !== 1)
  assert.equal(hit.index, 0)
  assert.ok(Math.abs(hit.distance - 18.3) < 1e-5)
  nearestEllipsoid(ray, centers, inverses, 0, hit, () => false)
  assert.equal(hit.index, -1)
})

void test('the cut passes through an ellipsoid wholly nearer, and meets one it crosses at its cut face', () => {
  const centers = new Float32Array([0, 0, -10, 0, 0, -20])
  const covariances = new Float32Array(12)
  for (let i = 0; i < 2; i++) writeRound(covariances, i * 6, 0.85)
  const inverses = invertCovariances(covariances)
  const hit = newHit()
  const ray = rayAlong(0, 0, -1)
  // The cut crosses the first sphere, which runs from 8.3 to 11.7 along the ray
  nearestEllipsoid(ray, centers, inverses, 9, hit)
  assert.equal(hit.index, 0)
  assert.equal(hit.distance, 9)
  // Past its far side, the ray goes on to the second
  nearestEllipsoid(ray, centers, inverses, 12, hit)
  assert.equal(hit.index, 1)
  assert.ok(Math.abs(hit.distance - 18.3) < 1e-5)
  // And past both, it meets nothing
  nearestEllipsoid(ray, centers, inverses, 22, hit)
  assert.equal(hit.index, -1)
})
