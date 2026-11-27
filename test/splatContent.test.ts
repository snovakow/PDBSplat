import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Group } from 'three'
import { defaultOptions } from '../src/options.ts'
import { vdwRadii } from '../src/pdb/elements.ts'
import { hiddenLayer, mergeLevels, partLayer, wholeLayer } from '../src/pdb/merge.ts'
import { chainOf, StructureBuilder, type AtomRecord, type ShownAtoms, type ShownChoice, type Structure } from '../src/pdb/structure.ts'
import { shownAtoms } from '../src/store.ts'
import { paintAtoms, paintMerged, type TablePaint } from '../src/viewer/atomTable.ts'
import { covarianceSize, ellipsoidExtent, ellipsoidsReach, paintSize, surfaceDeviations } from '../src/viewer/ellipsoidGeometry.ts'
import { writeAtomShape } from '../src/viewer/ellipsoids.ts'
import { blobCovariances, levelGroups, levels, noGroup, typicalDiameter } from '../src/viewer/levels.ts'
import {
  atomSpans,
  chainSpans,
  pieceCount,
  pieceSpheres,
  residueSpans,
  sphereSize,
  type DrawnInstances,
} from '../src/viewer/pieces.ts'
import { SplatContent } from '../src/viewer/splatContent.ts'

// The splats' content of an entry as it arrives, grown a batch at a time, against the same content built from the
// whole entry at once, and that against what each level's own rules give for the whole entry

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

// Four chains of residues along curves, with hydrogens and an alternate, and waters of two chains after all of them
function entryAtoms(): Partial<AtomRecord>[] {
  const atoms: Partial<AtomRecord>[] = []
  for (const [c, chain] of ['A', 'B', 'C', 'D'].entries()) {
    for (let residue = 1; residue <= 60; residue++) {
      for (const [k, element] of ['N', 'C', 'C', 'O', 'S', 'H'].entries()) {
        const t = residue / 8 + c
        atoms.push({
          chain,
          labelChain: chain,
          residueNumber: residue,
          element,
          hydrogen: element === 'H',
          atomName: `${element}${k}`,
          x: 20 * Math.cos(t) + c * 9 + k * 0.6,
          y: residue * 1.4 - c * 30,
          z: 20 * Math.sin(t) + k * 0.3,
          bFactor: 10 + ((residue * 7 + k) % 40),
        })
      }
      if (residue % 9 === 0) atoms.push({ chain, labelChain: chain, residueNumber: residue, altLoc: 'B', firstConformation: false, x: 3 })
    }
  }
  for (let water = 0; water < 24; water++) {
    atoms.push({ chain: water % 2 ? 'A' : 'C', labelChain: 'E', residueNumber: 400 + water, residueName: 'HOH', element: 'O', water: true, polymer: false, x: water * 2, y: -60, z: 10 })
  }
  return atoms
}

// The entry's snapshots as it arrives, a batch at the start of every so many atoms' residue, the last whole
function arriving(atoms: Partial<AtomRecord>[], size: number): Structure[] {
  const source = new StructureBuilder()
  const target = new StructureBuilder()
  const snapshots: Structure[] = []
  let since = 0
  for (const changes of atoms) {
    if (since >= size) {
      source.callAtNextResidue(() => {
        target.append(source.takeBatch(''), atoms.length)
        snapshots.push(target.snapshot())
        since = 0
      })
    }
    source.add({ ...base, ...changes })
    since++
  }
  target.append(source.takeBatch('', true))
  snapshots.push(target.snapshot())
  return snapshots
}

const options = { ...defaultOptions, waters: true }
const shape = { scale: options.scale, thermal: 0.4, ellipsoids: false }
const slots = () => Infinity

// The shown atoms of a snapshot, its choice, its blobs merged and its paint's inputs
function inputsOf(structure: Structure) {
  const state = { structure, options, models: structure.models, model: structure.models[0] ?? 1 }
  const shown = shownAtoms(state)
  const choice: ShownChoice = { hydrogens: options.hydrogens, waters: options.waters, conformations: options.conformations, model: state.model }
  const merged = mergeLevels(structure, choice)
  const paint: TablePaint = {
    shown,
    structure,
    colorBy: 'chain',
    burial: 0.5,
    buried: null,
    focus: 'all',
    picked: null,
    fade: options.fade,
    model: state.model,
    modelCount: structure.models.length,
    conformations: options.conformations,
    layered: true,
  }
  return { shown, choice, merged, paint }
}

