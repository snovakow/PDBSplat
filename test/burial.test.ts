import assert from 'node:assert/strict'
import { test } from 'node:test'
import { burial } from '../src/pdb/burial.ts'
import { StructureBuilder, type AtomRecord, type Structure } from '../src/pdb/structure.ts'

// How deeply the atoms around an atom bury it, on clusters built here

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

// A structure of the atoms given, each the base atom with its changes, in order
function structureOf(atoms: Partial<AtomRecord>[]): Structure {
  const builder = new StructureBuilder()
  for (const changes of atoms) builder.add({ ...base, ...changes })
  return builder.finish()
}

// A heavy atom's weight in another's burial, by their distance: (1 − (d/R)²)² within R = 10 Å
const weight = (distance: number) => (1 - (distance * distance) / 100) ** 2

// The sums are exact in these hand cases, so the tolerance is rounding alone
const tolerance = 1e-12
const assertClose = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} for ${expected}`)

// A cube of carbons 1.5 Å apart, side atoms along each edge
function lattice(side: number) {
  const atoms: Partial<AtomRecord>[] = []
  const half = (side - 1) / 2
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      for (let k = 0; k < side; k++) atoms.push({ x: (i - half) * 1.5, y: (j - half) * 1.5, z: (k - half) * 1.5 })
    }
  }
  return atoms
}

void test('a lone atom buries nothing', () => {
  const { values, low, high } = burial(structureOf([{}]))
  assert.equal(values[0], 0)
  assert.equal(low, 0)
  assert.equal(high, 0)
})

void test('the centre of a dense cluster is buried to 1, and its edge falls towards 0', () => {
  const side = 7
  const atoms = lattice(side)
  const structure = structureOf(atoms)
  const { values } = burial(structure)
  const at = (x: number, y: number, z: number) => {
    const found = atoms.findIndex((candidate) => candidate.x === x && candidate.y === y && candidate.z === z)
    assert.ok(found >= 0)
    return values[found]
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
  assert.equal(values.length, structure.atoms.count)
})

void test('hydrogens and waters are buried but bury nothing', () => {
  const hydrogen = { x: -1, element: 'H', atomName: 'HA', hydrogen: true }
  const water = { z: -1, element: 'O', atomName: 'O', residueName: 'HOH', water: true, polymer: false }
  // Two heavy atoms 5 Å apart, the rows 0 and 1, then the hydrogen and the water
  const { values, low, high } = burial(structureOf([{ x: 0 }, { x: 5 }, hydrogen, water]))
  // Each heavy atom's sum is the other's weight alone; the hydrogen and the water are buried by both
  const heavy = weight(5)
  const hydrogenSum = weight(1) + weight(6)
  // The percentiles are of the atoms other than waters: the 5th lies between the two heavy sums, and the 95th nine
  // tenths of the way from the second heavy sum to the hydrogen's
  assertClose(low, heavy)
  assertClose(high, heavy + 0.9 * (hydrogenSum - heavy))
  assert.deepEqual([...values], [0, 0, 1, 1])
})

void test('atoms in different models, and later conformations, bury nothing', () => {
  const sameModel = burial(structureOf([{ x: 0 }, { x: 2 }]))
  assertClose(sameModel.low, weight(2))
  assertClose(sameModel.high, weight(2))
  const twoModels = burial(structureOf([{ x: 0, model: 1 }, { x: 2, model: 2 }]))
  assert.equal(twoModels.low, 0)
  assert.equal(twoModels.high, 0)
  const alternate = burial(structureOf([{ x: 0 }, { x: 2, altLoc: 'B', firstConformation: false }]))
  assert.equal(alternate.low, 0)
  assert.equal(alternate.high, 0)
})

void test('the burial is kept beside the entry', () => {
  const structure = structureOf(lattice(3))
  assert.equal(burial(structure), burial(structure))
  assert.notEqual(burial(structureOf(lattice(3))), burial(structure))
})
