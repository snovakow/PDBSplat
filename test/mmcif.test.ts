import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultAtoms, parseMmcif, residueKey, type Atom } from '../src/pdb/mmcif.ts'

// The parser, on mmCIF text written here

// The atom table's columns, in the order most entries write them
const columns = [
  'group_PDB',
  'id',
  'type_symbol',
  'label_atom_id',
  'label_alt_id',
  'label_comp_id',
  'label_asym_id',
  'label_seq_id',
  'pdbx_PDB_ins_code',
  'Cartn_x',
  'Cartn_y',
  'Cartn_z',
  'occupancy',
  'B_iso_or_equiv',
  'auth_seq_id',
  'auth_asym_id',
  'pdbx_PDB_model_num',
] as const

type Column = (typeof columns)[number]
type Row = Partial<Record<Column, string>>

// A row's values in the table's order, over a carbon alpha of alanine 1 in chain A
function atomRow(row: Row, order: readonly Column[] = columns) {
  const values: Record<Column, string> = {
    group_PDB: 'ATOM',
    id: '1',
    type_symbol: 'C',
    label_atom_id: 'CA',
    label_alt_id: '.',
    label_comp_id: 'ALA',
    label_asym_id: 'A',
    label_seq_id: '1',
    pdbx_PDB_ins_code: '?',
    Cartn_x: '0',
    Cartn_y: '0',
    Cartn_z: '0',
    occupancy: '1.00',
    B_iso_or_equiv: '20.0',
    auth_seq_id: row.label_seq_id ?? '1',
    auth_asym_id: 'A',
    pdbx_PDB_model_num: '1',
    ...row,
  }
  return order.map((column) => values[column]).join(' ')
}

function loop(category: string, names: readonly string[], rows: string[]) {
  return `loop_\n${names.map((name) => `${category}.${name}`).join('\n')}\n${rows.join('\n')}\n`
}

function atomTable(rows: Row[], order: readonly Column[] = columns) {
  return loop('_atom_site', order, rows.map((row, i) => atomRow({ id: String(i + 1), ...row }, order)))
}

// Six values in three's covariance order from a tensor's U11, U22, U33, U12, U13 and U23
function covariance(u11: number, u22: number, u33: number, u12: number, u13: number, u23: number) {
  return [u11, u12, u13, u22, u23, u33]
}

function assertTensor(u: Float32Array | null, expected: number[], tolerance: number) {
  assert.ok(u)
  assert.equal(u.length, 6)
  for (let k = 0; k < 6; k++) assert.ok(Math.abs(u[k] - expected[k]) <= tolerance, `value ${k}: ${u[k]} for ${expected[k]}`)
}

void test('reads quoted and text-field tokens, skips comments, and reads unquoted ? and . as empty', () => {
  const text = `data_test
# A comment before the title
_struct.title
;  A title
  over two lines
;
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.auth_seq_id
_atom_site.auth_asym_id
# A comment among the rows
ATOM 1 O "O5'" . 'DA' A 1 ? 1.5 -2.25 3 1 A
ATOM 2 C CA .
;ALA
;
A 2 ? 0 0 0 2 A
ATOM 3 C CA A ALA A 3 '?' 0 0 0 3 A # a comment ending a row
`
  const { title, atoms } = parseMmcif(text)
  assert.equal(title, 'A title over two lines')
  assert.equal(atoms.length, 3)
  assert.equal(atoms[0].atomName, "O5'")
  assert.equal(atoms[0].residueName, 'DA')
  assert.equal(atoms[0].altLoc, '')
  assert.equal(atoms[0].insertion, '')
  assert.deepEqual([atoms[0].x, atoms[0].y, atoms[0].z], [1.5, -2.25, 3])
  assert.equal(atoms[1].residueName, 'ALA')
  assert.equal(atoms[1].residueNumber, 2)
  // A quoted ? is a value
  assert.equal(atoms[2].altLoc, 'A')
  assert.equal(atoms[2].insertion, '?')
})