// A content grown through the snapshots, painted after each, and its exact reach worked through
function grownThrough(snapshots: Structure[]) {
  const first = inputsOf(snapshots[0])
  const content = new SplatContent(snapshots[0], first.shown, first.choice, 'auto', shape, vdwRadii(snapshots[0].elements), new Group(), () => () => undefined)
  for (const structure of snapshots) {
    const { shown, choice, merged, paint } = inputsOf(structure)
    assert.ok(content.structure === snapshots[0] || content.growsInto(structure, choice, 'auto', shape, merged, content.structureObject))
    const changed = content.grow(structure, shown, merged, [0, 0, 0], slots)
    assert.ok(changed)
    while (!content.paintedFrom(paint)) content.paintOnward(paint, () => undefined)
  }
  while (content.reachOnward() === null) {
    // a step of the exact reach at a time
  }
  return content
}

// The instances of a level a content holds, each sphere's piece found from its spans
function* instancesOf(content: SplatContent, level: number) {
  const owned = content.levels[level]
  if (!owned) return
  const { spans } = owned
  for (let piece = 1; piece < spans.sizes.length; piece++) {
    for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) for (let i = spans.start[s]; i < spans.end[s]; i++) yield { piece, i }
  }
}

void test('content grown batch by batch is the content built whole, but for spheres that hold everything they did', () => {
  const atoms = entryAtoms()
  const whole = grownThrough(arriving(atoms, Infinity))
  for (const size of [1, 200]) {
    const snapshots = arriving(atoms, size)
    assert.ok(snapshots.length > 3)
    const grown = grownThrough(snapshots)
    const count = whole.shown.count
    assert.equal(grown.shown.count, count)
    assert.deepEqual(grown.weights.subarray(0, count), whole.weights.subarray(0, count))
    assert.deepEqual(grown.atomPaint.subarray(0, count * paintSize), whole.atomPaint.subarray(0, count * paintSize))
    assert.deepEqual(grown.atoms, whole.atoms)
    // The atoms level is drawn with the atoms' paint, every shown atom's alpha above nothing
    assert.equal(grown.levels[0]?.paint, grown.atomPaint)
    for (let i = 0; i < count; i++) assert.ok(grown.atomPaint[i * paintSize + 3] > 0, `${size}: atom ${i}`)
    levels.forEach((_, level) => {
      const a = grown.levels[level]
      const b = whole.levels[level]
      assert.ok(a && b)
      assert.deepEqual(a.spans, b.spans, `${size}: level ${level}`)
      if (a.blobs && b.blobs) {
        const blobs = b.blobs.grouping.count
        assert.equal(a.blobs.grouping.count, blobs)
        assert.deepEqual(a.blobs.grouping.groups.subarray(0, count), b.blobs.grouping.groups.subarray(0, count))
        assert.deepEqual(a.blobs.covariances.subarray(0, blobs * covarianceSize), b.blobs.covariances.subarray(0, blobs * covarianceSize))
        assert.deepEqual(a.paint.subarray(0, blobs * paintSize), b.paint.subarray(0, blobs * paintSize))
      }
    })
    assert.deepEqual(grown.diameters, whole.diameters)
    assert.deepEqual(grown.offered, whole.offered)
    assert.equal(grown.reach, whole.reach)
    // Each piece's sphere grew to hold every instance it draws at every level
    for (let level = 0; level < levels.length; level++) {
      const owned = grown.levels[level]
      for (const { piece, i } of instancesOf(grown, level)) {
        const at = piece * sphereSize
        const centre = owned?.blobs ? owned.blobs.centers.subarray(i * 3, i * 3 + 3) : grown.structure.atoms.positions.subarray(grown.shown.rows[i] * 3, grown.shown.rows[i] * 3 + 3)
        let extent = 0
        if (owned?.blobs) extent = ellipsoidExtent(owned.blobs.covariances, i * covarianceSize)
        else {
          const one = new Float32Array(covarianceSize)
          writeAtomShape(one, 0, grown.structure, grown.shown.rows[i], grown.radii, shape)
          extent = ellipsoidExtent(one, 0)
        }
        const spheres = grown.spheres
        const reach = Math.hypot(centre[0] - spheres[at], centre[1] - spheres[at + 1], centre[2] - spheres[at + 2]) + extent
        assert.ok(reach <= spheres[at + 3], `${size}: level ${level} instance ${i} of piece ${piece}`)
      }
    }
  }
})

