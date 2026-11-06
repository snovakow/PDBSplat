import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Atom } from '../src/pdb/mmcif.ts'
import { writeEllipsoid } from '../src/viewer/ellipsoids.ts'

// The thermal ellipsoids' covariances, from tensors with known eigenvalues built here

const base: Atom = {
  element: 'C',
  x: 0,
  y: 0,
  z: 0,
  chain: 'A',
  residueName: 'ALA',
  residueNumber: 1,
  insertion: '',
  atomName: 'CA',
  altLoc: '',
  occupancy: 1,
  bFactor: 20,
  model: 1,
  firstConformation: true,
  hetero: false,
  polymer: true,
  hydrogen: false,
  water: false,
  structure: 'none',
  u: null,
}
const atom = (changes: Partial<Atom>): Atom => ({ ...base, ...changes })

// The share of U a splat's covariance takes at Size 1: a quarter of the median of χ² with three degrees of freedom
const share = 2.365974 / 4
// A B-factor is 8π² times the mean square displacement along an axis
const bPerU = 8 * Math.PI * Math.PI
// The least variance along any direction, in square ångströms
const floor = 0.05 * 0.05

// The covariances are written in single precision, which measured within 6e-8 of the double-precision values here
const relativeTolerance = 1e-6
// The floor's own rounding to single precision is 5.6e-11 below it
const floorTolerance = 1e-9

type Matrix = number[][]

// The rotation by an angle about an axis
function rotation([x, y, z]: number[], angle: number): Matrix {
  const length = Math.hypot(x, y, z)
  const [ux, uy, uz] = [x / length, y / length, z / length]
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = 1 - c
  return [
    [c + ux * ux * k, ux * uy * k - uz * s, ux * uz * k + uy * s],
    [uy * ux * k + uz * s, c + uy * uy * k, uy * uz * k - ux * s],
    [uz * ux * k - uy * s, uz * uy * k + ux * s, c + uz * uz * k],
  ]
}

const frame = rotation([1, 2, 3], 0.7)
const axis = (k: number) => [frame[0][k], frame[1][k], frame[2][k]]

// A symmetric tensor with the frame's columns as its eigenvectors and the given eigenvalues, in the six-value order of
// an atom's U: U11, U12, U13, U22, U23, U33
function tensor(eigenvalues: number[]) {
  const m: Matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) m[i][j] += frame[i][k] * eigenvalues[k] * frame[j][k]
    }
  }
  return Float32Array.of(m[0][0], m[0][1], m[0][2], m[1][1], m[1][2], m[2][2])
}

function covariance(target: Atom, scale = 1) {
  const written = new Float32Array(8)
  writeEllipsoid(written, 2, target, scale)
  // Nothing is written outside the six values
  assert.deepEqual(Array.from(written.subarray(0, 2)), [0, 0])
  return Array.from(written.subarray(2))
}

// The variance of the covariance along a unit direction
function variance([xx, xy, xz, yy, yz, zz]: number[], [x, y, z]: number[]) {
  return xx * x * x + yy * y * y + zz * z * z + 2 * (xy * x * y + xz * x * z + yz * y * z)
}

function assertClose(actual: number[], expected: number[]) {
  for (let k = 0; k < 6; k++) {
    const tolerance = Math.max(Math.abs(expected[k]) * relativeTolerance, floorTolerance)
    assert.ok(Math.abs(actual[k] - expected[k]) <= tolerance, `value ${k}: ${actual[k]} for ${expected[k]}`)
  }
}

// A deterministic spread of unit directions
function directions(count: number) {
  let seed = 7
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648 - 0.5
  }
  return Array.from({ length: count }, () => {
    const v = [next(), next(), next()]
    const length = Math.hypot(...v)
    return v.map((c) => c / length)
  })
}

void test('an atom without a tensor gets an isotropic covariance from its B-factor', () => {
  const expected = (20 / bPerU) * share
  assert.ok(expected > floor)
  assertClose(covariance(atom({ bFactor: 20 })), [expected, 0, 0, expected, 0, expected])
})

void test('a tensor with eigenvalues above the floor is written as it is', () => {
  const u = tensor([0.02, 0.03, 0.05])
  assertClose(
    covariance(atom({ u })),
    Array.from(u, (value) => value * share),
  )
})

void test('a tensor with a negative eigenvalue comes out positive definite, with every direction at least the floor', () => {
  const eigenvalues = [0.01, -0.002, 0.03]
  const written = covariance(atom({ u: tensor(eigenvalues) }))
  eigenvalues.forEach((eigenvalue, k) => {
    const expected = Math.max(eigenvalue * share, floor)
    const along = variance(written, axis(k))
    assert.ok(Math.abs(along - expected) <= Math.max(expected * relativeTolerance, floorTolerance), `axis ${k}: ${along}`)
  })
  for (const direction of directions(1000)) {
    assert.ok(variance(written, direction) >= floor - floorTolerance, `direction ${direction.join(', ')} below the floor`)
  }
})

void test('a B-factor of 0 gives the floor in every direction', () => {
  assertClose(covariance(atom({ bFactor: 0 })), [floor, 0, 0, floor, 0, floor])
  assertClose(covariance(atom({ bFactor: 0 }), 3), [floor, 0, 0, floor, 0, floor])
  assertClose(covariance(atom({ bFactor: -5 })), [floor, 0, 0, floor, 0, floor])
})

void test('Size scales the covariance by its square', () => {
  const u = tensor([0.02, 0.03, 0.05])
  const atSizeOne = covariance(atom({ u }))
  assertClose(
    covariance(atom({ u }), 2),
    atSizeOne.map((value) => value * 4),
  )
  assertClose(
    covariance(atom({ bFactor: 20 }), 0.5),
    covariance(atom({ bFactor: 20 })).map((value) => value / 4),
  )
})