void test('finds columns by name whatever their order', () => {
  const shuffled: Column[] = [
    'Cartn_z',
    'auth_asym_id',
    'B_iso_or_equiv',
    'Cartn_x',
    'label_atom_id',
    'pdbx_PDB_model_num',
    'type_symbol',
    'auth_seq_id',
    'label_comp_id',
    'id',
    'Cartn_y',
    'occupancy',
    'group_PDB',
    'label_asym_id',
    'label_seq_id',
    'label_alt_id',
    'pdbx_PDB_ins_code',
  ]
  const { atoms } = parseMmcif(
    atomTable(
      [{ Cartn_x: '1', Cartn_y: '2', Cartn_z: '3', type_symbol: 'N', label_atom_id: 'N', B_iso_or_equiv: '12.5', occupancy: '0.5' }],
      shuffled,
    ),
  )
  assert.equal(atoms.length, 1)
  const [atom] = atoms
  assert.deepEqual([atom.x, atom.y, atom.z], [1, 2, 3])
  assert.equal(atom.element, 'N')
  assert.equal(atom.atomName, 'N')
  assert.equal(atom.bFactor, 12.5)
  assert.equal(atom.occupancy, 0.5)
})

void test("reads each atom's fields, with their defaults", () => {
  const { atoms, models } = parseMmcif(
    atomTable([
      { type_symbol: 'FE', label_atom_id: 'FE', label_comp_id: 'HEM', label_seq_id: '.', auth_seq_id: '142', group_PDB: 'HETATM' },
      { type_symbol: 'D', label_atom_id: 'D', label_comp_id: 'DOD', label_seq_id: '.', auth_seq_id: '201', group_PDB: 'HETATM' },
      { type_symbol: 'H', label_atom_id: 'HA', label_seq_id: '3', pdbx_PDB_ins_code: 'B' },
      { type_symbol: 'O', label_atom_id: 'O', label_comp_id: 'HOH', label_seq_id: '.', auth_seq_id: '301', group_PDB: 'HETATM' },
    ]),
  )
  assert.deepEqual(models, [1])
  const [iron, deuterium, hydrogen, water] = atoms
  assert.equal(iron.element, 'Fe')
  assert.equal(iron.residueNumber, 142)
  assert.equal(iron.polymer, false)
  assert.equal(iron.water, false)
  assert.equal(iron.hydrogen, false)
  assert.equal(iron.u, null)
  assert.equal(iron.structure, 'none')
  assert.equal(deuterium.hydrogen, true)
  assert.equal(deuterium.water, true)
  assert.equal(hydrogen.hydrogen, true)
  assert.equal(hydrogen.insertion, 'B')
  assert.equal(hydrogen.residueNumber, 3)
  assert.equal(water.water, true)
  assert.equal(water.polymer, false)
  for (const atom of atoms) {
    assert.equal(atom.model, 1)
    assert.equal(atom.firstConformation, true)
    assert.equal(atom.chain, 'A')
  }
})

void test('falls back between the label and author columns, and to defaults without either', () => {
  const text = loop(
    '_atom_site',
    ['group_PDB', 'type_symbol', 'auth_atom_id', 'auth_comp_id', 'label_asym_id', 'label_seq_id', 'Cartn_x', 'Cartn_y', 'Cartn_z'],
    ['ATOM N N GLY B 7 1 2 3', 'ATOM O O HOH C . 4 5 6'],
  )
  const { atoms, models } = parseMmcif(text)
  assert.equal(atoms[0].atomName, 'N')
  assert.equal(atoms[0].residueName, 'GLY')
  assert.equal(atoms[0].chain, 'B')
  // The author's number falls back to the place in the sequence, and a water without either gets 0
  assert.equal(atoms[0].residueNumber, 7)
  assert.equal(atoms[1].residueNumber, 0)
  assert.equal(atoms[0].altLoc, '')
  assert.equal(atoms[0].insertion, '')
  assert.equal(atoms[0].occupancy, 1)
  assert.equal(atoms[0].bFactor, 0)
  assert.equal(atoms[0].model, 1)
  assert.deepEqual(models, [1])
})

