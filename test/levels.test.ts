import assert from 'node:assert/strict'
import { test } from 'node:test'
import { vdwRadius } from '../src/pdb/elements.ts'
import { hiddenLayer, mergeLevels, partLayer, remergeChanged, wholeLayer } from '../src/pdb/merge.ts'
import { chainOf, selectAtoms, StructureBuilder, type AtomRecord, type ShownChoice } from '../src/pdb/structure.ts'
import { writeRound } from '../src/viewer/ellipsoidGeometry.ts'
import {
  groupBy,
  levelDrawn,
  levelGroups,
  levelPixels,
  levels,
  mergeGaussians,
  noGroup,
  pixelsPerUnit,
  typicalDiameter,
} from '../src/viewer/levels.ts'

// The levels of detail: the moment-matched merge of Gaussians into groups, the typical drawn diameter and the switch rule

// An ellipsoid is drawn out to two standard deviations
const cutoff = 2

// The covariances are written in single precision
const tolerance = 1e-6

// Round Gaussians of one standard deviation each at the given centres
function round(centers: number[][], sigma = 1) {
  const positions = new Float32Array(centers.flat())
  const covariances = new Float32Array(centers.length * 6)
  centers.forEach((_, i) => writeRound(covariances, i * 6, sigma))
  return { positions, covariances }
}

const near = (actual: ArrayLike<number>, expected: number[], message?: string) => {
  assert.equal(actual.length, expected.length, message)
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance * Math.max(1, Math.abs(expected[i])), `${message ?? ''} [${i}]: ${actual[i]} is not ${expected[i]}`)
  }
}

void test('groupBy numbers the groups in the order they first appear', () => {
  const grouping = groupBy([1, 0, 1, 4, 0], 5)
  assert.deepEqual([...grouping.groups], [0, 1, 0, 2, 1])
  assert.equal(grouping.count, 3)
  assert.deepEqual(groupBy([], 0), { groups: new Uint32Array(0), count: 0 })
})

void test("a merged level groups the shown atoms by residue or by chain, each within its own model", () => {
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
  const builder = new StructureBuilder()
  const atoms: Partial<AtomRecord>[] = [
    { atomName: 'N' },
    {},
    { residueNumber: 2 },
    { chain: 'B', labelChain: 'B' },
    // Chain A's heme, after chain B, in chain A's blob
    { labelChain: 'C', residueName: 'HEM', residueNumber: 142, polymer: false },
    { model: 2 },
    { model: 2, residueNumber: 2 },
  ]
  for (const changes of atoms) builder.add({ ...base, ...changes })
  const structure = builder.finish()
  // Every atom but the first, as Hydrogens or a Focus at 0 might leave them
  const shown = selectAtoms(structure, (atom) => atom > 0)
  const residues = levelGroups(structure, shown, 'residues')
  assert.deepEqual([...residues.groups], [0, 1, 2, 3, 4, 5])
  assert.equal(residues.count, 6)
  const chains = levelGroups(structure, shown, 'chains')
  assert.deepEqual([...chains.groups], [0, 0, 1, 0, 2, 2])
  assert.equal(chains.count, 3)
})

void test("one atom's group is that atom", () => {
  const { positions, covariances } = round([[1, 2, 3]], 0.7)
  const merged = mergeGaussians(positions, covariances, [5], { groups: new Uint32Array([0]), count: 1 })
  near(merged.centers, [1, 2, 3])
  near(merged.covariances, [0.49, 0, 0, 0.49, 0, 0.49])
  assert.deepEqual([...merged.weights], [5])
  assert.deepEqual([...merged.counts], [1])
})

void test('two equal atoms at ±d along x give the mean at the origin, the x variance σ² + d² and the others σ²', () => {
  const d = 1.5
  const sigma = 0.8
  const { positions, covariances } = round(
    [
      [-d, 0, 0],
      [d, 0, 0],
    ],
    sigma,
  )
  const merged = mergeGaussians(positions, covariances, [2, 2], { groups: new Uint32Array([0, 0]), count: 1 })
  near(merged.centers, [0, 0, 0])
  near(merged.covariances, [sigma * sigma + d * d, 0, 0, sigma * sigma, 0, sigma * sigma])
  assert.deepEqual([...merged.weights], [4])
  assert.deepEqual([...merged.counts], [2])
})

