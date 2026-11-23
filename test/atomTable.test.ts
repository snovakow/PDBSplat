import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { Color } from 'three'
import type { Atom } from '../src/pdb/mmcif.ts'
import { atomColors } from '../src/viewer/atomColors.ts'
import {
  createAtomTable,
  isPickable,
  minPickOpacity,
  paintAtoms,
  paintAtomTable,
  paintMerged,
  readAtomIndex,
  tableSize,
  type TablePaint,
} from '../src/viewer/atomTable.ts'

// The atoms' paint: the index bytes the field's table is read by, the table's shape, each painted atom's colour and
// alpha, and the pick's threshold

// The burial reports its timing on the console, which the suite's output does without
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
  polymer: true,
  hydrogen: false,
  water: false,
  structure: 'none',
  u: null,
}
const atom = (changes: Partial<Atom>): Atom => ({ ...base, ...changes })

// A chain of two residues with a ligand beside the second, in two models, where the first residue's CB is in two
// conformations: the alternate A with occupancy 0.6 and the alternate B with 0.4. The ligand is 2.5 Å from the second
// residue and over 5 Å from the first, so the binding site is the ligand and the second residue
function entryOf() {
  const model = (number: number) => [
    atom({ model: number, residueNumber: 1, atomName: 'CA', x: 0 }),
    atom({ model: number, residueNumber: 1, atomName: 'CB', x: 1.5, altLoc: 'A', occupancy: 0.6 }),
    atom({ model: number, residueNumber: 1, atomName: 'CB', x: 1.5, y: 1, altLoc: 'B', occupancy: 0.4, firstConformation: false }),
    atom({ model: number, residueNumber: 2, atomName: 'N', element: 'N', x: 10 }),
    atom({ model: number, residueNumber: 2, atomName: 'CA', x: 11.5 }),
    atom({ model: number, residueNumber: 50, residueName: 'HEM', atomName: 'FE', element: 'Fe', x: 14, polymer: false }),
  ]
  return [...model(1), ...model(2)]
}

const defaults: Omit<TablePaint, 'shown' | 'entry'> = {
  colorBy: 'element',
  burial: 0,
  focus: 'all',
  picked: null,
  fade: 0.15,
  model: 1,
  modelCount: 2,
  conformations: 'first',
  layered: false,
}

// The atoms shown under a paint's model and Alternates, as the store selects them
function shownUnder(entry: readonly Atom[], paint: Omit<TablePaint, 'shown' | 'entry'>) {
  return entry.filter(
    (candidate) =>
      (paint.conformations === 'all' || candidate.firstConformation) &&
      (paint.model === null || candidate.model === paint.model),
  )
}

function painted(entry: readonly Atom[], changes: Partial<TablePaint>) {
  const paint = { ...defaults, ...changes }
  const shown = shownUnder(entry, paint)
  const table = createAtomTable(shown.length)
  paintAtomTable(table, { ...paint, shown, entry })
  return { table, shown, paint }
}

const texel = (bytes: Uint8ClampedArray, i: number) => [...bytes.subarray(i * 4, i * 4 + 4)]
const byte = (value: number) => Math.round(value * 255)

void test('an index is read from three bytes, the red the low, the green the middle and the blue the high', () => {
  const bytes = new Uint8ClampedArray([0, 0, 0, 255, 1, 0, 0, 255, 255, 0, 0, 255, 0, 1, 0, 255, 255, 255, 0, 255])
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => readAtomIndex(bytes, i * 4)),
    [0, 1, 255, 256, 65535],
  )
  assert.equal(readAtomIndex(new Uint8ClampedArray([0, 0, 1, 255]), 0), 65536)
  assert.equal(readAtomIndex(new Uint8ClampedArray([255, 255, 255, 255]), 0), 16777215)
})

