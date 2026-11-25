import assert from 'node:assert/strict'
import { test } from 'node:test'
import { atomText } from '../src/atomText.ts'
import { StructureBuilder, type AtomRecord, type Structure } from '../src/pdb/structure.ts'

// How the panel names an atom

const base: AtomRecord = {
  x: 0,
  y: 0,
  z: 0,
  element: 'Fe',
  atomName: 'FE',
  altLoc: '',
  occupancy: 1,
  bFactor: 20,
  model: 1,
  chain: 'A',
  labelChain: 'A',
  residueName: 'HEM',
  residueNumber: 142,
  insertion: '',
  hydrogen: false,
  water: false,
  firstConformation: true,
  polymer: false,
}

// A structure of one atom, the base atom with its changes
function structureOf(changes: Partial<AtomRecord>): Structure {
  const builder = new StructureBuilder()
  builder.add({ ...base, ...changes })
  return builder.finish()
}

// The text of a structure's one atom
const text = (changes: Partial<AtomRecord>, manyModels: boolean) => atomText(structureOf(changes), 0, manyModels)

void test('an atom is named by its residue, chain, number and its own name', () => {
  assert.equal(text({}, false), 'HEM A142 FE')
})

void test('an insertion code follows the number', () => {
  assert.equal(text({ residueName: 'SER', residueNumber: 52, insertion: 'A', atomName: 'OG', element: 'O' }, false), 'SER A52A OG')
})

void test('an alternate ID and a model follow when the atom has one and the entry several', () => {
  const alternate = { residueName: 'SER', residueNumber: 22, atomName: 'OG', altLoc: 'B', element: 'O' }
  assert.equal(text(alternate, false), 'SER A22 OG alt B')
  const inModel = { residueName: 'MET', residueNumber: 1, atomName: 'N', element: 'N', model: 3 }
  assert.equal(text(inModel, false), 'MET A1 N')
  assert.equal(text(inModel, true), 'MET A1 N model 3')
  assert.equal(text({ ...alternate, model: 3 }, true), 'SER A22 OG alt B model 3')
})

void test("an atom of another chemical form of its residue is named by its own form", () => {
  const builder = new StructureBuilder()
  builder.add({ ...base, residueName: 'PRO', residueNumber: 22, atomName: 'CA', element: 'C', altLoc: 'A', polymer: true })
  builder.add({ ...base, residueName: 'SER', residueNumber: 22, atomName: 'CA', element: 'C', altLoc: 'B', polymer: true })
  const structure = builder.finish()
  assert.equal(atomText(structure, 0, false), 'PRO A22 CA alt A')
  assert.equal(atomText(structure, 1, false), 'SER A22 CA alt B')
})
