import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chainOf,
  copyPlaces,
  emptyStructure,
  firstConformationFlag,
  hydrogenFlag,
  modelOf,
  polymerFlag,
  residueKey,
  residueNameOf,
  sameChoice,
  selectAtoms,
  shownBy,
  StructureBuilder,
  tensorOf,
  waterFlag,
  type AtomRecord,
  type Structure,
} from '../src/pdb/structure.ts'

// The structure's tables as the builder writes them: its columns growing and trimmed, the residues, runs and chains it
// opens as the keys change, the residue names of other chemical forms, the sparse tensors, and its tallies

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

// A structure of the atoms given, each the base atom with its changes, in order
function structureOf(atoms: Partial<AtomRecord>[], builder = new StructureBuilder()): Structure {
  for (const changes of atoms) builder.add({ ...base, ...changes })
  return builder.finish()
}

// Each table row's first atom, or first residue, and the count after the last
const starts = (column: Uint32Array) => [...column]

void test('the builder grows its columns as they fill and trims them to their lengths', () => {
  // Room for two atoms, so that the atoms' columns grow several times and the residues' too
  const atoms = Array.from({ length: 20 }, (_, i) => ({ x: i, y: -i, z: i / 4, residueNumber: Math.floor(i / 2) + 1, bFactor: i }))
  const structure = structureOf(atoms, new StructureBuilder(2))
  assert.equal(structure.atoms.count, 20)
  assert.equal(structure.atoms.positions.length, 60)
  for (const column of [structure.atoms.element, structure.atoms.bFactor, structure.atoms.flags, structure.atoms.residue]) {
    assert.equal(column.length, 20)
  }
  assert.deepEqual([...structure.atoms.positions.subarray(57)], [19, -19, 4.75])
  assert.deepEqual([...structure.atoms.bFactor], atoms.map((atom) => atom.bFactor))
  assert.equal(structure.residues.count, 10)
  assert.equal(structure.residues.number.length, 10)
  assert.deepEqual([...structure.residues.number], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(starts(structure.residues.firstAtom), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  assert.deepEqual([...structure.atoms.residue], atoms.map((_, i) => Math.floor(i / 2)))
  // A finished builder takes no more atoms
  const builder = new StructureBuilder()
  builder.add(base)
  builder.finish()
  assert.throws(() => builder.add(base), /already finished/)
})

void test('a chain whose ligand and waters come later in the file keeps them, each a run of its own', () => {
  // Haemoglobin's way: chain A's polymer, then chain B's, then A's heme and waters, then B's water, each written under
  // a label chain of its own
  const structure = structureOf([
    { residueNumber: 1 },
    { residueNumber: 2 },
    { chain: 'B', labelChain: 'B', residueNumber: 1 },
    { labelChain: 'C', residueName: 'HEM', residueNumber: 142, element: 'Fe', atomName: 'FE', polymer: false },
    { labelChain: 'D', residueName: 'HOH', residueNumber: 201, element: 'O', atomName: 'O', water: true, polymer: false },
    { labelChain: 'D', residueName: 'HOH', residueNumber: 202, element: 'O', atomName: 'O', water: true, polymer: false },
    { chain: 'B', labelChain: 'E', residueName: 'HOH', residueNumber: 301, element: 'O', atomName: 'O', water: true, polymer: false },
  ])
  const { residues, runs, chains } = structure
  assert.equal(chains.count, 2)
  assert.deepEqual(chains.name, ['A', 'B'])
  assert.deepEqual([...chains.model], [1, 1])
  assert.equal(runs.count, 5)
  assert.deepEqual(runs.label, ['A', 'B', 'C', 'D', 'E'])
  assert.deepEqual([...runs.chain], [0, 1, 0, 0, 1])
  assert.deepEqual(starts(runs.firstResidue), [0, 2, 3, 4, 6, 7])
  assert.deepEqual(starts(runs.firstAtom), [0, 2, 3, 4, 6, 7])
  // Chain A's runs in the file's order, then chain B's
  assert.deepEqual([...chains.runs], [0, 2, 3, 1, 4])
  assert.deepEqual(starts(chains.firstRun), [0, 3, 5])
  assert.equal(residues.count, 7)
  assert.deepEqual([...residues.run], [0, 0, 1, 2, 3, 3, 4])
  assert.deepEqual(
    Array.from({ length: structure.atoms.count }, (_, atom) => chainOf(structure, atom)),
    [0, 0, 1, 0, 0, 0, 1],
  )
  assert.deepEqual(structure.elements, ['C', 'Fe', 'O'])
  assert.deepEqual(structure.residueNames, ['ALA', 'HEM', 'HOH'])
})

void test('each model has chains of its own, and the models are kept in the order they first appear', () => {
  const structure = structureOf([{ model: 3 }, { model: 3, chain: 'B', labelChain: 'B' }, { model: 1 }, { model: 1, chain: 'B', labelChain: 'B' }])
  assert.deepEqual(structure.models, [3, 1])
  assert.deepEqual(structure.chains.name, ['A', 'B', 'A', 'B'])
  assert.deepEqual([...structure.chains.model], [3, 3, 1, 1])
  assert.deepEqual(
    Array.from({ length: 4 }, (_, atom) => modelOf(structure, atom)),
    [3, 3, 1, 1],
  )
  // The same residue in another model is a residue of its own with the same key
  assert.equal(structure.residues.count, 4)
  assert.equal(residueKey(structure, 0), residueKey(structure, 2))
})

void test("a residue's alternates are one residue, and an insertion code opens another", () => {
  const structure = structureOf([
    { residueName: 'SER', residueNumber: 10, atomName: 'CA' },
    { residueName: 'SER', residueNumber: 10, atomName: 'OG', altLoc: 'A', occupancy: 0.5 },
    { residueName: 'SER', residueNumber: 10, atomName: 'OG', altLoc: 'B', occupancy: 0.5, firstConformation: false },
    { residueNumber: 52 },
    { residueNumber: 52, insertion: 'A' },
    { residueNumber: 53 },
  ])
  assert.deepEqual([...structure.atoms.residue], [0, 0, 0, 1, 2, 3])
  assert.deepEqual(structure.altLocs, ['', 'A', 'B'])
  assert.deepEqual([...structure.atoms.altLoc], [0, 1, 2, 0, 0, 0])
  assert.deepEqual(structure.insertions, ['', 'A'])
  assert.deepEqual(
    Array.from({ length: structure.residues.count }, (_, residue) => residueKey(structure, residue)),
    ['A 10 ', 'A 52 ', 'A 52 A', 'A 53 '],
  )
  const flags = [...structure.atoms.flags]
  assert.deepEqual(
    flags.map((flag) => (flag & firstConformationFlag) !== 0),
    [true, true, false, true, true, true],
  )
})

void test('an atom of another chemical form of its residue keeps its own residue name', () => {
  // Crambin's residue 22 is a proline or a serine, written as one residue whose alternates differ in kind
  const forms = structureOf([
    { residueName: 'PRO', residueNumber: 22, atomName: 'N' },
    { residueName: 'PRO', residueNumber: 22, altLoc: 'A' },
    { residueName: 'SER', residueNumber: 22, altLoc: 'B', firstConformation: false },
    { residueName: 'SER', residueNumber: 22, atomName: 'OG', altLoc: 'B', firstConformation: false },
    { residueName: 'CYS', residueNumber: 23 },
  ])
  assert.equal(forms.residues.count, 2)
  assert.deepEqual(
    Array.from({ length: forms.atoms.count }, (_, atom) => residueNameOf(forms, atom)),
    ['PRO', 'PRO', 'SER', 'SER', 'CYS'],
  )
  assert.ok(forms.forms)
  assert.deepEqual([...forms.forms.atoms], [2, 3])
  assert.equal(structureOf([{}, { atomName: 'CB' }]).forms, null)
})

void test('tensors are kept for the atoms that have them alone, and none where the entry records none', () => {
  const builder = new StructureBuilder()
  for (let i = 0; i < 4; i++) builder.add({ ...base, x: i })
  builder.addTensor(1, [0.1, 0.01, 0.02, 0.2, 0.03, 0.3])
  builder.addTensor(3, [0.4, 0, 0, 0.5, 0, 0.6])
  assert.throws(() => builder.addTensor(2, [0, 0, 0, 0, 0, 0]), /order/)
  assert.throws(() => builder.addTensor(4, [0, 0, 0, 0, 0, 0]), /order/)
  const structure = builder.finish()
  assert.ok(structure.tensors)
  assert.deepEqual([...structure.tensors.atoms], [1, 3])
  assert.equal(structure.tensors.values.length, 12)
  assert.deepEqual(
    [0, 1, 2, 3].map((atom) => tensorOf(structure, atom)),
    [-1, 0, -1, 6],
  )
  assert.deepEqual([...structure.tensors.values.subarray(6)], [0.4, 0, 0, 0.5, 0, 0.6].map(Math.fround))
  const none = structureOf([{}, {}])
  assert.equal(none.tensors, null)
  assert.equal(tensorOf(none, 0), -1)
})

void test('the flags, and the tallies of the entry and of the atoms shown at the defaults', () => {
  const structure = structureOf([
    {},
    { element: 'H', atomName: 'HA', hydrogen: true },
    { atomName: 'CB', altLoc: 'A' },
    { atomName: 'CB', altLoc: 'B', firstConformation: false },
    { residueNumber: 142, residueName: 'HEM', element: 'Fe', atomName: 'FE', polymer: false },
    { residueNumber: 201, residueName: 'HOH', element: 'O', atomName: 'O', water: true, polymer: false },
    { model: 2 },
    { model: 2, residueNumber: 201, residueName: 'HOH', element: 'O', atomName: 'O', water: true, polymer: false },
  ])
  const { flags } = structure.atoms
  assert.equal(flags[0], firstConformationFlag | polymerFlag)
  assert.equal(flags[1], hydrogenFlag | firstConformationFlag | polymerFlag)
  assert.equal(flags[3], polymerFlag)
  assert.equal(flags[4], firstConformationFlag)
  assert.equal(flags[5], waterFlag | firstConformationFlag)
  assert.deepEqual(structure.tallies, {
    alternates: 2,
    waters: 2,
    hydrogens: 1,
    ligands: 1,
    later: 1,
    defaults: { atoms: 5, waters: 1, hydrogens: 1, alternates: 1 },
  })
  assert.deepEqual(emptyStructure.tallies.defaults, { atoms: 0, waters: 0, hydrogens: 0, alternates: 0 })
  assert.equal(emptyStructure.atoms.count, 0)
  assert.equal(emptyStructure.residues.firstAtom.length, 1)
})

void test('a selection marks and lists the atoms its test keeps, in order', () => {
  const structure = structureOf([{}, { model: 2 }, {}, { model: 2 }, {}])
  const second = selectAtoms(structure, (atom) => modelOf(structure, atom) === 2)
  assert.deepEqual([...second.rows], [1, 3])
  assert.deepEqual([...second.mask], [0, 1, 0, 1, 0])
  assert.equal(second.count, 2)
  const none = selectAtoms(structure, () => false)
  assert.equal(none.count, 0)
  assert.equal(none.rows.length, 0)
})

void test('more distinct elements than a byte holds is an error', () => {
  const builder = new StructureBuilder()
  for (let i = 0; i < 256; i++) builder.add({ ...base, element: `E${i}` })
  assert.throws(() => builder.add({ ...base, element: 'E256' }), /more than 256 distinct elements/)
})

void test('a builder told its size as it reads grows once to it, and says what it holds so far', () => {
  const builder = new StructureBuilder(2)
  builder.add(base)
  builder.add({ ...base, chain: 'B', labelChain: 'B' })
  assert.equal(builder.atomCount, 2)
  assert.equal(builder.residueCount, 2)
  assert.equal(builder.chainRow, 1)
  builder.reserve(1000)
  for (let i = 0; i < 998; i++) builder.add({ ...base, residueNumber: i + 2, x: i })
  const structure = builder.finish()
  assert.equal(structure.atoms.count, 1000)
  assert.equal(structure.atoms.positions[999 * 3], 997)
  // Finished, it takes no more room, so its structure's columns stay as they are
  builder.reserve(5000)
  assert.equal(structure.atoms.positions.length, 3000)
  assert.equal(new StructureBuilder().chainRow, -1)
})

void test('the columns that place the atoms are copied apart from the structure, which can then be handed on', () => {
  const structure = structureOf([{}, { model: 2, x: 3 }, { element: 'N', residueNumber: 2 }])
  const places = copyPlaces(structure)
  assert.deepEqual(places.atoms.positions, structure.atoms.positions)
  assert.notEqual(places.atoms.positions.buffer, structure.atoms.positions.buffer)
  assert.deepEqual(places.models, [1, 2])
  assert.deepEqual(places.elements, structure.elements)
  for (let atom = 0; atom < 3; atom++) {
    assert.equal(chainOf(places, atom), chainOf(structure, atom))
    assert.equal(modelOf(places, atom), modelOf(structure, atom))
  }
})

void test('a choice shows atoms by their flags and model, and two choices are the same where all four agree', () => {
  const choice = { hydrogens: false, waters: false, conformations: 'first', model: 1 } as const
  assert.equal(shownBy(firstConformationFlag, 1, choice), true)
  assert.equal(shownBy(firstConformationFlag, 2, choice), false)
  assert.equal(shownBy(firstConformationFlag, 2, { ...choice, model: null }), true)
  assert.equal(shownBy(firstConformationFlag | hydrogenFlag, 1, choice), false)
  assert.equal(shownBy(firstConformationFlag | waterFlag, 1, { ...choice, waters: true }), true)
  assert.equal(shownBy(0, 1, choice), false)
  assert.equal(shownBy(0, 1, { ...choice, conformations: 'all' }), true)
  assert.equal(sameChoice(choice, { ...choice }), true)
  assert.equal(sameChoice(choice, { ...choice, model: null }), false)
})

// The structure's tables but for its arrival, which a structure appended from batches has and one built whole hasn't
const tableKeys = [
  'title',
  'models',
  'atoms',
  'residues',
  'runs',
  'chains',
  'tensors',
  'forms',
  'elements',
  'atomNames',
  'residueNames',
  'insertions',
  'altLocs',
  'tallies',
] as const

// About 2,500 atoms: three chains of residues of eight atoms, one with an insertion code and one in two chemical forms,
// a ligand and waters that come after every chain's polymer, alternates, hydrogens, and a second model
function arrivingAtoms(): Partial<AtomRecord>[] {
  const atoms: Partial<AtomRecord>[] = []
  for (const chain of ['A', 'B', 'C']) {
    for (let residue = 1; residue <= 100; residue++) {
      for (let k = 0; k < 8; k++) {
        atoms.push({
          chain,
          labelChain: chain,
          residueNumber: residue,
          insertion: residue === 52 && chain === 'B' ? 'A' : '',
          atomName: `X${k}`,
          element: k === 7 ? 'H' : k === 6 ? 'O' : 'C',
          hydrogen: k === 7,
          residueName: residue === 22 && k > 3 ? 'SER' : 'PRO',
          x: residue + k / 10,
          y: chain.charCodeAt(0),
          z: -k,
          bFactor: residue % 30,
        })
      }
      if (residue % 25 === 0) atoms.push({ chain, labelChain: chain, residueNumber: residue, altLoc: 'B', firstConformation: false, x: 99 })
    }
  }
  atoms.push({ chain: 'A', labelChain: 'D', residueNumber: 401, residueName: 'HEM', element: 'Fe', polymer: false })
  for (let water = 0; water < 40; water++) {
    atoms.push({ chain: water % 2 ? 'A' : 'B', labelChain: 'E', residueNumber: 500 + water, residueName: 'HOH', element: 'O', water: true, polymer: false })
  }
  for (let residue = 1; residue <= 20; residue++) atoms.push({ model: 2, residueNumber: residue, x: residue })
  return atoms
}

void test('a structure appended from batches is the one built whole, at batches of a residue, a thousand atoms and the whole', () => {
  const atoms = arrivingAtoms()
  const whole = structureOf(atoms, new StructureBuilder())
  for (const size of [1, 1000, Infinity]) {
    const source = new StructureBuilder(2)
    const target = new StructureBuilder(2)
    // Each snapshot as it was given, and for one in fifty and the first, a copy of its tables made then
    const given: { snapshot: Structure; copy: string | null }[] = []
    const copyOf = (snapshot: Structure) => JSON.stringify([snapshot.atoms, snapshot.residues, snapshot.runs, snapshot.chains].map((table) => Object.values(table).map((column) => (typeof column === 'number' ? column : [...column]))))
    const append = (last: boolean) => {
      target.append(source.takeBatch('An arriving entry', last), atoms.length)
      const snapshot = target.snapshot()
      given.push({ snapshot, copy: given.length % 50 === 0 ? copyOf(snapshot) : null })
    }
    let since = 0
    for (const changes of atoms) {
      if (since >= size) {
        source.callAtNextResidue(() => {
          append(false)
          since = 0
        })
      }
      source.add({ ...base, ...changes })
      since++
    }
    append(true)
    const last = target.snapshot()
    for (const key of tableKeys) {
      if (key === 'title') continue
      assert.deepEqual(last[key], whole[key], `${size}: ${key}`)
    }
    assert.equal(last.title, 'An arriving entry')
    assert.equal(last.whole, true)
    assert.ok(last.arrival !== null)
    // Every snapshot but the last is partial, each a snapshot of the same arrival, and each stays as it was given
    assert.ok(given.length >= (size === 1 ? whole.residues.count : size === 1000 ? 3 : 1), `${size}: ${given.length} batches`)
    given.forEach(({ snapshot, copy }, i) => {
      assert.equal(snapshot.whole, i === given.length - 1)
      assert.equal(snapshot.arrival, last.arrival)
      if (copy !== null) assert.equal(copyOf(snapshot), copy, `${size}: snapshot ${i}`)
      // Each batch began at a residue's start, so every residue a snapshot holds has all its atoms
      const { residues, atoms: held } = snapshot
      assert.equal(residues.firstAtom[residues.count], held.count)
      if (held.count < whole.atoms.count) assert.notEqual(whole.atoms.residue[held.count], whole.atoms.residue[held.count - 1])
    })
  }
})

void test("the last batch carries the tensors, and the secondary structure where the file's end changed an earlier batch's", () => {
  const source = new StructureBuilder()
  const target = new StructureBuilder()
  source.add(base)
  source.add({ ...base, residueNumber: 2, x: 4 })
  source.setSecondaryStructure(0, 'strand')
  source.callAtNextResidue(() => target.append(source.takeBatch('')))
  source.add({ ...base, residueNumber: 3, x: 8 })
  // The file's end gives residue 1, already handed on, a helix, and residue 3 a turn, and an atom its tensor
  source.setSecondaryStructure(1, 'helix')
  source.setSecondaryStructure(2, 'turn')
  source.addTensor(2, [1, 0, 0, 2, 0, 3])
  const last = source.takeBatch('', true)
  assert.ok(last.end?.structure)
  assert.deepEqual([...last.end.structure], [2, 1, 3])
  target.append(last)
  const structure = target.snapshot()
  assert.deepEqual([...structure.residues.structure], [2, 1, 3])
  assert.deepEqual([...(structure.tensors?.atoms ?? [])], [2])
  assert.equal(structure.whole, true)
  // Without a change to a residue handed on, the last batch's residues carry their own
  const plain = new StructureBuilder()
  plain.add(base)
  plain.setSecondaryStructure(0, 'helix')
  assert.equal(plain.takeBatch('', true).end?.structure, null)
  // Nothing appends to a whole structure
  assert.throws(() => target.append(plain.takeBatch('')), /already whole/)
})