void test('the table is as wide as the square root of the count rounded up, and as tall as it then needs', () => {
  assert.deepEqual(tableSize(0), { width: 1, height: 1 })
  assert.deepEqual(tableSize(1), { width: 1, height: 1 })
  assert.deepEqual(tableSize(2), { width: 2, height: 1 })
  assert.deepEqual(tableSize(4), { width: 2, height: 2 })
  assert.deepEqual(tableSize(5), { width: 3, height: 2 })
  assert.deepEqual(tableSize(327), { width: 19, height: 18 })
  assert.deepEqual(tableSize(12956), { width: 114, height: 114 })
  assert.deepEqual(tableSize(16777215), { width: 4096, height: 4096 })
  for (const count of [0, 1, 2, 3, 4, 5, 100, 327, 12956]) {
    const { width, height } = tableSize(count)
    assert.ok(width * height >= count, `${count} atoms fit`)
    assert.ok(width * (height - 1) < Math.max(count, 1), `${count} atoms leave no spare row`)
    const table = createAtomTable(count)
    assert.equal(table.texture.image.width, width)
    assert.equal(table.texture.image.height, height)
    assert.equal(table.texture.image.data, table.bytes)
    assert.equal(table.bytes.length, width * height * 4)
  }
})

void test('a painted texel is its atom\'s colour, and a paint marks the texture for upload', () => {
  const entry = entryOf()
  for (const colorBy of ['element', 'chain', 'bfactor', 'rainbow', 'structure'] as const) {
    for (const burial of [0, 0.5]) {
      const { table, shown } = painted(entry, { colorBy, burial })
      const rgb = atomColors(shown, colorBy, entry, burial)
      shown.forEach((_, i) => {
        assert.deepEqual(texel(table.bytes, i), [byte(rgb[i * 3]), byte(rgb[i * 3 + 1]), byte(rgb[i * 3 + 2]), 255])
      })
    }
  }
  // A carbon in element colouring, as a byte of its linear colour
  const { table, shown } = painted(entry, {})
  const carbon = new Color(0x909090)
  assert.equal(shown[0].element, 'C')
  assert.deepEqual(texel(table.bytes, 0), [byte(carbon.r), byte(carbon.g), byte(carbon.b), 255])
  assert.equal(table.texture.version, 1)
  paintAtomTable(table, { ...defaults, shown, entry })
  assert.equal(table.texture.version, 2)
})

void test('an atom out of focus keeps Fade\'s share of its alpha, and one in focus a full one', () => {
  const entry = entryOf()
  const { table, shown } = painted(entry, { focus: 'ligands', fade: 0.15 })
  const alphas = shown.map((_, i) => table.bytes[i * 4 + 3])
  // The first residue is out of focus, and the second with the ligand in it
  assert.deepEqual(alphas, [38, 38, 255, 255, 255])
  const whole = painted(entry, { focus: 'ligands', fade: 1 })
  assert.deepEqual(whole.shown.map((_, i) => whole.table.bytes[i * 4 + 3]), [255, 255, 255, 255, 255])
  const picked = painted(entry, { focus: 'residue', picked: 'A 2 ', fade: 0 })
  assert.deepEqual(picked.shown.map((_, i) => picked.table.bytes[i * 4 + 3]), [0, 0, 255, 255, 0])
})

void test('every model at once gives each atom one over the square root of the model count, unless layered', () => {
  const entry = entryOf()
  const { table, shown } = painted(entry, { model: null, modelCount: 2 })
  assert.equal(shown.length, 10)
  for (let i = 0; i < shown.length; i++) assert.equal(table.bytes[i * 4 + 3], 180)
  // Layered, only the nearest see-through surface shows, so each model's atoms stay whole, and solid
  const layered = painted(entry, { model: null, modelCount: 2, layered: true })
  for (let i = 0; i < layered.shown.length; i++) assert.equal(layered.table.bytes[i * 4 + 3], 255)
  // An alternate still keeps its occupancy's share, and an atom out of focus Fade's
  const alternates = painted(entry, { conformations: 'all', layered: true })
  assert.deepEqual(alternates.shown.map((_, i) => alternates.table.bytes[i * 4 + 3]), [255, 153, 102, 255, 255, 255])
})

