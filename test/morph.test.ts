import assert from 'node:assert/strict'
import { test } from 'node:test'
import { covarianceSize, shapeSize, startScale } from '../src/viewer/ellipsoidGeometry.ts'
import { grownShape, mixed, shapeShare, shareAt, startDepth, writeStart } from '../src/viewer/morph.ts'
import { invertCovariance } from '../src/viewer/rayEllipsoids.ts'

// The morph: each child grows out of its parent as the fraction runs from 0 to 1, the carrier from the parent's own
// shape and paint, and every other child from tiny inside the parent, with its share of the soft sums rising from
// nothing, so that at 0 the picture is the parent's and at 1 the children's

// A fixed sequence, so that a failure repeats
function randomOf(seed: number) {
  let state = seed
  return () => (state = (state * 16807) % 2147483647) / 2147483647
}

// A random covariance: a random rotation of variances from a twentieth of a square ångström to fifty, as an atom's,
// a residue's and a chain's span
function randomCovariance(next: () => number, target: Float64Array, at: number) {
  const variances = [0.05 + next() * 50, 0.05 + next() * 50, 0.05 + next() * 50]
  // A rotation from a random unit quaternion
  const [a, b, c, d] = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5]
  const n = Math.hypot(a, b, c, d)
  const [w, x, y, z] = [a / n, b / n, c / n, d / n]
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  const entry = (i: number, j: number) => variances.reduce((sum, v, k) => sum + r[i][k] * v * r[j][k], 0)
  target.set([entry(0, 0), entry(0, 1), entry(0, 2), entry(1, 1), entry(1, 2), entry(2, 2)], at)
}

// A covariance's determinant
function determinant(m: ArrayLike<number>, at: number) {
  const [xx, xy, xz, yy, yz, zz] = [m[at], m[at + 1], m[at + 2], m[at + 3], m[at + 4], m[at + 5]]
  return xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz)
}

// How far a point lies from an ellipsoid's centre, in its standard deviations
function depthIn(point: ArrayLike<number>, at: number, centre: ArrayLike<number>, covariance: ArrayLike<number>) {
  const inverse = new Float64Array(covarianceSize)
  invertCovariance(covariance, 0, inverse, 0)
  const d = [point[at] - centre[0], point[at + 1] - centre[1], point[at + 2] - centre[2]]
  const [xx, xy, xz, yy, yz, zz] = inverse
  const q = d[0] * (xx * d[0] + xy * d[1] + xz * d[2]) + d[1] * (xy * d[0] + yy * d[1] + yz * d[2]) + d[2] * (xz * d[0] + yz * d[1] + zz * d[2])
  return Math.sqrt(q)
}

// A random case: a parent's centre and covariance, and a child's centre, near it or far from it, and its covariance
function randomCase(next: () => number) {
  const parentCentre = new Float64Array([next() * 200 - 100, next() * 200 - 100, next() * 200 - 100])
  const parentCovariance = new Float64Array(covarianceSize)
  randomCovariance(next, parentCovariance, 0)
  const reach = next() * 30
  const own = new Float32Array(shapeSize)
  for (let k = 0; k < 3; k++) own[k] = parentCentre[k] + (next() - 0.5) * reach
  const childCovariance = new Float64Array(covarianceSize)
  randomCovariance(next, childCovariance, 0)
  own.set(childCovariance, 3)
  return { parentCentre, parentCovariance, own }
}

// The shape a child grows from, as a pool's slot holds it
function startOf({ parentCentre, parentCovariance, own }: ReturnType<typeof randomCase>, carries: boolean) {
  const start = new Float32Array(shapeSize)
  writeStart(start, 0, own, 0, own, 3, parentCentre, 0, parentCovariance, 0, carries)
  return start
}

