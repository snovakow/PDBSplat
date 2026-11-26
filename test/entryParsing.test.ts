import assert from 'node:assert/strict'
import { test } from 'node:test'
import { burial, burialSteps } from '../src/pdb/burial.ts'
import { CifTokenizer, readNumber } from '../src/pdb/cifBytes.ts'
import { mergeLevels, StreamMerge, type LoadChoice, type MergedLevel } from '../src/pdb/merge.ts'
import { MmcifReader, parseMmcif } from '../src/pdb/mmcif.ts'
import { vdwRadii } from '../src/pdb/elements.ts'
import {
  atomNameOf,
  modelOf,
  selectAtoms,
  shownBy,
  StructureBuilder,
  tensorOf,
  type AtomRecord,
  type Structure,
} from '../src/pdb/structure.ts'
import { writeAtomShape } from '../src/viewer/ellipsoids.ts'
import { blobCovariances, levelGroups, mergeGaussians } from '../src/viewer/levels.ts'

// The byte path an entry is read by as it downloads: the tokens and tables read from chunks of any size, the numbers
// read from bytes, the levels merged as residues and chains close, and the burial worked out a stretch at a time

const atomColumns = [
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
]
const tensorColumns = ['id', 'U[1][1]', 'U[2][2]', 'U[3][3]', 'U[1][2]', 'U[1][3]', 'U[2][3]']

// Rows of filler atoms, enough to take the file past several chunks of 7919 bytes: residues of three atoms in chain
// C, then in chain D, in two models. They lie within about 15 Å of one another, so that a chain's covariance is a few
// tens of square ångströms, which single precision holds to a few millionths
const filler = Array.from({ length: 480 }, (_, i) => {
  const model = i < 240 ? 1 : 2
  const residue = Math.floor((i % 240) / 3) + 1
  const chain = i % 240 < 120 ? 'C' : 'D'
  const name = ['N', 'CA', 'C'][i % 3]
  const x = ((i % 12) * 1.37).toFixed(3)
  const y = (Math.sin(i) * 9).toFixed(3)
  const z = (Math.cos(i) * 7).toFixed(3)
  return `ATOM ${i + 20} ${name[0]} ${name} . GLY ${chain} ${residue} ? ${x} ${y} ${z} 1.00 15.00 ${residue} ${chain} ${model}`
})

// A file that holds every kind of token and table the reader meets: a comment, a text field, a quoted name with an
// apostrophe in it, a category written as tags and values, a loop's row wrapped across lines, and anisotropic rows
// both before and after the atom table, so that each joins its atom whichever comes first
const textField = ';A title written\nacross two lines\n;'
const apostrophe = `'O5'' `
const wrapped = 'ATOM 4 N N . GLY A 2 ? 4.5\n   6.0 7.0 1.00 10.0 2 A 1'
const comment = '# A comment between the rows, with a quote \' and a ; in it'
const pairs = [
  '_struct_conf.conf_type_id HELX_P',
  '_struct_conf.beg_label_asym_id A',
  '_struct_conf.beg_label_seq_id 1',
  '_struct_conf.end_label_asym_id A',
  '_struct_conf.end_label_seq_id 2',
].join('\n')
const text = [
  'data_TEST',
  '# A comment before anything',
  '_struct.title',
  textField,
  'loop_',
  ...tensorColumns.map((name) => `_atom_site_anisotrop.${name}`),
  '1 0.11 0.22 0.33 0.01 0.02 0.03',
  'loop_',
  ...atomColumns.map((name) => `_atom_site.${name}`),
  'ATOM 1 C CA . ALA A 1 ? +1.5 1.5e1 12.3456789012 ? . 1 A 1',
  'ATOM 2 C CB A ALA A 1 ? -2.25 0.000 3. 0.60 21.5 1 A 1',
  `ATOM 3 O ${apostrophe}B ALA A 1 ? -2.0 0.5 3.5 0.40 22.0 1 A 1`,
  wrapped,
  comment,
  'ATOM 5 H H . GLY A 2 ? 4.0 6.5 7.5 1.00 12.0 2 A 1',
  'HETATM 6 FE FE . HEM B . ? 10.0 10.0 10.0 1.00 30.0 101 A 1',
  'HETATM 7 O O . HOH C . ? 12.0 1.0 2.0 1.00 40.0 201 A 1',
  ...filler,
  '#',
  pairs,
  'loop_',
  ...tensorColumns.map((name) => `_atom_site_anisotrop.${name}`),
  '5 0.04 0.05 0.06 0.001 0.002 0.003',
  '#',
  '',
].join('\n')

