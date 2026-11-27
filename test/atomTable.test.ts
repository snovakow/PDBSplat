import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Color, Group } from 'three'
import type { Focus } from '../src/options.ts'
import { burial as burialOf } from '../src/pdb/burial.ts'
import { vdwRadii } from '../src/pdb/elements.ts'
import { hiddenLayer, mergeLevels, partLayer, wholeLayer } from '../src/pdb/merge.ts'
import {
  altLocOf,
  elementOf,
  firstConformationFlag,
  modelOf,
  selectAtoms,
  StructureBuilder,
  type AtomRecord,
  type Structure,
} from '../src/pdb/structure.ts'
import { atomColors } from '../src/viewer/atomColors.ts'
import {
  createAtomTable,
  isPickable,
  minPickOpacity,
  paintAtoms,
  paintAtomTable,
  paintMerged,
  readAtomIndex,
  shownLayers,
  tableSize,
  type TablePaint,
} from '../src/viewer/atomTable.ts'
import { SplatContent } from '../src/viewer/splatContent.ts'

// The atoms' paint: the index bytes the field's table is read by, the table's shape, each painted atom's colour and
// alpha, and the pick's threshold

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

// A chain of two residues with a ligand beside the second, in two models, where the first residue's CB is in two
// conformations: the alternate A with occupancy 0.6 and the alternate B with 0.4. The ligand is 2.5 Å from the second
// residue and over 5 Å from the first, so the binding site is the ligand and the second residue
function entryOf() {
  const model = (number: number): Partial<AtomRecord>[] => [
    { model: number, residueNumber: 1, atomName: 'CA', x: 0 },
    { model: number, residueNumber: 1, atomName: 'CB', x: 1.5, altLoc: 'A', occupancy: 0.6 },
    { model: number, residueNumber: 1, atomName: 'CB', x: 1.5, y: 1, altLoc: 'B', occupancy: 0.4, firstConformation: false },
    { model: number, residueNumber: 2, atomName: 'N', element: 'N', x: 10 },
    { model: number, residueNumber: 2, atomName: 'CA', x: 11.5 },
    { model: number, residueNumber: 50, residueName: 'HEM', atomName: 'FE', element: 'Fe', x: 14, polymer: false },
  ]
  return structureOf([...model(1), ...model(2)])
}

// The rows of the residues the entry's first model holds: the first, the second and the heme
const secondResidue = 1

const defaults: Omit<TablePaint, 'shown' | 'structure'> = {
  colorBy: 'element',
  burial: 0,
  buried: null,
  focus: 'all',
  picked: null,
  fade: 0.15,
  model: 1,
  modelCount: 2,
  conformations: 'first',
  layered: false,
}

// The atoms shown under a paint's model and Alternates, as the store selects them
function shownUnder(structure: Structure, paint: Omit<TablePaint, 'shown' | 'structure'>) {
  const { flags } = structure.atoms
  return selectAtoms(
    structure,
    (atom) =>
      (paint.conformations === 'all' || (flags[atom] & firstConformationFlag) !== 0) &&
      (paint.model === null || modelOf(structure, atom) === paint.model),
  )
}

function painted(structure: Structure, changes: Partial<TablePaint>) {
  const paint = { ...defaults, ...changes }
  const shown = shownUnder(structure, paint)
  const table = createAtomTable(shown.count)
  paintAtomTable(table, { ...paint, shown, structure })
  return { table, shown, paint }
}