// A merged level's spans from the shown atoms' groups by the layers given: each residue's blobs from its first, and
// each chain's blob in each layer
function spansOf(structure: Structure, shown: ShownAtoms, level: 'residues' | 'chains', layers: Uint8Array | null) {
  const atoms = atomSpans(structure, shown)
  const { groups } = levelGroups(structure, shown, level, layers)
  if (level === 'chains') {
    const chainBlobs = new Int32Array(structure.chains.count * 2).fill(-1)
    for (let i = 0; i < shown.count; i++) {
      const layer = layers ? layers[i] : wholeLayer
      if (layer !== hiddenLayer) chainBlobs[chainOf(structure, shown.rows[i]) * 2 + layer] = groups[i]
    }
    return chainSpans(pieceCount(structure), chainBlobs, 2)
  }
  const { residue } = structure.atoms
  const first = new Uint32Array(structure.residues.count)
  const count = new Uint8Array(structure.residues.count)
  let blobs = 0
  for (let i = 0; i < shown.count; ) {
    const row = residue[shown.rows[i]]
    const owned = new Set<number>()
    for (; i < shown.count && residue[shown.rows[i]] === row; i++) if (groups[i] !== noGroup) owned.add(groups[i])
    first[row] = blobs
    count[row] = owned.size
    blobs += owned.size
  }
  return residueSpans(atoms, (i) => residue[shown.rows[i]], first, count)
}

// Some of the shown atoms drawn in part and some hidden, the rest whole
function someLayers(count: number) {
  return Uint8Array.from({ length: count }, (_, i) => (i % 5 === 0 ? partLayer : i % 7 === 3 ? hiddenLayer : wholeLayer))
}