void test("a group's covariance is symmetric and positive definite, and a group's scatter stays about its own mean", () => {
  // Three atoms in a triangle away from the origin, two of them in one group and the third alone
  const { positions, covariances } = round(
    [
      [10, 20, 30],
      [12, 21, 30.5],
      [-5, 0, 2],
    ],
    0.5,
  )
  const merged = mergeGaussians(positions, covariances, [1, 3, 2], { groups: new Uint32Array([0, 0, 1]), count: 2 })
  // The pair's mean, three quarters of the way to the heavier atom
  near(merged.centers, [11.5, 20.75, 30.375, -5, 0, 2])
  const [xx, xy, xz, yy, yz, zz] = merged.covariances
  // The scatter of ±(2, 1, 0.5) about the mean, at the weights' shares, plus σ² on the diagonal
  const spread = (a: number, b: number) => (1 * (0.75 * a) * (0.75 * b) + 3 * (0.25 * a) * (0.25 * b)) / 4
  near([xx, xy, xz, yy, yz, zz], [
    0.25 + spread(2, 2),
    spread(2, 1),
    spread(2, 0.5),
    0.25 + spread(1, 1),
    spread(1, 0.5),
    0.25 + spread(0.5, 0.5),
  ])
  // Positive definite by Sylvester's criterion: every leading minor is positive
  assert.ok(xx > 0)
  assert.ok(xx * yy - xy * xy > 0)
  const determinant = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz)
  assert.ok(determinant > 0)
  near(merged.covariances.subarray(6), [0.25, 0, 0, 0.25, 0, 0.25])
  assert.deepEqual([...merged.weights], [4, 2])
  assert.deepEqual([...merged.counts], [2, 1])
})

void test("a heavier atom pulls the mean its way by its weight's share", () => {
  const { positions, covariances } = round([
    [0, 0, 0],
    [4, 0, 0],
  ])
  for (const [light, heavy, mean] of [
    [1, 1, 2],
    [1, 3, 3],
    [3, 1, 1],
    [1, 7, 3.5],
  ]) {
    const merged = mergeGaussians(positions, covariances, [light, heavy], { groups: new Uint32Array([0, 0]), count: 1 })
    near(merged.centers, [mean, 0, 0], `weights ${light} and ${heavy}`)
    // The scatter is the weighted mean of the squared distances from the mean
    const scatter = (light * mean * mean + heavy * (4 - mean) * (4 - mean)) / (light + heavy)
    near(merged.covariances, [1 + scatter, 0, 0, 1, 0, 1], `weights ${light} and ${heavy}`)
  }
})

void test('the typical diameter of one round Gaussian is its drawn diameter, and of several their median', () => {
  const one = round([[0, 0, 0]], 0.85)
  assert.ok(Math.abs(typicalDiameter(one.covariances, cutoff) - 2 * cutoff * 0.85) <= tolerance)
  // An ellipsoid counts by the root of its mean variance
  const ellipsoid = new Float32Array([4, 0, 0, 1, 0, 1])
  assert.equal(typicalDiameter(ellipsoid, cutoff), 2 * cutoff * Math.sqrt(2))
  const sizes = [0.5, 3, 1, 2, 10]
  const several = new Float32Array(sizes.length * 6)
  sizes.forEach((sigma, i) => writeRound(several, i * 6, sigma))
  assert.ok(Math.abs(typicalDiameter(several, cutoff) - 2 * cutoff * 2) <= tolerance)
  // An even count takes the middle pair's mean
  assert.ok(Math.abs(typicalDiameter(several.subarray(0, 24), cutoff) - 2 * cutoff * 1.5) <= tolerance)
  assert.equal(typicalDiameter(new Float32Array(0), cutoff), 0)
})

// The median by a full sort, as the typical diameter was once taken
function sortedMedian(covariances: Float32Array) {
  const diameters = new Float64Array(covariances.length / 6)
  for (let i = 0; i < diameters.length; i++) {
    const trace = covariances[i * 6] + covariances[i * 6 + 3] + covariances[i * 6 + 5]
    diameters[i] = 2 * cutoff * Math.sqrt(trace / 3)
  }
  diameters.sort()
  const middle = diameters.length >> 1
  return diameters.length % 2 === 1 ? diameters[middle] : (diameters[middle - 1] + diameters[middle]) / 2
}

void test('the typical diameter found by histograms is the sorted median exactly, however many share a size', () => {
  let state = 5
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  // Counts below, at and above the size at which the histograms start, with sizes all distinct, from a few kinds as
  // the atoms of one element at Thermal 0 are, and spread over decades as blobs are
  for (const count of [1, 2, 7, 1000, 65536, 65537, 200001, 200002]) {
    const sigmas: ((i: number) => number)[] = [
      () => 0.1 + next() * 3,
      (i) => [0.85, 0.775, 0.76, 0.9, 0.6][i % 5],
      () => Math.exp(next() * 8 - 2),
    ]
    for (const sigma of sigmas) {
      const covariances = new Float32Array(count * 6)
      for (let i = 0; i < count; i++) writeRound(covariances, i * 6, sigma(i))
      assert.equal(typicalDiameter(covariances, cutoff), sortedMedian(covariances), `${count} Gaussians`)
    }
  }
})

