import assert from 'node:assert/strict'
import { test } from 'node:test'
import { residueKey, type Atom } from '../src/pdb/mmcif.ts'
import type { Focus } from '../src/options.ts'
import { bindingSite, focusTest, pickedKey } from '../src/viewer/focus.ts'

// Which atoms each Focus keeps, on small residue sets built here

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
  polymer: true,
  hydrogen: false,
  water: false,
  structure: 'none',
  u: null,
}
const atom = (changes: Partial<Atom>): Atom => ({ ...base, ...changes })

// A residue's atoms by name, each at its own place along x from the residue's
function residue(residueName: string, residueNumber: number, names: string[], changes: Partial<Atom> = {}) {
  const { x = 0, ...rest } = changes
  return names.map((atomName, i) => atom({ residueName, residueNumber, atomName, ...rest, x: x + i * 0.1 }))
}

const inFocus = (entry: readonly Atom[], focus: Focus, picked: string | null = null) => {
  const kept = focusTest(entry, focus, picked)
  return kept && entry.filter(kept).map((found) => `${found.residueName}${found.residueNumber} ${found.atomName}`)
}

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
  const kept = inFocus([...peptide, ...nucleotide, ...phosphoserine, ...calcium], 'backbone')
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
  const entry = [...ligand, ...near, ...far, ...nearWater, ...farWater]
  const kept = inFocus(entry, 'ligands')
  assert.deepEqual(kept, ['HEM142 FE', 'HEM142 NA', 'HIS87 N', 'HIS87 CA', 'HIS87 CB', 'HIS87 NE2', 'HOH301 O'])
  const site = bindingSite(entry)
  assert.ok(site)
  assert.deepEqual([...site.keys()], [1])
  assert.deepEqual([...(site.get(1) ?? [])].sort(), ['A 142 ', 'A 301 ', 'A 87 '])
  // The site is kept beside the entry
  assert.equal(bindingSite(entry), site)
})

void test('an entry without ligands keeps every atom, as does a model without them', () => {
  const protein = [...residue('ALA', 1, ['N', 'CA']), ...residue('HOH', 301, ['O'], { water: true, polymer: false })]
  assert.equal(focusTest(protein, 'ligands', null), null)
  assert.equal(bindingSite(protein), null)
  const twoModels = [
    ...residue('HEM', 142, ['FE'], { polymer: false }),
    ...residue('LEU', 88, ['N'], { x: 9 }),
    ...residue('LEU', 88, ['N'], { x: 9, model: 2 }),
  ]
  assert.deepEqual(inFocus(twoModels, 'ligands'), ['HEM142 FE', 'LEU88 N'])
  const kept = focusTest(twoModels, 'ligands', null)
  assert.ok(kept)
  assert.equal(kept(twoModels[2]), true)
})

void test('the picked residue and chain keep the picked atom\'s, and nothing is kept out without a pick', () => {
  const entry = [
    ...residue('ALA', 1, ['N', 'CA']),
    ...residue('GLY', 2, ['N', 'CA']),
    ...residue('GLY', 2, ['N', 'CA'], { chain: 'B' }),
    ...residue('GLY', 2, ['N', 'CA'], { insertion: 'A' }),
  ]
  const picked = entry[2]
  assert.deepEqual(inFocus(entry, 'residue', residueKey(picked)), ['GLY2 N', 'GLY2 CA'])
  assert.deepEqual(inFocus(entry, 'chain', picked.chain), ['ALA1 N', 'ALA1 CA', 'GLY2 N', 'GLY2 CA', 'GLY2 N', 'GLY2 CA'])
  assert.equal(inFocus(entry, 'chain', 'B')?.length, 2)
  assert.equal(focusTest(entry, 'residue', null), null)
  assert.equal(focusTest(entry, 'chain', null), null)
  assert.equal(focusTest(entry, 'all', null), null)
  assert.equal(focusTest(entry, 'all', residueKey(picked)), null)
})

void test('pickedKey names the picked residue or chain for those focuses alone', () => {
  const picked = atom({ chain: 'B', residueNumber: 52, insertion: 'A' })
  assert.equal(pickedKey('residue', picked), 'B 52 A')
  assert.equal(pickedKey('chain', picked), 'B')
  assert.equal(pickedKey('all', picked), null)
  assert.equal(pickedKey('ligands', picked), null)
  assert.equal(pickedKey('backbone', picked), null)
  assert.equal(pickedKey('residue', null), null)
  assert.equal(pickedKey('chain', null), null)
})
