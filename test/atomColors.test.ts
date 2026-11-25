import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { Color, SRGBColorSpace } from 'three'
import {
  selectAtoms,
  StructureBuilder,
  type AtomRecord,
  type SecondaryStructure,
  type Structure,
} from '../src/pdb/structure.ts'
import { atomColors, bFactorSpread, rainbowPositions } from '../src/viewer/atomColors.ts'

// The colourings, on small entries built here. Colours are compared as three's Colors in the working colour space, or
// in sRGB where a rule is written in sRGB

// The burial reports its timing on the console, which the suite's output does without
mock.method(console, 'info', () => undefined)
after(() => mock.restoreAll())

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

// The chain and rainbow colourings' saturation and lightness
const saturation = 0.75
const lightness = 0.55
// The hue step between chains, as a share of the colour wheel
const goldenAngle = 0.618034

// The colours are written in single precision, which measured within 3e-8 of the Colors here
const tolerance = 1e-6

function assertColor(colors: Float32Array, i: number, expected: Color) {
  const actual = [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]]
  const wanted = [expected.r, expected.g, expected.b]
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(actual[k] - wanted[k]) <= tolerance, `atom ${i}: ${actual.join(', ')} for ${wanted.join(', ')}`)
  }
}

// Every atom of a structure coloured, in order
const colorsOf = (structure: Structure, colorBy: Parameters<typeof atomColors>[2], burial = 0) =>
  atomColors(structure, selectAtoms(structure, () => true), colorBy, burial)

const srgb = (r: number, g: number, b: number) => new Color().setRGB(r, g, b, SRGBColorSpace)
const hsl = (hue: number) => new Color().setHSL(hue, saturation, lightness)

void test('the element colouring gives each atom its element\'s colour, and unknown elements one of their own', () => {
  const atoms = ['C', 'N', 'O', 'Fe', 'Xx'].map((element) => ({ element }))
  const colors = colorsOf(structureOf(atoms), 'element')
  assert.equal(colors.length, atoms.length * 3)
  assertColor(colors, 0, new Color(0x909090))
  assertColor(colors, 1, new Color(0x3050f8))
  assertColor(colors, 2, new Color(0xff0d0d))
  assertColor(colors, 3, new Color(0xe06633))
  assertColor(colors, 4, new Color(0xff1493))
})

void test('chains take hues a golden angle apart in the order they first appear', () => {
  const colors = colorsOf(structureOf(['B', 'A', 'B', 'C', 'A'].map((chain) => ({ chain }))), 'chain')
  assertColor(colors, 0, hsl(0))
  assertColor(colors, 1, hsl(goldenAngle))
  assertColor(colors, 2, hsl(0))
  assertColor(colors, 3, hsl((2 * goldenAngle) % 1))
  assertColor(colors, 4, hsl(goldenAngle))
})

void test('the chains take their hues in the order the shown atoms come to them, by name in every model', () => {
  // A chain of waters alone, then chains A and B, in two models
  const water = { residueName: 'HOH', water: true, polymer: false }
  const structure = structureOf([
    { ...water, chain: 'W', labelChain: 'W' },
    { chain: 'A' },
    { chain: 'B', labelChain: 'B' },
    { chain: 'A', model: 2 },
    { chain: 'B', labelChain: 'B', model: 2 },
  ])
  const all = atomColors(structure, selectAtoms(structure, () => true), 'chain', 0)
  assertColor(all, 0, hsl(0))
  assertColor(all, 1, hsl(goldenAngle))
  assertColor(all, 3, hsl(goldenAngle))
  // With the waters hidden, chain A comes first
  const shown = selectAtoms(structure, (atom) => atom > 0)
  const withoutWaters = atomColors(structure, shown, 'chain', 0)
  assertColor(withoutWaters, 0, hsl(0))
  assertColor(withoutWaters, 1, hsl(goldenAngle))
  assertColor(withoutWaters, 2, hsl(0))
  assertColor(withoutWaters, 3, hsl(goldenAngle))
})

void test('the rainbow places a later model\'s residues where the first model has the same ones', () => {
  const chain = (model: number, numbers: number[]): Partial<AtomRecord>[] => numbers.map((residueNumber) => ({ model, residueNumber }))
  const structure = structureOf([...chain(1, [1, 2, 3]), ...chain(2, [1, 2, 3, 4])])
  const positions = rainbowPositions(structure)
  assert.deepEqual([...positions.subarray(0, 6)], [0, 0.5, 1, 0, 0.5, 1])
  // A residue the first model lacks has no place
  assert.ok(Number.isNaN(positions[6]))
})

void test('the B-factor colouring runs from blue at the 5th percentile through white to red at the 95th, mixed in sRGB', () => {
  // Twenty-one B-factors from 0 to 20, so that the percentiles land on 1 and 19, then a water too hot to count, and
  // two waters between, which waters' B-factors don't move
  const water = { residueName: 'HOH', water: true, polymer: false }
  const atoms: Partial<AtomRecord>[] = Array.from({ length: 21 }, (_, i) => ({ bFactor: i, residueNumber: i + 1 }))
  atoms.push({ ...water, bFactor: 100, residueNumber: 301 }, { ...water, bFactor: 5.5, residueNumber: 302 }, { ...water, bFactor: 14.5, residueNumber: 303 })
  const structure = structureOf(atoms)
  assert.deepEqual(bFactorSpread(structure), { low: 1, high: 19 })
  const colors = colorsOf(structure, 'bfactor')
  assertColor(colors, 0, srgb(0, 0, 1))
  assertColor(colors, 1, srgb(0, 0, 1))
  assertColor(colors, 22, srgb(0.5, 0.5, 1))
  assertColor(colors, 10, srgb(1, 1, 1))
  assertColor(colors, 23, srgb(1, 0.5, 0.5))
  assertColor(colors, 19, srgb(1, 0, 0))
  assertColor(colors, 21, srgb(1, 0, 0))
  // Half way in sRGB is darker than half way in the working space
  assert.ok(colors[22 * 3] < 0.5)
  assert.ok(Math.abs(colors[22 * 3] - 0.5) > tolerance)
})

