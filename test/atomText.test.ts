import assert from 'node:assert/strict'
import { test } from 'node:test'
import { atomText } from '../src/atomText.ts'
import type { Atom } from '../src/pdb/mmcif.ts'

// How the panel names an atom

const base: Atom = {
  element: 'Fe',
  x: 0,
  y: 0,
  z: 0,
  chain: 'A',
  residueName: 'HEM',
  residueNumber: 142,
  insertion: '',
  atomName: 'FE',
  altLoc: '',
  occupancy: 1,
  bFactor: 20,
  model: 1,
  firstConformation: true,
  hetero: true,
  polymer: false,
  hydrogen: false,
  water: false,
  structure: 'none',
  u: null,
}
const atom = (changes: Partial<Atom>): Atom => ({ ...base, ...changes })

void test('an atom is named by its residue, chain, number and its own name', () => {
  assert.equal(atomText(atom({}), false), 'HEM A142 FE')
})

void test('an insertion code follows the number', () => {
  assert.equal(atomText(atom({ residueName: 'SER', residueNumber: 52, insertion: 'A', atomName: 'OG', element: 'O' }), false), 'SER A52A OG')
})

void test('an alternate ID and a model follow when the atom has one and the entry several', () => {
  const alternate = atom({ residueName: 'SER', residueNumber: 22, atomName: 'OG', altLoc: 'B', element: 'O' })
  assert.equal(atomText(alternate, false), 'SER A22 OG alt B')
  const inModel = atom({ residueName: 'MET', residueNumber: 1, atomName: 'N', element: 'N', model: 3 })
  assert.equal(atomText(inModel, false), 'MET A1 N')
  assert.equal(atomText(inModel, true), 'MET A1 N model 3')
  assert.equal(atomText({ ...alternate, model: 3 }, true), 'SER A22 OG alt B model 3')
})
