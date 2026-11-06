import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { Color, SRGBColorSpace } from 'three'
import type { Atom } from '../src/pdb/mmcif.ts'
import { atomColors, bFactorSpread, rainbowPositions } from '../src/viewer/atomColors.ts'

// The colourings, on small entries built here. Colours are compared as three's Colors in the working colour space, or
// in sRGB where a rule is written in sRGB

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
  hetero: false,
  polymer: true,
  hydrogen: false,
  water: false,
  structure: 'none',
  u: null,
}
const atom = (changes: Partial<Atom>): Atom => ({ ...base, ...changes })

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

const srgb = (r: number, g: number, b: number) => new Color().setRGB(r, g, b, SRGBColorSpace)
const hsl = (hue: number) => new Color().setHSL(hue, saturation, lightness)

void test('the element colouring gives each atom its element\'s colour, and unknown elements one of their own', () => {
  const atoms = [atom({ element: 'C' }), atom({ element: 'N' }), atom({ element: 'O' }), atom({ element: 'Fe' }), atom({ element: 'Xx' })]
  const colors = atomColors(atoms, 'element', atoms, 0)
  assert.equal(colors.length, atoms.length * 3)
  assertColor(colors, 0, new Color(0x909090))
  assertColor(colors, 1, new Color(0x3050f8))
  assertColor(colors, 2, new Color(0xff0d0d))
  assertColor(colors, 3, new Color(0xe06633))
  assertColor(colors, 4, new Color(0xff1493))
})

void test('chains take hues a golden angle apart in the order they first appear', () => {
  const atoms = [atom({ chain: 'B' }), atom({ chain: 'A' }), atom({ chain: 'B' }), atom({ chain: 'C' }), atom({ chain: 'A' })]
  const colors = atomColors(atoms, 'chain', atoms, 0)
  assertColor(colors, 0, hsl(0))
  assertColor(colors, 1, hsl(goldenAngle))
  assertColor(colors, 2, hsl(0))
  assertColor(colors, 3, hsl((2 * goldenAngle) % 1))
  assertColor(colors, 4, hsl(goldenAngle))
})

void test('the B-factor colouring runs from blue at the 5th percentile through white to red at the 95th, mixed in sRGB', () => {
  // Twenty-one B-factors from 0 to 20, so that the percentiles land on 1 and 19, and a water too hot to count
  const entry = Array.from({ length: 21 }, (_, i) => atom({ bFactor: i }))
  entry.push(atom({ bFactor: 100, residueName: 'HOH', water: true, polymer: false }))
  assert.deepEqual(bFactorSpread(entry), { low: 1, high: 19 })
  const atoms = [
    atom({ bFactor: 0 }),
    atom({ bFactor: 1 }),
    atom({ bFactor: 5.5 }),
    atom({ bFactor: 10 }),
    atom({ bFactor: 14.5 }),
    atom({ bFactor: 19 }),
    atom({ bFactor: 100 }),
  ]
  const colors = atomColors(atoms, 'bfactor', entry, 0)
  assertColor(colors, 0, srgb(0, 0, 1))
  assertColor(colors, 1, srgb(0, 0, 1))
  assertColor(colors, 2, srgb(0.5, 0.5, 1))
  assertColor(colors, 3, srgb(1, 1, 1))
  assertColor(colors, 4, srgb(1, 0.5, 0.5))
  assertColor(colors, 5, srgb(1, 0, 0))
  assertColor(colors, 6, srgb(1, 0, 0))
  // Half way in sRGB is darker than half way in the working space
  assert.ok(colors[6] < 0.5)
  assert.ok(Math.abs(colors[6] - 0.5) > tolerance)
})

void test('an entry whose percentiles meet is all white', () => {
  const entry = [atom({ bFactor: 20 }), atom({ bFactor: 20 }), atom({ bFactor: 20 })]
  const colors = atomColors(entry, 'bfactor', entry, 0)
  for (let i = 0; i < entry.length; i++) assertColor(colors, i, srgb(1, 1, 1))
})

void test('the rainbow runs from blue to red along each chain, and leaves atoms off the polymer in their elements\' colours', () => {
  const chain = (id: string, numbers: number[]) =>
    numbers.flatMap((residueNumber) => [atom({ chain: id, residueNumber, atomName: 'N', element: 'N' }), atom({ chain: id, residueNumber })])
  const ligand = atom({ chain: 'A', residueNumber: 142, residueName: 'HEM', element: 'Fe', polymer: false })
  const lone = atom({ chain: 'C', residueNumber: 1 })
  const entry = [...chain('A', [1, 2, 3, 4, 5]), ligand, ...chain('B', [7, 8, 9]), lone]
  const positions = rainbowPositions(entry)
  assert.equal(positions.get('A 1 '), 0)
  assert.equal(positions.get('A 3 '), 0.5)
  assert.equal(positions.get('A 5 '), 1)
  assert.equal(positions.get('A 142 '), undefined)
  assert.equal(positions.get('B 8 '), 0.5)
  assert.equal(positions.get('C 1 '), 0)
  const colors = atomColors(entry, 'rainbow', entry, 0)
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
  const atoms = [
    atom({ structure: 'helix' }),
    atom({ structure: 'strand' }),
    atom({ structure: 'turn' }),
    atom({ structure: 'none' }),
    atom({ structure: 'none', residueName: 'DA' }),
    atom({ structure: 'none', residueName: 'U' }),
    // A modified residue inside a range takes its colour
    atom({ structure: 'helix', residueName: 'MSE', element: 'Se' }),
    // A nucleotide in a range takes the range's colour
    atom({ structure: 'strand', residueName: 'DG' }),
    atom({ residueName: 'HEM', element: 'Fe', polymer: false }),
    atom({ residueName: 'HOH', element: 'O', water: true, polymer: false }),
  ]
  const colors = atomColors(atoms, 'structure', atoms, 0)
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
  const atoms: Atom[] = []
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      for (let k = 0; k < side; k++) atoms.push(atom({ x: (i - half) * 1.5, y: (j - half) * 1.5, z: (k - half) * 1.5 }))
    }
  }
  const centre = atoms.findIndex((candidate) => candidate.x === 0 && candidate.y === 0 && candidate.z === 0)
  const carbon = new Color(0x909090)
  for (const strength of [0.5, 1]) {
    const colors = atomColors(atoms, 'element', atoms, strength)
    assertColor(colors, centre, carbon.clone().multiplyScalar(1 - strength))
    assertColor(colors, 0, carbon)
    assertColor(colors, atoms.length - 1, carbon)
  }
  const chained = atomColors(atoms, 'chain', atoms, 1)
  assertColor(chained, centre, new Color(0, 0, 0))
  assertColor(chained, 0, hsl(0))
})