// Each shown atom's alpha
const alphas = ({ table, shown }: ReturnType<typeof painted>) => Array.from({ length: shown.count }, (_, i) => table.bytes[i * 4 + 3])

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
      const buried = burialOf(entry).values
      const { table, shown } = painted(entry, { colorBy, burial, buried })
      const rgb = atomColors(entry, shown, colorBy, burial, buried)
      for (let i = 0; i < shown.count; i++) {
        assert.deepEqual(texel(table.bytes, i), [byte(rgb[i * 3]), byte(rgb[i * 3 + 1]), byte(rgb[i * 3 + 2]), 255])
      }
    }
  }
  // A carbon in element colouring, as a byte of its linear colour
  const { table, shown } = painted(entry, {})
  const carbon = new Color(0x909090)
  assert.equal(elementOf(entry, shown.rows[0]), 'C')
  assert.deepEqual(texel(table.bytes, 0), [byte(carbon.r), byte(carbon.g), byte(carbon.b), 255])
  assert.equal(table.texture.version, 1)
  paintAtomTable(table, { ...defaults, shown, structure: entry })
  assert.equal(table.texture.version, 2)
})

void test('an atom out of focus keeps Fade\'s share of its alpha, and one in focus a full one', () => {
  const entry = entryOf()
  // The first residue is out of focus, and the second with the ligand in it
  assert.deepEqual(alphas(painted(entry, { focus: 'ligands', fade: 0.15 })), [38, 38, 255, 255, 255])
  assert.deepEqual(alphas(painted(entry, { focus: 'ligands', fade: 1 })), [255, 255, 255, 255, 255])
  assert.deepEqual(alphas(painted(entry, { focus: 'residue', picked: secondResidue, fade: 0 })), [0, 0, 255, 255, 0])
})

void test('every model at once gives each atom one over the square root of the model count, unless layered', () => {
  const entry = entryOf()
  const every = painted(entry, { model: null, modelCount: 2 })
  assert.equal(every.shown.count, 10)
  assert.deepEqual(alphas(every), Array(10).fill(180))
  // Layered, only the nearest see-through surface shows, so each model's atoms stay whole, and solid
  assert.deepEqual(alphas(painted(entry, { model: null, modelCount: 2, layered: true })), Array(10).fill(255))
  // An alternate still keeps its occupancy's share, and an atom out of focus Fade's
  assert.deepEqual(alphas(painted(entry, { conformations: 'all', layered: true })), [255, 153, 102, 255, 255, 255])
})

void test('every alternate at once gives an alternate its occupancy\'s share, and the rest a full alpha', () => {
  const entry = entryOf()
  const all = painted(entry, { conformations: 'all' })
  assert.deepEqual([...all.shown.rows].map((atom) => altLocOf(entry, atom)), ['', 'A', 'B', '', '', ''])
  assert.deepEqual(alphas(all), [255, 153, 102, 255, 255, 255])
  // The factors multiply: the alternate B of the first residue, out of focus, with both models drawn
  const faded = painted(entry, { conformations: 'all', model: null, modelCount: 2, focus: 'ligands', fade: 0.15 })
  assert.equal(faded.table.bytes[2 * 4 + 3], 11)
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
  const bytes = new Uint8ClampedArray(shown.count * 4)
  paintAtoms(bytes, { ...paint, shown, structure: entry })
  assert.deepEqual([...bytes], [...table.bytes.subarray(0, bytes.length)])
  // Painting the table again has its texture sent again
  const version = table.texture.version
  paintAtomTable(table, { ...paint, shown, structure: entry })
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
  assert.equal(elementOf(entry, shown.rows[2]), 'N')
  assert.equal(merged[3], 38)
  assert.equal(merged[7], 255)
})

// A protein of four residues, each its backbone's four atoms and two of its side chain's
function proteinOf() {
  const names = ['N', 'CA', 'C', 'O', 'CB', 'CG']
  const atoms: Partial<AtomRecord>[] = []
  for (let residue = 1; residue <= 4; residue++) {
    names.forEach((atomName, k) => {
      const side = k >= 4
      atoms.push({ residueNumber: residue, atomName, element: atomName[0], x: residue * 3.8 + k * 0.4, y: side ? 1.5 + k * 0.6 : 0, z: k * 0.2 })
    })
  }
  return structureOf(atoms)
}

