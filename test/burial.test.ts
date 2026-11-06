import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { burial } from '../src/pdb/burial.ts'
import type { Atom } from '../src/pdb/mmcif.ts'

// How deeply the atoms around an atom bury it, on clusters built here

// The module reports its timing on the console, which the suite's output does without
mock.method(console, 'info', () => undefined)
after(() => mock.restoreAll())

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

// A heavy atom's weight in another's burial, by their distance: (1 − (d/R)²)² within R = 10 Å
const weight = (distance: number) => (1 - (distance * distance) / 100) ** 2

// The sums are exact in these hand cases, so the tolerance is rounding alone
const tolerance = 1e-12
const assertClose = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} for ${expected}`)

// A cube of carbons 1.5 Å apart, side atoms along each edge
function lattice(side: number) {
  const atoms: Atom[] = []
  const half = (side - 1) / 2
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      for (let k = 0; k < side; k++) atoms.push(atom({ x: (i - half) * 1.5, y: (j - half) * 1.5, z: (k - half) * 1.5 }))
    }
  }
  return atoms
}

void test('a lone atom buries nothing', () => {
  const lone = atom({})
  const { values, low, high } = burial([lone])
  assert.equal(values.get(lone), 0)
  assert.equal(low, 0)
  assert.equal(high, 0)
})

void test('the centre of a dense cluster is buried to 1, and its edge falls towards 0', () => {
  const side = 7
  const atoms = lattice(side)
  const { values } = burial(atoms)
  const at = (x: number, y: number, z: number) => {
    const found = atoms.find((candidate) => candidate.x === x && candidate.y === y && candidate.z === z)
    assert.ok(found)
    const value = values.get(found)
    assert.notEqual(value, undefined)
    return value ?? NaN
  }
  const edge = ((side - 1) / 2) * 1.5
  assert.equal(at(0, 0, 0), 1)
  assert.equal(at(-edge, -edge, -edge), 0)
  assert.equal(at(edge, edge, edge), 0)
  // Measured: the middle of a face is buried to 0.55, and the middle of an edge to 0.14
  const face = at(-edge, 0, 0)
  const edgeMiddle = at(-edge, -edge, 0)
  assert.ok(face < 1 && face > edgeMiddle, `face ${face}, edge ${edgeMiddle}`)
  assert.ok(edgeMiddle > 0 && edgeMiddle < 0.25, `edge ${edgeMiddle}`)
  assert.equal(values.size, atoms.length)
})

void test('hydrogens and waters are buried but bury nothing', () => {
  const a = atom({ x: 0 })
  const b = atom({ x: 5 })
  const hydrogen = atom({ x: -1, element: 'H', atomName: 'HA', hydrogen: true })
  const water = atom({ z: -1, element: 'O', atomName: 'O', residueName: 'HOH', water: true, polymer: false })
  const { values, low, high } = burial([a, b, hydrogen, water])
  // Each heavy atom's sum is the other's weight alone; the hydrogen and the water are buried by both
  const heavy = weight(5)
  const hydrogenSum = weight(1) + weight(6)
  // The percentiles are of the atoms other than waters: the 5th lies between the two heavy sums, and the 95th nine
  // tenths of the way from the second heavy sum to the hydrogen's
  assertClose(low, heavy)
  assertClose(high, heavy + 0.9 * (hydrogenSum - heavy))
  assert.equal(values.get(a), 0)
  assert.equal(values.get(b), 0)
  assert.equal(values.get(hydrogen), 1)
  assert.equal(values.get(water), 1)
})

void test('atoms in different models, and later conformations, bury nothing', () => {
  const sameModel = burial([atom({ x: 0 }), atom({ x: 2 })])
  assertClose(sameModel.low, weight(2))
  assertClose(sameModel.high, weight(2))
  const twoModels = burial([atom({ x: 0, model: 1 }), atom({ x: 2, model: 2 })])
  assert.equal(twoModels.low, 0)
  assert.equal(twoModels.high, 0)
  const alternate = burial([atom({ x: 0 }), atom({ x: 2, altLoc: 'B', firstConformation: false })])
  assert.equal(alternate.low, 0)
  assert.equal(alternate.high, 0)
})

void test('the burial is kept beside the entry', () => {
  const atoms = lattice(3)
  assert.equal(burial(atoms), burial(atoms))
})
