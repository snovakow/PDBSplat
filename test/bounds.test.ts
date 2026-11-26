import assert from 'node:assert/strict'
import { test } from 'node:test'
import { broadsideAngle, measureBounds, RunningBounds } from '../src/pdb/bounds.ts'
import { vdwRadii } from '../src/pdb/elements.ts'
import { defaultAtoms, StructureBuilder, type AtomRecord, type Structure } from '../src/pdb/structure.ts'

// The side a structure opens on: that the camera looks along the level direction the atoms spread least along, from
// the way nearer the z axis, and down the z axis itself where the spread says nothing; and the bounds as an entry
// arrives, which always hold the exact bounds of the atoms so far and end on the whole's

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

// A carbon alpha of alanine 1 in chain A, model 1, which each atom below changes
const base: AtomRecord = {
  x: 0,
  y: 0,
  z: 0,
  element: 'C',
  atomName: 'CA',
  altLoc: '',
  occupancy: 1,
  bFactor: 20,
  model: 1,
  chain: 'A',
  labelChain: 'A',
  residueName: 'ALA',
  residueNumber: 1,
  insertion: '',
  hydrogen: false,
  water: false,
  firstConformation: true,
  polymer: true,
}

// Chains of residues laid along curves far from the origin, with a later conformation, waters of the first chain
// after every chain, and a second model, which the bounds leave out but for the waters
function spread(): Structure {
  const builder = new StructureBuilder()
  const chains = ['A', 'B', 'C', 'D']
  for (const [c, chain] of chains.entries()) {
    for (let residue = 1; residue <= 40; residue++) {
      for (const [k, element] of ['N', 'C', 'C', 'O', 'S'].entries()) {
        const t = residue / 6 + c * 2
        builder.add({
          ...base,
          chain,
          labelChain: chain,
          residueNumber: residue,
          element,
          atomName: `${element}${k}`,
          x: 800 + 30 * Math.cos(t) + c * 15 + k,
          y: -400 + residue * 1.5 * (c % 2 ? 1 : -1),
          z: 200 + 30 * Math.sin(t) * (c + 1) + k / 2,
        })
      }
      if (residue % 7 === 0) builder.add({ ...base, chain, labelChain: chain, residueNumber: residue, altLoc: 'B', firstConformation: false, x: 2000 })
    }
  }
  for (let water = 0; water < 30; water++) {
    builder.add({ ...base, labelChain: 'E', residueName: 'HOH', element: 'O', water: true, polymer: false, residueNumber: 100 + water, x: 760 + water * 3, y: -480, z: 150 })
  }
  for (let residue = 1; residue <= 10; residue++) builder.add({ ...base, model: 2, residueNumber: residue, x: -5000 })
  return builder.finish()
}

void test('the bounds kept as atoms arrive are the exact bounds of the atoms so far, by stretches of any size, but for a hair', () => {
  const structure = spread()
  const radii = vdwRadii(structure.elements)
  const { residues, atoms } = structure
  for (const stretch of ['residue', 1000, 'whole'] as const) {
    const bounds = new RunningBounds()
    let from = 0
    let checked = 0
    while (from < atoms.count) {
      // A stretch ends at a residue's start, as a batch does
      let to = stretch === 'whole' ? atoms.count : Math.min(atoms.count, from + (stretch === 'residue' ? 1 : stretch))
      while (to < atoms.count && atoms.residue[to] === atoms.residue[to - 1]) to++
      bounds.add(structure, from, to)
      from = to
      const running = bounds.bounds(structure)
      const arrived = defaultAtoms(structure).filter((atom) => atom < to)
      const exact = measureBounds(structure, arrived)
      assert.deepEqual(running.center, exact.center, `${stretch} at ${to}`)
      assert.ok(running.radius >= exact.radius && running.radius <= exact.radius * (1 + 1e-8), `${stretch} at ${to}`)
      // Every atom so far lies within them, its van der Waals sphere and all
      for (const atom of arrived) {
        const reach =
          Math.hypot(
            atoms.positions[atom * 3] - running.center[0],
            atoms.positions[atom * 3 + 1] - running.center[1],
            atoms.positions[atom * 3 + 2] - running.center[2],
          ) + radii[atoms.element[atom]]
        assert.ok(reach <= running.radius, `${stretch} at ${to}: atom ${atom}`)
      }
      assert.ok(Math.abs(running.broadside - exact.broadside) < 1e-9, `${stretch} at ${to}`)
      checked++
    }
    assert.ok(checked >= (stretch === 'residue' ? residues.count : 1))
    assert.deepEqual(bounds.bounds(structure).center, measureBounds(structure, defaultAtoms(structure)).center)
  }
})

void test('the bounds of no atoms are empty, and an atom alone is its own centre and radius', () => {
  const bounds = new RunningBounds()
  const builder = new StructureBuilder()
  builder.add({ ...base, x: 3, y: 4, z: 5, element: 'S' })
  const structure = builder.finish()
  assert.equal(bounds.bounds(structure).radius, 0)
  bounds.add(structure, 0, 1)
  const one = bounds.bounds(structure)
  assert.deepEqual(one.center, [3, 4, 5])
  assert.ok(Math.abs(one.radius / vdwRadii(['S'])[0] - 1) < 1e-8)
})

void test("the bounds of a shell of chains as far out as each other hold every atom, measuring only a batch's share", () => {
  // Three hundred chains of three hundred atoms on a sphere, as a capsid's are, each a small patch
  const builder = new StructureBuilder()
  for (let chain = 0; chain < 300; chain++) {
    const phi = Math.acos(1 - (2 * (chain + 0.5)) / 300)
    const theta = chain * 2.39996
    for (let atom = 0; atom < 300; atom++) {
      const r = 500 + (atom % 10)
      const p = phi + (atom % 17) * 0.002
      const t = theta + Math.floor(atom / 17) * 0.002
      builder.add({ ...base, chain: `C${chain}`, labelChain: `C${chain}`, residueNumber: Math.floor(atom / 10) + 1, x: 1000 + r * Math.sin(p) * Math.cos(t), y: r * Math.sin(p) * Math.sin(t), z: r * Math.cos(p) })
    }
  }
  const structure = builder.finish()
  const radii = vdwRadii(structure.elements)
  const bounds = new RunningBounds()
  let worst = 0
  for (let from = 0; from < structure.atoms.count; from += 1000) {
    const to = Math.min(structure.atoms.count, from + 1000)
    bounds.add(structure, from, to)
    const running = bounds.bounds(structure)
    const arrived = defaultAtoms(structure).filter((atom) => atom < to)
    const exact = measureBounds(structure, arrived)
    assert.deepEqual(running.center, exact.center)
    for (const atom of arrived) {
      const { positions } = structure.atoms
      const reach = Math.hypot(positions[atom * 3] - running.center[0], positions[atom * 3 + 1] - running.center[1], positions[atom * 3 + 2] - running.center[2]) + radii[structure.atoms.element[atom]]
      assert.ok(reach <= running.radius * (1 + 1e-12), `at ${to}: atom ${atom}`)
    }
    worst = Math.max(worst, running.radius / exact.radius - 1)
  }
  // Never more than a few percent over, the way the centroid moved since a chain was last measured
  assert.ok(worst < 0.05, `the running radius was ${(worst * 100).toFixed(2)}% over the exact`)
})