void test("a start point lies within its parent's ellipsoid at half its size, and at the child's own centre where that does", () => {
  const next = randomOf(20261126)
  let inside = 0
  let outside = 0
  for (let k = 0; k < 2000; k++) {
    const shape = randomCase(next)
    const start = startOf(shape, false)
    const own = depthIn(shape.own, 0, shape.parentCentre, shape.parentCovariance)
    const depth = depthIn(start, 0, shape.parentCentre, shape.parentCovariance)
    // Held in single precision, as a slot holds it
    assert.ok(depth <= startDepth * (1 + 1e-4) + 1e-4, `case ${k}: ${depth}`)
    if (own <= startDepth) {
      inside++
      assert.deepEqual([...start.subarray(0, 3)], [...shape.own.subarray(0, 3)])
    } else {
      outside++
      // On the line from the parent's centre to the child's, at the inner ellipsoid's surface
      assert.ok(Math.abs(depth - startDepth) < 1e-3, `case ${k}: ${depth}`)
      const along = (i: number) => (start[i] - shape.parentCentre[i]) / (shape.own[i] - shape.parentCentre[i])
      assert.ok(Math.abs(along(0) - along(1)) < 1e-3 && Math.abs(along(1) - along(2)) < 1e-3, `case ${k}`)
    }
    // Its covariance is its own shrunk by the start's scale
    for (let i = 0; i < covarianceSize; i++) assert.equal(start[3 + i], Math.fround(shape.own[3 + i] * startScale))
  }
  // The sequence reaches both kinds of child
  assert.ok(inside > 100 && outside > 100, `${inside} inside, ${outside} outside`)
})

void test('the start never shrinks a covariance to nothing, and every covariance on the way is positive definite', () => {
  assert.ok(startScale > 0 && startScale < 1e-2)
  const next = randomOf(20261127)
  const grown = new Float64Array(shapeSize)
  const fractions = [0, 1e-6, 1e-4, 0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 1]
  for (let k = 0; k < 500; k++) {
    const shape = randomCase(next)
    for (const carries of [true, false]) {
      const start = startOf(shape, carries)
      for (const t of fractions) {
        grownShape(shape.own, start, t, carries, grown)
        assert.ok(determinant(grown, 3) > 0, `case ${k}, ${carries ? 'carrier' : 'child'}, t ${t}`)
        assert.ok(grown[3] > 0 && grown[6] > 0 && grown[8] > 0)
        // Any other child's covariance is its own scaled by a factor that rises from the start's scale to 1, its size
        // growing evenly
        if (!carries) {
          const factor = grown[3] / shape.own[3]
          assert.ok(Math.abs(factor - mixed(startScale, 1, t * t)) < 1e-5, `case ${k}, t ${t}: ${factor}`)
        }
      }
    }
  }
})

void test("at 0 the carrier is its parent and no other child adds to the sums; at 1 each child is itself; and between, a small step moves little", () => {
  const next = randomOf(20261128)
  const grown = new Float64Array(shapeSize)
  const before = new Float64Array(shapeSize)
  const parentPaint = [200, 40, 90, 255]
  const ownPaint = [10, 250, 30, 128]
  for (let k = 0; k < 500; k++) {
    const shape = randomCase(next)
    for (const carries of [true, false]) {
      const start = startOf(shape, carries)
      grownShape(shape.own, start, 0, carries, grown)
      if (carries) {
        assert.deepEqual([...grown.subarray(0, 3)], [...Float32Array.from(shape.parentCentre)])
        assert.deepEqual([...grown.subarray(3)], [...Float32Array.from(shape.parentCovariance)])
        assert.equal(shareAt(0, true), 1)
      } else {
        assert.equal(shareAt(0, false), 0)
      }
      // The paint starts as the parent's for every child
      assert.deepEqual(parentPaint.map((value, i) => mixed(value, ownPaint[i], 0)), parentPaint)
      grownShape(shape.own, start, 1, carries, grown)
      assert.deepEqual([...grown], [...shape.own])
      assert.deepEqual(parentPaint.map((value, i) => mixed(value, ownPaint[i], 1)), ownPaint)
      assert.equal(shareAt(1, carries), 1)
      // A step of a thousandth moves the centre a thousandth of the way from start to own, the covariance no more than
      // two thousandths of it, and the share no more than a thousandth
      const step = 0.001
      for (let t = step; t <= 1; t += step * 37) {
        grownShape(shape.own, start, t - step, carries, before)
        grownShape(shape.own, start, t, carries, grown)
        for (let i = 0; i < shapeSize; i++) {
          const most = i < 3 ? step : 2 * step
          assert.ok(Math.abs(grown[i] - before[i]) <= Math.abs(shape.own[i] - start[i]) * most * (1 + 1e-9) + 1e-12)
        }
        assert.ok(Math.abs(shareAt(t, carries) - shareAt(t - step, carries)) <= step * (1 + 1e-9))
      }
      // The size runs evenly: the root of the covariance's share of the way between start and own is linear in t for any
      // other child, and its fall for the carrier
      for (const t of [0.1, 0.5, 0.9]) {
        const share = shapeShare(t, carries)
        assert.ok(Math.abs((carries ? Math.sqrt(1 - share) : Math.sqrt(share)) - (carries ? 1 - t : t)) < 1e-12)
      }
    }
  }
})