void test("marks each residue's first conformation per model", () => {
  const residue = { label_comp_id: 'SER', label_seq_id: '10' }
  const { atoms } = parseMmcif(
    atomTable([
      { ...residue, label_atom_id: 'CA' },
      { ...residue, label_atom_id: 'OG', label_alt_id: 'A', occupancy: '0.6' },
      { ...residue, label_atom_id: 'OG', label_alt_id: 'B', occupancy: '0.4' },
      // Another residue with the same number in another chain lists B first
      { ...residue, label_atom_id: 'OG', label_alt_id: 'B', label_asym_id: 'B', auth_asym_id: 'B' },
      { ...residue, label_atom_id: 'OG', label_alt_id: 'A', label_asym_id: 'B', auth_asym_id: 'B' },
      // The second model lists B first
      { ...residue, label_atom_id: 'OG', label_alt_id: 'B', pdbx_PDB_model_num: '2' },
      { ...residue, label_atom_id: 'OG', label_alt_id: 'A', pdbx_PDB_model_num: '2' },
    ]),
  )
  assert.deepEqual(
    atoms.map((atom) => atom.firstConformation),
    [true, true, false, true, false, true, false],
  )
  assert.deepEqual(
    atoms.map((atom) => atom.altLoc),
    ['', 'A', 'B', 'B', 'A', 'B', 'A'],
  )
  assert.equal(atoms[1].occupancy, 0.6)
})

void test('keeps every model in file order, and defaultAtoms gives the first model in its first conformations once', () => {
  const { atoms, models } = parseMmcif(
    atomTable([
      { label_atom_id: 'CA', pdbx_PDB_model_num: '3', Cartn_x: '1' },
      { label_atom_id: 'CB', pdbx_PDB_model_num: '3', label_alt_id: 'A' },
      { label_atom_id: 'CB', pdbx_PDB_model_num: '3', label_alt_id: 'B' },
      { label_atom_id: 'CA', pdbx_PDB_model_num: '1', Cartn_x: '2' },
      { label_atom_id: 'CB', pdbx_PDB_model_num: '1', label_alt_id: 'A' },
      { label_atom_id: 'CB', pdbx_PDB_model_num: '1', label_alt_id: 'B' },
    ]),
  )
  assert.deepEqual(models, [3, 1])
  assert.deepEqual(
    atoms.map((atom) => atom.model),
    [3, 3, 3, 1, 1, 1],
  )
  const defaults = defaultAtoms(atoms)
  assert.deepEqual(defaults, [atoms[0], atoms[1]])
  assert.equal(defaultAtoms(atoms), defaults)
  assert.deepEqual(defaultAtoms([]), [])
})

void test('reads polymer from the place in the sequence, or from the record type without that column', () => {
  const sequenced = parseMmcif(
    atomTable([
      { group_PDB: 'ATOM', label_comp_id: 'ALA', label_seq_id: '4' },
      { group_PDB: 'HETATM', label_comp_id: 'MSE', label_seq_id: '5', type_symbol: 'SE', label_atom_id: 'SE' },
      { group_PDB: 'HETATM', label_comp_id: 'HEM', label_seq_id: '.', auth_seq_id: '142' },
      { group_PDB: 'HETATM', label_comp_id: 'HOH', label_seq_id: '.', auth_seq_id: '201', type_symbol: 'O' },
    ]),
  )
  assert.deepEqual(
    sequenced.atoms.map((atom) => atom.polymer),
    [true, true, false, false],
  )
  const unsequenced = parseMmcif(
    atomTable(
      [
        { group_PDB: 'ATOM', label_comp_id: 'ALA', auth_seq_id: '4' },
        { group_PDB: 'HETATM', label_comp_id: 'MSE', auth_seq_id: '5' },
        { group_PDB: 'HETATM', label_comp_id: 'HEM', auth_seq_id: '142' },
      ],
      columns.filter((column) => column !== 'label_seq_id'),
    ),
  )
  assert.deepEqual(
    unsequenced.atoms.map((atom) => atom.polymer),
    [true, false, false],
  )
})