for (const byLayer of [false, true]) {
  void test(`content built whole ${byLayer ? 'by layers ' : ''}is what each level of the entry gives by its own rules`, () => {
    const [structure] = arriving(entryAtoms(), Infinity)
    const inputs = inputsOf(structure)
    const { shown, paint } = inputs
    const layers = byLayer ? someLayers(shown.count) : null
    const merged = byLayer ? mergeLevels(structure, inputs.choice, layers) : inputs.merged
    const content = byLayer
      ? new SplatContent(structure, shown, inputs.choice, 'auto', shape, vdwRadii(structure.elements), new Group(), () => () => undefined)
      : grownThrough([structure])
    if (byLayer) {
      assert.ok(content.grow(structure, shown, merged, [0, 0, 0], slots))
      while (!content.paintedFrom(paint)) content.paintOnward(paint, () => undefined)
      while (content.reachOnward() === null) {
        // a step of the exact reach at a time
      }
    }
    const radii = vdwRadii(structure.elements)
    const centers = new Float32Array(shown.count * 3)
    const covariances = new Float32Array(shown.count * covarianceSize)
    const weights = new Float32Array(shown.count)
    for (let i = 0; i < shown.count; i++) {
      const atom = shown.rows[i]
      centers.set(structure.atoms.positions.subarray(atom * 3, atom * 3 + 3), i * 3)
      const radius = radii[structure.atoms.element[atom]] * shape.scale
      weights[i] = radius * radius * radius
      writeAtomShape(covariances, i * covarianceSize, structure, atom, radii, shape)
    }
    const atomPaint = new Uint8ClampedArray(shown.count * paintSize)
    paintAtoms(atomPaint, paint)
    const atoms = atomSpans(structure, shown)
    assert.deepEqual(content.atoms, atoms)
    assert.deepEqual(content.atomPaint.subarray(0, shown.count * paintSize), atomPaint)
    assert.deepEqual(content.levels[0]?.paint.subarray(0, shown.count * paintSize), atomPaint)
    assert.deepEqual(content.weights.subarray(0, shown.count), weights)
    const drawn: DrawnInstances[] = [{ spans: atoms, centers, covariances }]
    let reach = ellipsoidsReach(centers, covariances, { x: 0, y: 0, z: 0 })
    const diameters = [typicalDiameter(covariances, surfaceDeviations)]
    for (const level of ['residues', 'chains'] as const) {
      const grouping = levelGroups(structure, shown, level, layers)
      const placed = merged[level]
      assert.equal(placed.count, grouping.count)
      const blobs = blobCovariances(placed.scatters, covariances, weights, grouping)
      const spans = spansOf(structure, shown, level, layers)
      const owned = content.levels[levels.indexOf(level)]
      assert.ok(owned?.blobs)
      assert.deepEqual(owned.spans, spans)
      assert.deepEqual(owned.blobs.grouping.groups.subarray(0, shown.count), grouping.groups)
      assert.deepEqual(owned.blobs.covariances.subarray(0, grouping.count * covarianceSize), blobs)
      const blobPaint = new Uint8ClampedArray(grouping.count * paintSize)
      paintMerged(blobPaint, atomPaint, grouping, weights)
      assert.deepEqual(owned.paint.subarray(0, grouping.count * paintSize), blobPaint)
      drawn.push({ spans, centers: placed.centers, covariances: blobs })
      reach = Math.max(reach, ellipsoidsReach(placed.centers, blobs, { x: 0, y: 0, z: 0 }))
      diameters.push(typicalDiameter(blobs, surfaceDeviations))
    }
    // Piece 0 is no piece, and draws nothing
    const pieces = (structure.chains.count + 1) * sphereSize
    assert.deepEqual(content.spheres.subarray(sphereSize, pieces), pieceSpheres(drawn).subarray(sphereSize))
    assert.equal(content.reach, reach)
    assert.deepEqual(content.diameters, diameters)

    // Each atom's parent is its residue's blob in its layer, and each residue blob's its chain's blob in the same layer;
    // each blob is carried by its member nearest its centre
    const [atomsLevel, residuesLevel, chainsLevel] = content.levels
    assert.ok(atomsLevel && residuesLevel?.blobs && residuesLevel.parents && residuesLevel.carriers && chainsLevel?.blobs && chainsLevel.carriers)
    const residueGroups = levelGroups(structure, shown, 'residues', layers).groups
    const chainGroups = levelGroups(structure, shown, 'chains', layers).groups
    assert.deepEqual(atomsLevel.parents?.subarray(0, shown.count), residueGroups)
    const distance = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
      Math.hypot(a[i * 3] - b[j * 3], a[i * 3 + 1] - b[j * 3 + 1], a[i * 3 + 2] - b[j * 3 + 2])
    const nearestAtom = new Map<number, number>()
    for (let i = 0; i < shown.count; i++) {
      const blob = residueGroups[i]
      if (blob === noGroup) continue
      assert.equal(residuesLevel.parents[blob], chainGroups[i])
      const best = nearestAtom.get(blob)
      if (best === undefined || distance(centers, i, merged.residues.centers, blob) < distance(centers, best, merged.residues.centers, blob)) nearestAtom.set(blob, i)
    }
    for (const [blob, atom] of nearestAtom) assert.equal(residuesLevel.carriers[blob], atom, `residue blob ${blob}`)
    const nearestResidue = new Map<number, number>()
    for (let blob = 0; blob < merged.residues.count; blob++) {
      const chain = residuesLevel.parents[blob]
      const best = nearestResidue.get(chain)
      const from = (b: number) => distance(merged.residues.centers, b, merged.chains.centers, chain)
      if (best === undefined || from(blob) < from(best)) nearestResidue.set(chain, blob)
    }
    assert.equal(nearestResidue.size, merged.chains.count)
    for (const [chain, blob] of nearestResidue) assert.equal(chainsLevel.carriers[chain], blob, `chain blob ${chain}`)
  })
}