const bytes = new TextEncoder().encode(text)

// The structure the reader gives for the file fed in chunks
function inChunks(chunks: Uint8Array[], choice?: LoadChoice) {
  const merge = choice ? new StreamMerge(choice) : undefined
  const reader = new MmcifReader({ onAtom: merge })
  for (const chunk of chunks) reader.feed(chunk)
  return { structure: reader.finish(), merged: merge?.finish() }
}

// The file cut into chunks of a size, each a copy of its bytes, so that nothing is read past a chunk's end
function chunksOf(size: number) {
  const chunks: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size))
  return chunks
}

void test('the byte path gives the structure the whole text gives, in chunks of 1 byte, of 7919 bytes and whole', () => {
  assert.ok(bytes.length > 3 * 7919)
  const whole = parseMmcif(text)
  for (const size of [1, 7919, bytes.length]) assert.deepEqual(inChunks(chunksOf(size)).structure, whole, `chunks of ${size}`)
})

void test('a chunk boundary anywhere inside a comment, a text field, a quoted name, a tag and value or a wrapped row changes nothing', () => {
  const whole = parseMmcif(text)
  for (const feature of [textField, apostrophe, wrapped, comment, pairs]) {
    const start = text.indexOf(feature)
    assert.ok(start >= 0)
    for (let cut = start; cut <= start + feature.length; cut++) {
      const { structure } = inChunks([bytes.slice(0, cut), bytes.slice(cut)])
      assert.deepEqual(structure, whole, `cut at ${cut}, in ${JSON.stringify(feature.slice(0, 12))}`)
    }
  }
})

void test('the file reads as it should: the text field, the quoted name, the wrapped row, the tags and values and both tensor tables', () => {
  const structure = parseMmcif(text)
  assert.equal(structure.title, 'A title written across two lines')
  assert.equal(atomNameOf(structure, 2), "O5'")
  // The wrapped row is one atom, at its place
  assert.deepEqual([...structure.atoms.positions.subarray(9, 12)], [4.5, 6, 7])
  // The helix written as tags and values covers residues 1 and 2 of label chain A
  assert.deepEqual([...structure.residues.structure.subarray(0, 3)], [1, 1, 0])
  // A tensor before the atom table and one after it both join their atoms
  assert.ok(tensorOf(structure, 0) >= 0 && tensorOf(structure, 4) >= 0)
  assert.equal(tensorOf(structure, 1), -1)
  assert.equal(structure.atoms.count, 7 + filler.length)
})

void test('numbers read as Number reads their text: plain decimals, a leading +, an exponent, many decimals, and ? and . as empty', () => {
  const encoder = new TextEncoder()
  for (const written of [
    '12.345',
    '-0.5',
    '7',
    '0.000',
    '-0',
    '3.',
    '.25',
    '+1.5',
    '1e3',
    '-1.5E-2',
    '12.3456789012',
    '0.123456789012345',
    '1234567890123456.5',
    '0x10',
    '-',
    'abc',
  ]) {
    const token = encoder.encode(written)
    assert.ok(Object.is(readNumber(token, 0, token.length), Number(written)), written)
  }
  // In the atom table, ? and . read as empty: a coordinate as 0, an occupancy as 1 and a B-factor as 0
  const structure = parseMmcif(text)
  assert.deepEqual([...structure.atoms.positions.subarray(0, 3)], [1.5, 15, Math.fround(12.3456789012)])
  assert.equal(structure.atoms.occupancy[0], 1)
  assert.equal(structure.atoms.bFactor[0], 0)
})