void test('gives each residue its secondary structure by label numbering, a strand over a helix, and either over a turn', () => {
  // The author numbers the residues from 101 with an insertion at 104A, which lies in no range, and calls the chain X;
  // the ranges name the chain's label, A, and the residues' places in its sequence
  const authNumbers = ['101', '102', '103', '104', '104', '105', '106', '107', '108']
  const rows: Row[] = authNumbers.map((auth, i) => ({
    label_seq_id: String(i + 1),
    auth_seq_id: auth,
    auth_asym_id: 'X',
    pdbx_PDB_ins_code: i === 4 ? 'A' : '?',
  }))
  rows.push({ label_comp_id: 'HOH', label_seq_id: '.', auth_seq_id: '201', auth_asym_id: 'X', group_PDB: 'HETATM', type_symbol: 'O' })
  const text =
    atomTable(rows) +
    loop(
      '_struct_conf',
      ['conf_type_id', 'id', 'beg_label_asym_id', 'beg_label_seq_id', 'end_label_asym_id', 'end_label_seq_id'],
      [
        'HELX_P HELX_P1 A 2 A 4',
        'STRN STRN1 A 3 A 3',
        'TURN_P TURN_P1 A 4 A 4',
        'TURN_P TURN_P2 A 9 A 9',
        // A range across chains, and one in a chain the atoms don't have, are left out
        'HELX_P HELX_P2 A 1 B 9',
        'HELX_P HELX_P3 B 1 B 9',
      ],
    ) +
    // A one-row table written as a tag and value per column
    `_struct_sheet_range.sheet_id A
_struct_sheet_range.id 1
_struct_sheet_range.beg_label_asym_id A
_struct_sheet_range.beg_label_seq_id 6
_struct_sheet_range.end_label_asym_id A
_struct_sheet_range.end_label_seq_id 7
`
  const { atoms } = parseMmcif(text)
  assert.deepEqual(
    atoms.map((atom) => atom.structure),
    ['none', 'helix', 'strand', 'helix', 'none', 'strand', 'strand', 'none', 'turn', 'none'],
  )
  assert.equal(atoms[4].insertion, 'A')
  assert.equal(atoms[4].residueNumber, 104)
  assert.equal(atoms[4].chain, 'X')
})

void test('a range reaches an inserted residue by its place in the sequence', () => {
  const { atoms } = parseMmcif(
    atomTable([
      { label_seq_id: '1', auth_seq_id: '52' },
      { label_seq_id: '2', auth_seq_id: '52', pdbx_PDB_ins_code: 'A' },
      { label_seq_id: '3', auth_seq_id: '53' },
    ]) +
      `_struct_conf.conf_type_id HELX_P
_struct_conf.beg_label_asym_id A
_struct_conf.beg_label_seq_id 2
_struct_conf.end_label_asym_id A
_struct_conf.end_label_seq_id 2
`,
  )
  assert.deepEqual(
    atoms.map((atom) => atom.structure),
    ['none', 'helix', 'none'],
  )
  assert.deepEqual(atoms.map(residueKey), ['A 52 ', 'A 52 A', 'A 53 '])
})

