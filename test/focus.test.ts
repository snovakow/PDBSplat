import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  atomNameOf,
  emptyStructure,
  residueKey,
  residueNameOf,
  StructureBuilder,
  type AtomRecord,
  type Structure,
} from '../src/pdb/structure.ts'
import type { Focus } from '../src/options.ts'
import { bindingSite, focusTest, hasLigands, pickedKey } from '../src/viewer/focus.ts'

// Which atoms each Focus keeps, on small residue sets built here

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

// A residue's atoms by name, each at its own place along x from the residue's
function residue(residueName: string, residueNumber: number, names: string[], changes: Partial<AtomRecord> = {}) {
  const x = changes.x ?? 0
  return names.map((atomName, i): Partial<AtomRecord> => ({ ...changes, residueName, residueNumber, atomName, x: x + i * 0.1 }))
}

// The atoms a Focus keeps, each named by its residue and its own name
const inFocus = (structure: Structure, focus: Focus, picked: number | null = null) => {
  const kept = focusTest(structure, focus, picked)
  if (!kept) return null
  const names: string[] = []
  for (let atom = 0; atom < structure.atoms.count; atom++) {
    if (!kept(atom)) continue
    const number = structure.residues.number[structure.atoms.residue[atom]]
    names.push(`${residueNameOf(structure, atom)}${number} ${atomNameOf(structure, atom)}`)
  }
  return names
}

// The keys of the residues a binding site keeps
const siteKeys = (structure: Structure, site: Uint8Array) =>
  [...site.keys()].filter((row) => site[row] === 1).map((row) => residueKey(structure, row))

void test('the backbone is a peptide\'s main chain and a nucleotide\'s sugar-phosphate chain', () => {
  const peptide = residue('SER', 1, ['N', 'CA', 'C', 'O', 'OXT', 'CB', 'OG', 'HA'])
  const nucleotide = residue(
    'DG',
    2,
    ['P', 'OP1', 'OP2', 'OP3', "O5'", "C5'", "C4'", "O4'", "C3'", "O3'", "C2'", "O2'", "C1'", 'N9', 'C8', 'N7'],
    { x: 10 },
  )
  // A phosphorylated serine's phosphorus is in its side chain, not a backbone
  const phosphoserine = residue('SEP', 3, ['N', 'CA', 'C', 'O', 'CB', 'OG', 'P', 'O1P', 'O2P', 'O3P'], { x: 20 })
  // A calcium ion shares the name of a carbon alpha, but is in no polymer
  const calcium = residue('CA', 4, ['CA'], { x: 30, element: 'Ca', polymer: false })
  const kept = inFocus(structureOf([...peptide, ...nucleotide, ...phosphoserine, ...calcium]), 'backbone')
  assert.deepEqual(kept, [
    'SER1 N',
    'SER1 CA',
    'SER1 C',
    'SER1 O',
    'SER1 OXT',
    'DG2 P',
    'DG2 OP1',
    'DG2 OP2',
    'DG2 OP3',
    "DG2 O5'",
    "DG2 C5'",
    "DG2 C4'",
    "DG2 O4'",
    "DG2 C3'",
    "DG2 O3'",
    "DG2 C2'",
    "DG2 O2'",
    "DG2 C1'",
    'SEP3 N',
    'SEP3 CA',
    'SEP3 C',
    'SEP3 O',
  ])
})

void test('the ligands focus keeps each ligand, the residues within 5 Å of it and a near water, and leaves the rest', () => {
  const ligand = residue('HEM', 142, ['FE', 'NA'], { polymer: false, element: 'Fe' })
  // The near residue's first atom lies 4.9 Å away, and its others farther, which its first atom keeps in focus
  const near = residue('HIS', 87, ['N', 'CA', 'CB', 'NE2'], { x: 4.9 })
  const far = residue('LEU', 88, ['N', 'CA'], { x: 5.2 })
  const nearWater = residue('HOH', 301, ['O'], { y: 3, water: true, polymer: false, element: 'O' })
  const farWater = residue('HOH', 302, ['O'], { y: 6, water: true, polymer: false, element: 'O' })
  const entry = structureOf([...ligand, ...near, ...far, ...nearWater, ...farWater])
  const kept = inFocus(entry, 'ligands')
  assert.deepEqual(kept, ['HEM142 FE', 'HEM142 NA', 'HIS87 N', 'HIS87 CA', 'HIS87 CB', 'HIS87 NE2', 'HOH301 O'])
  const site = bindingSite(entry)
  assert.ok(site)
  assert.deepEqual(siteKeys(entry, site).sort(), ['A 142 ', 'A 301 ', 'A 87 '])
  // The site is kept beside the entry
  assert.equal(bindingSite(entry), site)
  assert.equal(hasLigands(entry), true)
})