void test('an entry whose percentiles meet is all white', () => {
  const colors = colorsOf(structureOf([{ bFactor: 20 }, { bFactor: 20 }, { bFactor: 20 }]), 'bfactor')
  for (let i = 0; i < 3; i++) assertColor(colors, i, srgb(1, 1, 1))
})

void test('the rainbow runs from blue to red along each chain, and leaves atoms off the polymer in their elements\' colours', () => {
  const chain = (id: string, numbers: number[]): Partial<AtomRecord>[] =>
    numbers.flatMap((residueNumber) => [{ chain: id, residueNumber, atomName: 'N', element: 'N' }, { chain: id, residueNumber }])
  const ligand = { chain: 'A', residueNumber: 142, residueName: 'HEM', element: 'Fe', polymer: false }
  const lone = { chain: 'C', residueNumber: 1 }
  const structure = structureOf([...chain('A', [1, 2, 3, 4, 5]), ligand, ...chain('B', [7, 8, 9]), lone])
  // The residues' rows: chain A's five, the heme, chain B's three and the lone residue
  const positions = rainbowPositions(structure)
  assert.equal(positions[0], 0)
  assert.equal(positions[2], 0.5)
  assert.equal(positions[4], 1)
  assert.ok(Number.isNaN(positions[5]))
  assert.equal(positions[7], 0.5)
  assert.equal(positions[9], 0)
  assert.equal(rainbowPositions(structure), positions)
  const colors = colorsOf(structure, 'rainbow')
  const blue = hsl(240 / 360)
  const green = hsl(120 / 360)
  const red = hsl(0)
  assertColor(colors, 0, blue)
  assertColor(colors, 1, blue)
  assertColor(colors, 4, green)
  assertColor(colors, 9, red)
  assertColor(colors, 10, new Color(0xe06633))
  assertColor(colors, 11, blue)
  assertColor(colors, 13, green)
  assertColor(colors, 16, red)
  assertColor(colors, 17, blue)
})

void test('the structure colouring takes Jmol\'s colours, with DNA and RNA outside the ranges and white for the rest', () => {
  // Each atom a residue of its own, with its residue's secondary structure
  const atoms: [Partial<AtomRecord>, SecondaryStructure][] = [
    [{}, 'helix'],
    [{}, 'strand'],
    [{}, 'turn'],
    [{}, 'none'],
    [{ residueName: 'DA' }, 'none'],
    [{ residueName: 'U' }, 'none'],
    // A modified residue inside a range takes its colour
    [{ residueName: 'MSE', element: 'Se' }, 'helix'],
    // A nucleotide in a range takes the range's colour
    [{ residueName: 'DG' }, 'strand'],
    [{ residueName: 'HEM', element: 'Fe', polymer: false }, 'none'],
    [{ residueName: 'HOH', element: 'O', water: true, polymer: false }, 'none'],
  ]
  const builder = new StructureBuilder()
  atoms.forEach(([changes, structure], i) => {
    builder.add({ ...base, ...changes, residueNumber: i + 1 })
    builder.setSecondaryStructure(i, structure)
  })
  const colors = colorsOf(builder.finish(), 'structure')
  assertColor(colors, 0, new Color(0xff0080))
  assertColor(colors, 1, new Color(0xffc800))
  assertColor(colors, 2, new Color(0x6080ff))
  assertColor(colors, 3, new Color(0xffffff))
  assertColor(colors, 4, new Color(0xae00fe))
  assertColor(colors, 5, new Color(0xfd0162))
  assertColor(colors, 6, new Color(0xff0080))
  assertColor(colors, 7, new Color(0xffc800))
  assertColor(colors, 8, new Color(0xe06633))
  assertColor(colors, 9, new Color(0xff0d0d))
})

void test('Burial darkens each atom by its share of how buried it is', () => {
  // A cube of carbons 1.5 Å apart: its centre is buried to 1 and its corners to 0
  const side = 5
  const half = (side - 1) / 2
  const atoms: Partial<AtomRecord>[] = []
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      for (let k = 0; k < side; k++) atoms.push({ x: (i - half) * 1.5, y: (j - half) * 1.5, z: (k - half) * 1.5 })
    }
  }
  const structure = structureOf(atoms)
  const centre = atoms.findIndex((candidate) => candidate.x === 0 && candidate.y === 0 && candidate.z === 0)
  const carbon = new Color(0x909090)
  for (const strength of [0.5, 1]) {
    const colors = colorsOf(structure, 'element', strength)
    assertColor(colors, centre, carbon.clone().multiplyScalar(1 - strength))
    assertColor(colors, 0, carbon)
    assertColor(colors, atoms.length - 1, carbon)
  }
  const chained = colorsOf(structure, 'chain', 1)
  assertColor(chained, centre, new Color(0, 0, 0))
  assertColor(chained, 0, hsl(0))
})