void test('reads anisotropic tensors as U or B, in a loop or a one-row table, skipping a row missing a value', () => {
  const atoms = atomTable([{ id: '1' }, { id: '2' }, { id: '3' }])
  const names = ['id', 'U[1][1]', 'U[2][2]', 'U[3][3]', 'U[1][2]', 'U[1][3]', 'U[2][3]']
  const tolerance = 1e-7
  const uLoop = parseMmcif(
    atoms +
      loop('_atom_site_anisotrop', names, ['1 0.11 0.22 0.33 0.12 0.13 0.23', '2 0.1 0.2 0.3 ? 0.1 0.1', '3 0.4 0.5 0.6 -0.01 -0.02 -0.03']),
  )
  assertTensor(uLoop.atoms[0].u, covariance(0.11, 0.22, 0.33, 0.12, 0.13, 0.23), tolerance)
  assert.equal(uLoop.atoms[1].u, null)
  assertTensor(uLoop.atoms[2].u, covariance(0.4, 0.5, 0.6, -0.01, -0.02, -0.03), tolerance)

  // The tensors may come before the atoms, as B, which is 8π² times U
  const bPerU = 8 * Math.PI * Math.PI
  const bLoop = parseMmcif(
    loop('_atom_site_anisotrop', names.map((name) => name.replace('U', 'B')), ['2 7.9 15.8 23.7 0.79 -1.58 2.37']) + atoms,
  )
  assert.equal(bLoop.atoms[0].u, null)
  assertTensor(bLoop.atoms[1].u, covariance(7.9, 15.8, 23.7, 0.79, -1.58, 2.37).map((b) => b / bPerU), tolerance)
  assert.equal(bLoop.atoms[2].u, null)

  const single = parseMmcif(
    atoms +
      `_atom_site_anisotrop.id 3
_atom_site_anisotrop.U[1][1] 0.01
_atom_site_anisotrop.U[2][2] 0.02
_atom_site_anisotrop.U[3][3] 0.03
_atom_site_anisotrop.U[1][2] 0.001
_atom_site_anisotrop.U[1][3] 0.002
_atom_site_anisotrop.U[2][3] 0.003
`,
  )
  assert.equal(single.atoms[0].u, null)
  assertTensor(single.atoms[2].u, covariance(0.01, 0.02, 0.03, 0.001, 0.002, 0.003), tolerance)

  const incomplete = parseMmcif(
    atoms +
      `_atom_site_anisotrop.id 1
_atom_site_anisotrop.U[1][1] 0.01
_atom_site_anisotrop.U[2][2] 0.02
_atom_site_anisotrop.U[3][3] 0.03
_atom_site_anisotrop.U[1][2] ?
_atom_site_anisotrop.U[1][3] 0.002
_atom_site_anisotrop.U[2][3] 0.003
`,
  )
  assert.equal(incomplete.atoms[0].u, null)
})

void test("collapses the title's whitespace", () => {
  const { title } = parseMmcif(`_struct.title '  CRAMBIN   AT\t0.54 A  '\n${atomTable([{}])}`)
  assert.equal(title, 'CRAMBIN AT 0.54 A')
  assert.equal(parseMmcif(atomTable([{}])).title, '')
})

void test('throws without an atom table, and without a coordinate column', () => {
  assert.throws(() => parseMmcif('data_empty\n_struct.title Nothing\n'), /no atom table/)
  assert.throws(
    () => parseMmcif(atomTable([{}], columns.filter((column) => column !== 'Cartn_y'))),
    /Cartn_y/,
  )
})

void test('residueKey names the chain, the number and the insertion code', () => {
  const { atoms } = parseMmcif(atomTable([{ auth_asym_id: 'B', auth_seq_id: '52', pdbx_PDB_ins_code: 'A' }, { auth_seq_id: '7' }]))
  assert.equal(residueKey(atoms[0]), 'B 52 A')
  assert.equal(residueKey(atoms[1]), 'A 7 ')
  const [first]: Atom[] = atoms
  assert.notEqual(residueKey({ ...first, insertion: '' }), residueKey(first))
})
