import assert from 'node:assert/strict'
import { test } from 'node:test'
import { broadsideAngle } from '../src/viewer/bounds.ts'

// The side a structure opens on: that the camera looks along the level direction the atoms spread least along, from
// the way nearer the z axis, and down the z axis itself where the spread says nothing

// How far a structure spreads along the level direction at an angle from the z axis towards x, from the sums of its
// atoms' squares and product
function spreadAlong(angle: number, xx: number, xz: number, zz: number) {
  const x = Math.sin(angle)
  const z = Math.cos(angle)
  return xx * x * x + 2 * xz * x * z + zz * z * z
}

// Whether two angles agree to within rounding, which also takes the zero the arithmetic gives with a minus sign
function same(angle: number, expected: number) {
  return Math.abs(angle - expected) < 1e-12
}

void test('a structure spread along x opens down the z axis, and one spread along z from its side', () => {
  assert.ok(same(broadsideAngle(4, 0, 1), 0))
  // A quarter turn, to look along x at the spread along z
  assert.ok(same(Math.abs(broadsideAngle(1, 0, 4)), Math.PI / 2))
  // Spread along the diagonal between x and z, it's seen from the other diagonal
  assert.ok(same(broadsideAngle(3, 2, 3), -Math.PI / 4))
  assert.ok(same(broadsideAngle(3, -2, 3), Math.PI / 4))
})

void test('a structure spread evenly opens down the z axis, as the file gives it', () => {
  assert.ok(same(broadsideAngle(2, 0, 2), 0))
  assert.ok(same(broadsideAngle(0, 0, 0), 0))
})

void test('the camera looks along the direction of least spread, from within a quarter turn of the z axis', () => {
  // Sums of squares and products as atoms give them: xx and zz above 0, and xz within what they allow
  const spreads = [
    [5, 1, 2],
    [2, -1.3, 1],
    [1, 0.9, 1],
    [7, -6, 6],
    [0.5, 0.2, 9],
    [120, 35, 80],
  ]
  for (const [xx, xz, zz] of spreads) {
    const label = `${xx} ${xz} ${zz}`
    const angle = broadsideAngle(xx, xz, zz)
    assert.ok(Math.cos(angle) >= 0, label)
    const along = spreadAlong(angle, xx, xz, zz)
    for (let degrees = 0; degrees < 360; degrees++) {
      const other = spreadAlong((degrees * Math.PI) / 180, xx, xz, zz)
      assert.ok(along <= other + 1e-9, `${label} at ${degrees}°`)
    }
    // The spread across the view is then the greatest there is
    const across = spreadAlong(angle + Math.PI / 2, xx, xz, zz)
    assert.ok(Math.abs(across + along - (xx + zz)) < 1e-9, label)
    // And the angle is the structure's, whatever its size or its number of atoms
    assert.ok(same(broadsideAngle(xx * 40, xz * 40, zz * 40), angle), label)
  }
})