void test('every alternate at once gives an alternate its occupancy\'s share, and the rest a full alpha', () => {
  const entry = entryOf()
  const { table, shown } = painted(entry, { conformations: 'all' })
  assert.deepEqual(shown.map((found) => found.altLoc), ['', 'A', 'B', '', '', ''])
  assert.deepEqual(shown.map((_, i) => table.bytes[i * 4 + 3]), [255, 153, 102, 255, 255, 255])
  // The factors multiply: the alternate B of the first residue, out of focus, with both models drawn
  const all = painted(entry, { conformations: 'all', model: null, modelCount: 2, focus: 'ligands', fade: 0.15 })
  assert.equal(all.table.bytes[2 * 4 + 3], 11)
})

void test('the pick passes through an atom whose alpha is below a fifth of full', () => {
  assert.equal(minPickOpacity, 0.2)
  const bytes = new Uint8ClampedArray([0, 0, 0, 50, 0, 0, 0, 51, 0, 0, 0, 255])
  assert.equal(isPickable(bytes, 0), false)
  assert.equal(isPickable(bytes, 1), true)
  assert.equal(isPickable(bytes, 2), true)
  // At the default Fade an atom out of focus can't be picked, and from a Fade of a fifth it can
  const entry = entryOf()
  const faded = painted(entry, { focus: 'ligands', fade: 0.15 })
  assert.equal(isPickable(faded.table.bytes, 0), false)
  assert.equal(isPickable(faded.table.bytes, 2), true)
  const fifth = painted(entry, { focus: 'ligands', fade: 0.2 })
  assert.equal(isPickable(fifth.table.bytes, 0), true)
})

void test('the ellipsoids\' paint and the field\'s table are painted alike, and only the table sends a texture', () => {
  const entry = entryOf()
  const { table, paint, shown } = painted(entry, { focus: 'ligands', fade: 0.15 })
  const bytes = new Uint8ClampedArray(shown.length * 4)
  paintAtoms(bytes, { ...paint, shown, entry })
  assert.deepEqual([...bytes], [...table.bytes.subarray(0, bytes.length)])
  // Painting the table again has its texture sent again
  const version = table.texture.version
  paintAtomTable(table, { ...paint, shown, entry })
  assert.equal(table.texture.version, version + 1)
})

void test("a merged level's paint is the weighted mean of its members' colours and alphas", () => {
  const entry = entryOf()
  const { table, shown } = painted(entry, { focus: 'ligands', fade: 0.15 })
  // The first residue's two atoms in one group, the second residue's two in another, and the ligand alone
  const grouping = { groups: new Uint32Array([0, 0, 1, 1, 2]), count: 3 }
  const merged = new Uint8ClampedArray(grouping.count * 4)
  paintMerged(merged, table.bytes, grouping, [1, 3, 2, 2, 5])
  const mean = (members: number[], weights: number[], k: number) =>
    members.reduce((sum, i, m) => sum + weights[m] * table.bytes[i * 4 + k], 0) / weights.reduce((a, b) => a + b, 0)
  for (let k = 0; k < 4; k++) {
    assert.equal(merged[k], Math.round(mean([0, 1], [1, 3], k)))
    assert.equal(merged[4 + k], Math.round(mean([2, 3], [2, 2], k)))
    assert.equal(merged[8 + k], table.bytes[4 * 4 + k])
  }
  // A carbon and a nitrogen at weights 2 and 2 give the mean of the two colours, and the out-of-focus pair keeps Fade
  assert.equal(shown[2].element, 'N')
  assert.equal(merged[3], 38)
  assert.equal(merged[7], 255)
})