void test('an entry without ligands keeps every atom, as does a model without them', () => {
  const protein = structureOf([...residue('ALA', 1, ['N', 'CA']), ...residue('HOH', 301, ['O'], { water: true, polymer: false })])
  assert.equal(focusTest(protein, 'ligands', null), null)
  assert.equal(bindingSite(protein), null)
  assert.equal(hasLigands(protein), false)
  assert.equal(hasLigands(emptyStructure), false)
  const twoModels = [
    ...residue('HEM', 142, ['FE'], { polymer: false }),
    ...residue('LEU', 88, ['N'], { x: 9 }),
    ...residue('LEU', 88, ['N'], { x: 9, model: 2 }),
  ]
  const both = structureOf(twoModels)
  assert.deepEqual(inFocus(both, 'ligands'), ['HEM142 FE', 'LEU88 N'])
  const kept = focusTest(both, 'ligands', null)
  assert.ok(kept)
  assert.equal(kept(1), false)
  assert.equal(kept(2), true)
  // An entry has ligands where any of its models does, which is where it has a binding site
  assert.equal(hasLigands(both), true)
  assert.equal(hasLigands(structureOf(twoModels.slice(1))), false)
  assert.equal(bindingSite(structureOf(twoModels.slice(1))), null)
  // As the binding site is, they're found among the first conformations
  const laterOnly = structureOf(residue('HEM', 142, ['FE'], { polymer: false, altLoc: 'B', firstConformation: false }))
  assert.equal(hasLigands(laterOnly), false)
  assert.equal(bindingSite(laterOnly), null)
})

void test('the picked residue and chain keep the picked atom\'s, and nothing is kept out without a pick', () => {
  const entry = structureOf([
    ...residue('ALA', 1, ['N', 'CA']),
    ...residue('GLY', 2, ['N', 'CA']),
    ...residue('GLY', 2, ['N', 'CA'], { chain: 'B', labelChain: 'B' }),
    ...residue('GLY', 2, ['N', 'CA'], { insertion: 'A' }),
  ])
  // The picked atom is GLY 2's nitrogen in chain A
  const picked = 2
  const residueOf = pickedKey(entry, 'residue', picked)
  const chainOf = pickedKey(entry, 'chain', picked)
  assert.deepEqual(inFocus(entry, 'residue', residueOf), ['GLY2 N', 'GLY2 CA'])
  assert.deepEqual(inFocus(entry, 'chain', chainOf), ['ALA1 N', 'ALA1 CA', 'GLY2 N', 'GLY2 CA', 'GLY2 N', 'GLY2 CA'])
  assert.equal(inFocus(entry, 'chain', pickedKey(entry, 'chain', 4))?.length, 2)
  assert.equal(focusTest(entry, 'residue', null), null)
  assert.equal(focusTest(entry, 'chain', null), null)
  assert.equal(focusTest(entry, 'all', null), null)
  assert.equal(focusTest(entry, 'all', residueOf), null)
})

void test('the picked residue and chain stay in focus in every model', () => {
  const entry = structureOf([
    ...residue('ALA', 1, ['N', 'CA']),
    ...residue('GLY', 2, ['N', 'CA']),
    ...residue('ALA', 1, ['N', 'CA'], { model: 2 }),
    ...residue('GLY', 2, ['N', 'CA'], { model: 2 }),
    ...residue('GLY', 2, ['N'], { model: 2, chain: 'B', labelChain: 'B' }),
  ])
  assert.deepEqual(inFocus(entry, 'residue', pickedKey(entry, 'residue', 2)), ['GLY2 N', 'GLY2 CA', 'GLY2 N', 'GLY2 CA'])
  assert.equal(inFocus(entry, 'chain', pickedKey(entry, 'chain', 0))?.length, 8)
})

void test('pickedKey names the picked residue or chain for those focuses alone', () => {
  const entry = structureOf([{}, { chain: 'B', labelChain: 'B', residueNumber: 52, insertion: 'A' }])
  const picked = 1
  assert.equal(pickedKey(entry, 'residue', picked), 1)
  assert.equal(residueKey(entry, 1), 'B 52 A')
  assert.equal(pickedKey(entry, 'chain', picked), 1)
  assert.equal(entry.chains.name[1], 'B')
  assert.equal(pickedKey(entry, 'all', picked), null)
  assert.equal(pickedKey(entry, 'ligands', picked), null)
  assert.equal(pickedKey(entry, 'backbone', picked), null)
  assert.equal(pickedKey(entry, 'residue', null), null)
  assert.equal(pickedKey(entry, 'chain', null), null)
})