void test('the switch rule picks the finest level still a few pixels across, or the coarsest where none is', () => {
  assert.equal(levelPixels, 4)
  assert.deepEqual(levels, ['atoms', 'residues', 'chains'])
  // Diameters in ångströms, finest first, as a protein's might be, with every level offered
  const diameters = [3.4, 8, 40]
  const all = [true, true, true]
  // The atoms just reach the threshold, and just fall short of it
  assert.equal(levelDrawn('auto', all, diameters, levelPixels / 3.4), 0)
  assert.equal(levelDrawn('auto', all, diameters, levelPixels / 3.4 - 1e-9), 1)
  assert.equal(levelDrawn('auto', all, diameters, levelPixels / 8), 1)
  assert.equal(levelDrawn('auto', all, diameters, levelPixels / 8 - 1e-9), 2)
  assert.equal(levelDrawn('auto', all, diameters, levelPixels / 40), 2)
  // Nothing reaches it, so the coarsest is drawn
  assert.equal(levelDrawn('auto', all, diameters, levelPixels / 40 - 1e-9), 2)
  assert.equal(levelDrawn('auto', all, diameters, 0), 2)
  // With the camera at the structure's centre, the finest
  assert.equal(levelDrawn('auto', all, diameters, Infinity), 0)
})

void test('the pixels per unit follow the viewport height, the field of view and the depth', () => {
  // At a depth where the view spans twice the depth, a 90° field of view, a unit is a pixel on a two-pixel-tall viewport
  assert.ok(Math.abs(pixelsPerUnit(2, 90, 1) - 1) <= 1e-12)
  // A 713 px viewport at 50° looking at a point 47 units away
  const expected = 713 / (2 * 47 * Math.tan((25 * Math.PI) / 180))
  assert.ok(Math.abs(pixelsPerUnit(713, 50, 47) - expected) <= 1e-12)
  // Twice the depth halves it, and twice the height doubles it
  assert.ok(Math.abs(pixelsPerUnit(713, 50, 94) - expected / 2) <= 1e-12)
  assert.ok(Math.abs(pixelsPerUnit(1426, 50, 47) - expected * 2) <= 1e-12)
})

void test('the level drawn is the one the switch rule picks, among the levels whose instances fit their pools', () => {
  const diameters = [3.4, 8, 40]
  const all = [true, true, true]
  // A fixed Detail draws its own level
  assert.equal(levelDrawn('atoms', all, diameters, 0), 0)
  assert.equal(levelDrawn('residues', all, diameters, 100), 1)
  assert.equal(levelDrawn('chains', all, diameters, 100), 2)
  // Atoms too many for their pool give way to residues, under auto and under a fixed Detail alike
  const noAtoms = [false, true, true]
  assert.equal(levelDrawn('auto', noAtoms, diameters, 100), 1)
  assert.equal(levelDrawn('auto', noAtoms, diameters, Infinity), 1)
  assert.equal(levelDrawn('auto', noAtoms, diameters, levelPixels / 40 - 1e-9), 2)
  assert.equal(levelDrawn('atoms', noAtoms, diameters, 100), 1)
  // And with neither fitting, the chains, whose pool holds every one
  assert.equal(levelDrawn('auto', [false, false, true], diameters, 100), 2)
  assert.equal(levelDrawn('atoms', [false, false, true], diameters, 100), 2)
})

// Three chains of residues of several elements, then waters of the first chain in a run of their own, each atom at a
// place that a shift moves where the atom is hidden
function layeredEntry(shiftHidden: (atom: number) => number) {
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
  const builder = new StructureBuilder()
  let atom = 0
  for (const [c, chain] of ['A', 'B', 'C'].entries()) {
    for (let residue = 1; residue <= 8; residue++) {
      for (const [k, element] of ['N', 'C', 'C', 'O', 'S'].entries()) {
        const shift = shiftHidden(atom++)
        builder.add({ ...base, chain, labelChain: chain, residueNumber: residue, element, atomName: `${element}${k}`, x: 3 * residue + k * 0.7 + shift, y: c * 11 + Math.sin(residue + k), z: k * 0.4 - c })
      }
    }
  }
  for (let water = 0; water < 6; water++) {
    const shift = shiftHidden(atom++)
    builder.add({ ...base, labelChain: 'W', residueName: 'HOH', residueNumber: 100 + water, element: 'O', water: true, polymer: false, x: water * 2 + shift, y: -9, z: 4 })
  }
  return builder.finish()
}