void test('the tokenizer carries a token across every chunk boundary, and ends one cut off by the end of the file', () => {
  const tokens: string[] = []
  const decoder = new TextDecoder()
  const tokenizer = new CifTokenizer({
    token: (data, start, end, quoted) => tokens.push(`${quoted ? 'q' : 'w'}:${decoder.decode(data.subarray(start, end))}`),
  })
  const sample = new TextEncoder().encode(`a 'b c' "d'e" #x\n;f\r\ng\r\n;h 'i'' j`)
  for (let at = 0; at < sample.length; at++) tokenizer.feed(sample.subarray(at, at + 1))
  tokenizer.end()
  assert.deepEqual(tokens, ['w:a', 'q:b c', "q:d'e", 'q:f\r\ng', 'w:h', "q:i'", 'w:j'])
})

// The merge's inputs as the drawing gives them: each shown atom's centre, its covariance at a shape, and its weight
function atomGaussians(structure: Structure, rows: Uint32Array, shape: { scale: number; thermal: number; ellipsoids: boolean }) {
  const radii = vdwRadii(structure.elements)
  const centers = new Float32Array(rows.length * 3)
  const covariances = new Float32Array(rows.length * 6)
  const weights = new Float32Array(rows.length)
  rows.forEach((atom, i) => {
    for (let k = 0; k < 3; k++) centers[i * 3 + k] = structure.atoms.positions[atom * 3 + k]
    const radius = radii[structure.atoms.element[atom]] * shape.scale
    weights[i] = radius * radius * radius
    writeAtomShape(covariances, i * 6, structure, atom, radii, shape)
  })
  return { centers, covariances, weights }
}

function assertNear(actual: Float32Array, expected: Float32Array, tolerance: number, what: string) {
  assert.equal(actual.length, expected.length, what)
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${what}[${i}]: ${actual[i]} for ${expected[i]}`)
  }
}

void test('the merge as rows close equals mergeGaussians on the same atoms, under each choice of the atoms shown', () => {
  for (const choice of [
    { hydrogens: false, waters: false, conformations: 'first', allModels: false },
    { hydrogens: true, waters: true, conformations: 'all', allModels: true },
    { hydrogens: true, waters: false, conformations: 'first', allModels: false },
  ] satisfies LoadChoice[]) {
    const { structure, merged } = inChunks(chunksOf(7919), choice)
    assert.ok(merged)
    // The model a load asks for as the first is the first atom's
    assert.equal(merged.choice.model, choice.allModels ? null : 1)
    // Merged again from the rows, the blobs are the same to the bit
    assert.deepEqual(mergeLevels(structure, merged.choice), merged)
    const shown = selectAtoms(structure, (atom) => shownBy(structure.atoms.flags[atom], modelOf(structure, atom), merged.choice))
    for (const shape of [
      { scale: 1, thermal: 0, ellipsoids: false },
      { scale: 0.5, thermal: 1, ellipsoids: true },
    ]) {
      const { centers, covariances, weights } = atomGaussians(structure, shown.rows, shape)
      for (const level of ['residues', 'chains'] as const) {
        const grouping = levelGroups(structure, shown, level)
        const expected = mergeGaussians(centers, covariances, weights, grouping)
        const blobs: MergedLevel = merged[level]
        assert.equal(blobs.count, grouping.count, level)
        assertNear(blobs.centers, expected.centers, 2e-5, `${level} centres`)
        assertNear(blobCovariances(blobs.scatters, covariances, weights, grouping), expected.covariances, 2e-5, `${level} covariances`)
      }
    }
  }
})

const lone: AtomRecord = {
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

void test('the burial worked out a stretch at a time gives the values worked out at once, after every sum is known', () => {
  // A slab of carbons 1.5 Å apart, of more atoms than one stretch takes
  const builder = new StructureBuilder()
  for (let i = 0; i < 300; i++) {
    for (let j = 0; j < 120; j++) builder.add({ ...lone, x: i * 1.5, y: j * 1.5, residueNumber: i * 120 + j })
  }
  const structure = builder.finish()
  const steps = burialSteps(structure)
  const done: number[] = []
  let step = steps.next()
  while (!step.done) {
    done.push(step.value)
    step = steps.next()
  }
  assert.ok(done.length > 1)
  assert.equal(done.at(-1), structure.atoms.count)
  assert.deepEqual(done, [...done].sort((a, b) => a - b))
  assert.deepEqual(step.value, burial(structure))
})