void test('content that takes blobs merged again for new layers in place is the content built afresh for them', () => {
  const [structure] = arriving(entryAtoms(), Infinity)
  const { shown, choice, paint } = inputsOf(structure)
  const built = (layers: Uint8Array | null) => {
    const content = new SplatContent(structure, shown, choice, 'auto', shape, vdwRadii(structure.elements), new Group(), () => () => undefined)
    assert.ok(content.grow(structure, shown, mergeLevels(structure, choice, layers), [0, 0, 0], slots))
    while (!content.paintedFrom(paint)) content.paintOnward(paint, () => undefined)
    while (content.reachOnward() === null) {
      // a step of the exact reach at a time
    }
    return content
  }
  const first = someLayers(shown.count)
  // A pick's change, one residue's atoms moved between layers; another set of layers everywhere; and one layer
  const picked = first.slice()
  for (let i = 30; i < 36; i++) picked[i] = picked[i] === wholeLayer ? partLayer : wholeLayer
  const everywhere = Uint8Array.from(first, (layer, i) => (i % 3 === 0 ? hiddenLayer : i % 4 === 0 ? partLayer : layer))
  const content = built(first)
  for (const layers of [picked, everywhere, null, first]) {
    const merged = mergeLevels(structure, choice, layers)
    assert.ok(content.relayers(structure, shown, choice, 'auto', shape, merged, content.structureObject))
    const changed = content.relayer(merged, [0, 0, 0], slots)
    assert.ok(changed)
    while (!content.paintedFrom(paint)) content.paintOnward(paint, () => undefined)
    while (content.reachOnward() === null) {
      // a step of the exact reach at a time
    }
    const fresh = built(layers)
    levels.forEach((_, level) => {
      const a = content.levels[level]
      const b = fresh.levels[level]
      assert.ok(a && b)
      assert.deepEqual(a.spans, b.spans, `level ${level}`)
      if (a.blobs && b.blobs) {
        const count = b.blobs.grouping.count
        assert.equal(a.blobs.grouping.count, count)
        assert.deepEqual(a.blobs.grouping.groups.subarray(0, shown.count), b.blobs.grouping.groups.subarray(0, shown.count))
        assert.deepEqual(a.blobs.centers.subarray(0, count * 3), b.blobs.centers.subarray(0, count * 3))
        assert.deepEqual(a.blobs.covariances.subarray(0, count * covarianceSize), b.blobs.covariances.subarray(0, count * covarianceSize))
        assert.deepEqual(a.paint.subarray(0, count * paintSize), b.paint.subarray(0, count * paintSize))
        assert.deepEqual(a.carriers?.subarray(0, count), b.carriers?.subarray(0, count))
        assert.deepEqual(a.parents?.subarray(0, count), b.parents?.subarray(0, count))
      }
    })
    assert.deepEqual(content.levels[0]?.parents?.subarray(0, shown.count), fresh.levels[0]?.parents?.subarray(0, shown.count))
    assert.deepEqual(content.diameters, fresh.diameters)
    assert.equal(content.reach, fresh.reach)
    // A piece one of whose atoms moved is filled again, and its sphere still holds every instance it draws
    if (layers === picked) assert.deepEqual(changed, [1])
    for (let level = 1; level < levels.length; level++) {
      const owned = content.levels[level]
      for (const { piece, i } of instancesOf(content, level)) {
        if (!owned?.blobs) continue
        const at = piece * sphereSize
        const { centers, covariances } = owned.blobs
        const reach = Math.hypot(centers[i * 3] - content.spheres[at], centers[i * 3 + 1] - content.spheres[at + 1], centers[i * 3 + 2] - content.spheres[at + 2]) + ellipsoidExtent(covariances, i * covarianceSize)
        assert.ok(reach <= content.spheres[at + 3], `level ${level} instance ${i} of piece ${piece}`)
      }
    }
  }
})