void test("the merge by layer is the merge of each layer's members alone, and a hidden member is in no blob", () => {
  // A fixed sequence of layers, a sixth of the atoms hidden and a third drawn in part
  let seed = 7
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const count = 3 * 8 * 5 + 6
  const layers = Uint8Array.from({ length: count }, () => {
    const roll = next()
    return roll < 1 / 6 ? hiddenLayer : roll < 0.5 ? partLayer : wholeLayer
  })
  const structure = layeredEntry(() => 0)
  const shown = selectAtoms(structure, () => true)
  const choice: ShownChoice = { hydrogens: true, waters: true, conformations: 'first', model: 1 }
  const merged = mergeLevels(structure, choice, layers)
  assert.equal(merged.layers, layers)
  const positions = structure.atoms.positions
  const weights = Array.from({ length: count }, (_, i) => vdwRadius(structure.elements[structure.atoms.element[i]]) ** 3)
  const none = new Float32Array(count * 6)
  for (const level of ['residues', 'chains'] as const) {
    // As the shown atoms' groups by layer give it, the hidden ones in none
    const grouping = levelGroups(structure, shown, level, layers)
    for (let i = 0; i < count; i++) assert.equal(grouping.groups[i] === noGroup, layers[i] === hiddenLayer)
    const reference = mergeGaussians(positions, none, weights, grouping)
    assert.equal(merged[level].count, grouping.count)
    near(merged[level].centers, [...reference.centers], level)
    for (let k = 0; k < merged[level].scatters.length; k++) {
      assert.ok(Math.abs(merged[level].scatters[k] - reference.covariances[k]) < 1e-3, `${level} scatter ${k}`)
    }
    // Each layer's members alone, grouped by their residue or chain, merge to the blobs of that layer
    for (const layer of [wholeLayer, partLayer]) {
      const members = [...shown.rows].filter((_, i) => layers[i] === layer)
      const keys = members.map((i) => (level === 'residues' ? structure.atoms.residue[i] : chainOf(structure, i)))
      const alone = mergeGaussians(
        Float32Array.from(members.flatMap((i) => [...positions.subarray(i * 3, i * 3 + 3)])),
        new Float32Array(members.length * 6),
        members.map((i) => weights[i]),
        groupBy(keys, level === 'residues' ? structure.residues.count : structure.chains.count),
      )
      const { groups } = groupBy(keys, level === 'residues' ? structure.residues.count : structure.chains.count)
      members.forEach((i, k) => {
        const blob = grouping.groups[i]
        near(merged[level].centers.subarray(blob * 3, blob * 3 + 3), [...alone.centers.subarray(groups[k] * 3, groups[k] * 3 + 3)], `${level} layer ${layer}`)
      })
    }
  }
  // A hidden atom moved anywhere moves no blob
  const moved = layeredEntry((atom) => (layers[atom] === hiddenLayer ? 500 : 0))
  const again = mergeLevels(moved, choice, layers)
  assert.deepEqual(again.residues, merged.residues)
  assert.deepEqual(again.chains, merged.chains)
  // Merged in one layer, every shown atom is in a blob, as without layers
  assert.deepEqual(mergeLevels(structure, choice, new Uint8Array(count)).residues, mergeLevels(structure, choice).residues)
})

void test('the levels merged again for the chains whose atoms changed layer are those a whole merge gives', () => {
  let seed = 11
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const count = 3 * 8 * 5 + 6
  const randomLayers = () => Uint8Array.from({ length: count }, () => {
    const roll = next()
    return roll < 1 / 6 ? hiddenLayer : roll < 0.5 ? partLayer : wholeLayer
  })
  const structure = layeredEntry(() => 0)
  const shown = selectAtoms(structure, () => true)
  const choice: ShownChoice = { hydrogens: true, waters: true, conformations: 'first', model: 1 }
  const first = randomLayers()
  // One residue's atoms moved to another layer, as a pick moves them; every atom's; and every atom back to one layer
  const picked = first.slice()
  for (const i of [5, 6, 7, 8, 9]) picked[i] = picked[i] === wholeLayer ? partLayer : wholeLayer
  const cases: (Uint8Array | null)[] = [picked, randomLayers(), null, first]
  let previous = mergeLevels(structure, choice, first)
  for (const layers of cases) {
    const again = remergeChanged(structure, shown.rows, shown.count, previous, layers, Infinity)
    assert.ok(again)
    assert.deepEqual(again, mergeLevels(structure, choice, layers))
    assert.equal(again.layers, layers)
    previous = again
  }
  // A pick touches one chain, whose atoms alone are merged again, its forty and its six waters; more than a limit of
  // them asks for a whole merge
  const one = remergeChanged(structure, shown.rows, shown.count, mergeLevels(structure, choice, first), picked, 46)
  assert.ok(one)
  assert.equal(remergeChanged(structure, shown.rows, shown.count, mergeLevels(structure, choice, first), picked, 45), null)
})