void test("under backbone focus a protein's residue blobs are its backbone, whole, and its side chains, faded, which Fade repaints", () => {
  const structure = proteinOf()
  const shown = selectAtoms(structure, () => true)
  const fadeOf = (focus: Focus, fade: number) => ({ shown, structure, focus, picked: null, fade, model: 1, modelCount: 1, conformations: 'first', layered: true }) as const
  // Focus all draws every atom whole, in one layer
  assert.equal(shownLayers(fadeOf('all', 0.3)), null)
  // Backbone focus draws the backbone whole and the side chains in part, and hides them at Fade 0
  const layers = shownLayers(fadeOf('backbone', 0.3))
  const side = (i: number) => i % 6 >= 4
  assert.deepEqual([...(layers ?? [])], Array.from({ length: shown.count }, (_, i) => (side(i) ? partLayer : wholeLayer)))
  // Another Fade above 0 keeps the layers, and the same object, so nothing is merged again
  assert.equal(shownLayers(fadeOf('backbone', 0.6)), layers)
  assert.equal(shownLayers(fadeOf('backbone', 0.95)), layers)
  // A Fade too small for a byte's half hides them, as Fade at 0 does, and one back above it draws them in part again
  const hidden = shownLayers(fadeOf('backbone', 0.001))
  assert.deepEqual([...(hidden ?? [])], Array.from({ length: shown.count }, (_, i) => (side(i) ? hiddenLayer : wholeLayer)))
  assert.equal(shownLayers(fadeOf('backbone', 0)), hidden)
  assert.deepEqual(shownLayers(fadeOf('backbone', 0.3)), layers)

  // The residues' blobs, merged by those layers, and painted
  const blobsUnder = (focus: Focus, fade: number) => {
    const choice = { hydrogens: false, waters: false, conformations: 'first', model: 1 } as const
    const merged = mergeLevels(structure, choice, shownLayers(fadeOf(focus, fade)))
    const shape = { scale: 1, thermal: 0, ellipsoids: false }
    const content = new SplatContent(structure, shown, choice, 'residues', shape, vdwRadii(structure.elements), new Group(), () => () => undefined)
    assert.ok(content.grow(structure, shown, merged, [0, 0, 0], () => Infinity))
    const paint: TablePaint = { ...defaults, ...fadeOf(focus, fade), colorBy: 'chain' }
    while (!content.paintedFrom(paint)) content.paintOnward(paint, () => undefined)
    const residues = content.levels[1]
    assert.ok(residues?.blobs)
    const { count } = residues.blobs.grouping
    return {
      alphas: Array.from({ length: count }, (_, b) => residues.paint[b * 4 + 3]),
      centres: [...residues.blobs.centers.subarray(0, count * 3)],
    }
  }
  const all = blobsUnder('all', 0.3)
  const backbone = blobsUnder('backbone', 0.3)
  // One whole blob a residue under Focus all; under backbone focus a whole one of its backbone and one of its side
  // chain at Fade's share
  const faded = (fade: number) => Uint8ClampedArray.from([255 * fade])[0]
  assert.deepEqual(all.alphas, [255, 255, 255, 255])
  assert.deepEqual(backbone.alphas, [255, faded(0.3), 255, faded(0.3), 255, faded(0.3), 255, faded(0.3)])
  assert.notDeepEqual(backbone.centres.slice(0, 3), all.centres.slice(0, 3))
  // Fade repaints the faded blobs, where they are
  const brighter = blobsUnder('backbone', 0.6)
  assert.deepEqual(brighter.alphas, [255, faded(0.6), 255, faded(0.6), 255, faded(0.6), 255, faded(0.6)])
  assert.deepEqual(brighter.centres, backbone.centres)
  // At Fade 0 the side chains are in no blob, and each residue's one blob is its backbone's
  const bare = blobsUnder('backbone', 0)
  assert.deepEqual(bare.alphas, [255, 255, 255, 255])
  assert.deepEqual(bare.centres.slice(0, 3), backbone.centres.slice(0, 3))
})
