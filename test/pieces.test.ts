import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, PerspectiveCamera, Quaternion, Ray, Vector3, Vector4 } from 'three'
import { hiddenLayer, partLayer, wholeLayer } from '../src/pdb/merge.ts'
import { chainOf, selectAtoms, StructureBuilder, type AtomRecord, type ShownAtoms, type Structure } from '../src/pdb/structure.ts'
import { surfaceDeviations } from '../src/viewer/ellipsoidGeometry.ts'
import { levelGroups, noGroup } from '../src/viewer/levels.ts'
import {
  atomSpans,
  chainSpans,
  hiddenTexel,
  pickByPieces,
  pieceCount,
  pieceSpheres,
  PieceTable,
  PieceWalk,
  planesSize,
  residueSpans,
  sidePlanes,
  sphereInView,
  sphereSize,
  texelsPerLayer,
  viewMargin,
  type PieceSpans,
} from '../src/viewer/pieces.ts'
import {
  ellipsoidEntry,
  invertCovariances,
  nearestEllipsoid,
  type EllipsoidHit,
} from '../src/viewer/rayEllipsoids.ts'

// The pieces an entry is drawn, culled and picked by: each chain's stretches of each level, a sphere around all it
// draws, the test of a sphere against the view, the pick that walks the pieces a ray passes through, and the table
// that says whether each piece is drawn at each level

// A seeded generator of numbers from 0 to 1, so that the random scenes are the same on every run
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A piece's stretches as [start, end] pairs
function stretchesOf(spans: PieceSpans, piece: number) {
  const out: number[][] = []
  for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) out.push([spans.start[s], spans.end[s]])
  return out
}

// A structure whose chain A has a heme after chain B, as haemoglobin's do, and a second model
function hemeStructure() {
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
    { labelChain: 'C', residueName: 'HEM', residueNumber: 142, polymer: false },
    { model: 2 },
    { model: 2, residueNumber: 2 },
  ]
  for (const changes of atoms) builder.add({ ...base, ...changes })
  return builder.finish()
}

void test("each chain is a piece, owning its runs' stretches of the shown atoms and of each merged level", () => {
  const structure = hemeStructure()
  assert.equal(pieceCount(structure), 4)
  // Every atom but the first: shown atom i is the structure's atom i + 1
  const shown = selectAtoms(structure, (atom) => atom > 0)
  const atoms = atomSpans(structure, shown)
  assert.deepEqual(stretchesOf(atoms, 0), [])
  // Chain A's residues, and its heme, which comes after chain B
  assert.deepEqual(stretchesOf(atoms, 1), [
    [0, 2],
    [3, 4],
  ])
  assert.deepEqual(stretchesOf(atoms, 2), [[2, 3]])
  assert.deepEqual(stretchesOf(atoms, 3), [[4, 6]])
  assert.deepEqual([...atoms.sizes], [0, 3, 1, 2])
  // One residue blob for each residue, as stretches of the residues' own list
  const residues = mergedSpans(structure, shown, 'residues', null)
  assert.deepEqual(stretchesOf(residues, 1), [
    [0, 2],
    [3, 4],
  ])
  assert.deepEqual([...residues.sizes], [0, 3, 1, 2])
  // A chain's runs share its one blob, which is one stretch of a single group
  const chains = mergedSpans(structure, shown, 'chains', null)
  assert.deepEqual(stretchesOf(chains, 1), [[0, 1]])
  assert.deepEqual(stretchesOf(chains, 2), [[1, 2]])
  assert.deepEqual(stretchesOf(chains, 3), [[2, 3]])
  assert.deepEqual([...chains.sizes], [0, 1, 1, 1])
  // A chain with no atom shown owns nothing
  const none = atomSpans(structure, selectAtoms(structure, (atom) => atom !== 3))
  assert.deepEqual([...none.sizes], [0, 4, 0, 2])
})

// A merged level's spans as the content makes them, from the shown atoms' groups by the layers given: each residue's
// first blob and how many it has, and each chain's blob in each layer
function mergedSpans(structure: Structure, shown: ShownAtoms, level: 'residues' | 'chains', layers: Uint8Array | null) {
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

void test("drawn by layer, a residue's and a chain's blobs in each layer are its piece's, and a hidden atom's in none", () => {
  const structure = hemeStructure()
  const shown = selectAtoms(structure, () => true)
  // Atoms 0 and 1 are chain A's first residue, 2 its second, 3 chain B's, 4 chain A's heme and 5 and 6 the second
  // model's: the first residue in part and whole, the heme in part, and the second model's first atom hidden
  const layers = new Uint8Array([partLayer, wholeLayer, wholeLayer, wholeLayer, partLayer, hiddenLayer, wholeLayer])
  const residues = mergedSpans(structure, shown, 'residues', layers)
  // Chain A: its first residue's two blobs and its second's one, then its heme's, after chain B's
  assert.deepEqual(stretchesOf(residues, 1), [
    [0, 3],
    [4, 5],
  ])
  assert.deepEqual(stretchesOf(residues, 2), [[3, 4]])
  // The second model's hidden atom's residue has no blob
  assert.deepEqual(stretchesOf(residues, 3), [[5, 6]])
  assert.deepEqual([...residues.sizes], [0, 4, 1, 1])
  // Chain A has a blob whole and one in part, numbered as their first residues come, the whole one first
  const chains = mergedSpans(structure, shown, 'chains', layers)
  assert.deepEqual(stretchesOf(chains, 1), [[0, 2]])
  assert.deepEqual(stretchesOf(chains, 2), [[2, 3]])
  assert.deepEqual(stretchesOf(chains, 3), [[3, 4]])
  const { groups } = levelGroups(structure, shown, 'residues', layers)
  assert.deepEqual([...groups], [1, 0, 2, 3, 4, noGroup, 5])
})

// Random ellipsoids in a box, each a random rotation of a random diagonal covariance
function randomEllipsoids(next: () => number, count: number, size: number) {
  const centers = new Float32Array(count * 3)
  const covariances = new Float32Array(count * 6)
  const rotation = new Matrix4()
  const axis = new Vector3()
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) centers[i * 3 + k] = (next() - 0.5) * size
    axis.set(next() - 0.5, next() - 0.5, next() - 0.5).normalize()
    rotation.makeRotationAxis(axis, next() * Math.PI)
    const e = rotation.elements
    const variances = [0.2 + next() * 2, 0.2 + next() * 2, 0.2 + next() * 2]
    // R D Rᵀ, from the rotation's columns
    const entry = (r: number, c: number) => {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += e[k * 4 + r] * variances[k] * e[k * 4 + c]
      return sum
    }
    covariances.set([entry(0, 0), entry(0, 1), entry(0, 2), entry(1, 1), entry(1, 2), entry(2, 2)], i * 6)
  }
  return { centers, covariances }
}

// Pieces that each own two stretches of a list, dealt out in a shuffled order, as a chain's polymer and its ligands
// lie apart in a file
function dealtSpans(next: () => number, count: number, pieces: number): PieceSpans {
  const chunks = pieces * 2
  const bounds = Array.from({ length: chunks + 1 }, (_, k) => Math.round((k * count) / chunks))
  const owner = Array.from({ length: chunks }, (_, k) => 1 + (k % pieces))
  for (let k = owner.length - 1; k > 0; k--) {
    const j = Math.floor(next() * (k + 1))
    ;[owner[k], owner[j]] = [owner[j], owner[k]]
  }
  const first = new Uint32Array(pieces + 2)
  const start: number[] = []
  const end: number[] = []
  const sizes = new Uint32Array(pieces + 1)
  for (let piece = 0; piece <= pieces; piece++) {
    first[piece] = start.length
    for (let k = 0; k < chunks; k++) {
      if (owner[k] !== piece || bounds[k + 1] === bounds[k]) continue
      start.push(bounds[k])
      end.push(bounds[k + 1])
      sizes[piece] += bounds[k + 1] - bounds[k]
    }
  }
  first[pieces + 1] = start.length
  return { first, start: Uint32Array.from(start), end: Uint32Array.from(end), sizes }
}

void test("a piece's sphere holds every ellipsoid it owns at every level, and an empty piece has none", () => {
  const next = random(7)
  const atoms = randomEllipsoids(next, 300, 40)
  const blobs = randomEllipsoids(next, 30, 40)
  const atomSpansDealt = dealtSpans(next, 300, 6)
  const blobSpans = dealtSpans(next, 30, 6)
  const spheres = pieceSpheres([
    { spans: atomSpansDealt, ...atoms },
    { spans: blobSpans, ...blobs },
  ])
  assert.equal(spheres[3], -1)
  // Every point of each ellipsoid's surface along a sweep of directions lies within its piece's sphere
  const check = (spans: PieceSpans, { centers, covariances }: ReturnType<typeof randomEllipsoids>) => {
    for (let piece = 1; piece < spans.sizes.length; piece++) {
      const at = piece * sphereSize
      for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
        for (let i = spans.start[s]; i < spans.end[s]; i++) {
          const [xx, xy, xz, yy, yz, zz] = covariances.subarray(i * 6, i * 6 + 6)
          for (let j = 0; j < 200; j++) {
            const u = new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize()
            // The surface's farthest point along u lies at Σu over the root of uᵀΣu, two deviations out
            const sigma = new Vector3(
              xx * u.x + xy * u.y + xz * u.z,
              xy * u.x + yy * u.y + yz * u.z,
              xz * u.x + yz * u.y + zz * u.z,
            )
            const point = sigma.multiplyScalar(surfaceDeviations / Math.sqrt(u.dot(sigma)))
            point.add(new Vector3(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]))
            const distance = point.distanceTo(new Vector3(spheres[at], spheres[at + 1], spheres[at + 2]))
            assert.ok(distance <= spheres[at + 3], `piece ${piece}, ellipsoid ${i}: ${distance} > ${spheres[at + 3]}`)
          }
        }
      }
    }
  }
  check(atomSpansDealt, atoms)
  check(blobSpans, blobs)
})

void test('the view test never culls a sphere with a point in view, and culls one wholly outside the margin', () => {
  const next = random(11)
  const camera = new PerspectiveCamera()
  const object = new Matrix4()
  const clip = new Matrix4()
  const planes = new Float64Array(planesSize)
  const point = new Vector4()
  let culled = 0
  let total = 0
  for (let view = 0; view < 40; view++) {
    camera.fov = 20 + next() * 70
    camera.aspect = 0.5 + next() * 2
    camera.near = 0.1
    camera.far = 1000
    camera.updateProjectionMatrix()
    camera.position.set((next() - 0.5) * 200, (next() - 0.5) * 200, (next() - 0.5) * 200)
    camera.lookAt((next() - 0.5) * 50, (next() - 0.5) * 50, (next() - 0.5) * 50)
    camera.updateMatrixWorld()
    // The structure's object, placed by a rigid matrix, as the planes are taken into its own space
    const turn = new Quaternion().setFromAxisAngle(new Vector3(next(), next(), next()).normalize(), next() * 6)
    object.compose(new Vector3((next() - 0.5) * 30, (next() - 0.5) * 30, 0), turn, new Vector3(1, 1, 1))
    clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(object)
    sidePlanes(clip.elements, viewMargin, planes)
    for (let s = 0; s < 200; s++) {
      const centre = new Vector3((next() - 0.5) * 300, (next() - 0.5) * 300, (next() - 0.5) * 300)
      const radius = next() * 20
      const kept = sphereInView(planes, centre.x, centre.y, centre.z, radius)
      total++
      if (!kept) culled++
      // Its centre, its six extremes along the axes and points within it, each projected as the GPU does
      const samples = [new Vector3()]
      for (let k = 0; k < 3; k++) {
        samples.push(new Vector3().setComponent(k, radius), new Vector3().setComponent(k, -radius))
      }
      for (let k = 0; k < 60; k++) {
        const direction = new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize()
        samples.push(direction.multiplyScalar(radius * Math.cbrt(next())))
      }
      for (const sample of samples) {
        point.set(centre.x + sample.x, centre.y + sample.y, centre.z + sample.z, 1).applyMatrix4(clip)
        const inView = point.w > 0 && Math.abs(point.x) <= point.w && Math.abs(point.y) <= point.w
        if (inView) assert.ok(kept, `view ${view}, sphere ${s} has a point in view and was culled`)
      }
    }
  }
  // Most random spheres lie out of a random view
  assert.ok(culled > total / 2, `${culled} of ${total} culled`)

  // Looking down −z with a right angle across, each side at 45°: a sphere just past the right edge is kept within the
  // margin, and one well past it isn't, nor one behind the camera
  camera.fov = 90
  camera.aspect = 1
  camera.position.set(0, 0, 0)
  camera.lookAt(0, 0, -1)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  sidePlanes(clip.elements, viewMargin, planes)
  assert.equal(sphereInView(planes, 10 * (1 + viewMargin / 2), 0, -10, 0.01), true)
  assert.equal(sphereInView(planes, 10 * (1 + 2 * viewMargin), 0, -10, 0.01), false)
  assert.equal(sphereInView(planes, 0, 0, 10, 1), false)
  // A sphere around the camera is kept
  assert.equal(sphereInView(planes, 0, 0, 1, 2), true)
})

void test('the pick by pieces finds the ellipsoid a walk of every one finds, a cut among the scenes', () => {
  const next = random(23)
  // How many rays hit, and how many of those met two ellipsoids at the same distance
  let hits = 0
  let ties = 0
  for (let scene = 0; scene < 30; scene++) {
    const count = 120
    const { centers, covariances } = randomEllipsoids(next, count, 30)
    // A few ellipsoids repeated exactly, in other pieces, so that a ray meets two at the same distance
    for (let k = 0; k < 5; k++) {
      const from = Math.floor(next() * count)
      const to = Math.floor(next() * count)
      centers.copyWithin(to * 3, from * 3, from * 3 + 3)
      covariances.copyWithin(to * 6, from * 6, from * 6 + 6)
    }
    const inverses = invertCovariances(covariances)
    const spans = dealtSpans(next, count, 8)
    const spheres = pieceSpheres([{ spans, centers, covariances }])
    // Every seventh is too faint to pick
    const accepts = (index: number) => index % 7 !== 3
    const walk = new PieceWalk(spans.sizes.length)
    const full: EllipsoidHit = { index: -1, distance: Infinity }
    const byPieces: EllipsoidHit = { index: -1, distance: Infinity }
    for (let r = 0; r < 60; r++) {
      const origin = new Vector3((next() - 0.5) * 120, (next() - 0.5) * 120, (next() - 0.5) * 120)
      const target = new Vector3((next() - 0.5) * 30, (next() - 0.5) * 30, (next() - 0.5) * 30)
      const ray = new Ray(origin, target.sub(origin).normalize())
      const cut = r % 2 === 0 ? 0 : origin.length() - 15 + next() * 30
      nearestEllipsoid(ray, centers, inverses, cut, full, accepts)
      pickByPieces(ray, spheres, cut, walk, byPieces, (piece) => {
        for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
          for (let i = spans.start[s]; i < spans.end[s]; i++) {
            const distance = ellipsoidEntry(ray, centers, i * 3, inverses, i * 6, cut)
            if (distance > byPieces.distance || (distance === byPieces.distance && i > byPieces.index)) continue
            if (!accepts(i)) continue
            byPieces.index = i
            byPieces.distance = distance
          }
        }
      })
      assert.equal(byPieces.index, full.index, `scene ${scene}, ray ${r}`)
      assert.equal(byPieces.distance, full.distance, `scene ${scene}, ray ${r}`)
      if (full.index < 0) continue
      hits++
      for (let i = full.index + 1; i < count; i++) {
        if (accepts(i) && ellipsoidEntry(ray, centers, i * 3, inverses, i * 6, cut) === full.distance) ties++
      }
    }
  }
  assert.ok(hits > 600, `${hits} hits`)
  assert.ok(ties > 20, `${ties} ties`)
})

void test('the piece table starts hidden, sends itself whole once, and then only the layers a change touches', () => {
  const table = new PieceTable(texelsPerLayer + 10)
  const { texture, values } = table
  assert.equal(texture.image.depth, 2)
  assert.ok(values.every((value) => value === hiddenTexel))
  const version = texture.version
  // Before the first upload a change marks no layer, so the first upload sends every layer
  table.set(texelsPerLayer + 3, 1, 0)
  assert.equal(values[(texelsPerLayer + 3) * 4 + 1], 0)
  assert.equal(texture.layerUpdates.size, 0)
  table.send()
  assert.equal(texture.version, version + 1)
  texture.onUpdate?.(texture)
  // An unchanged value sends nothing
  table.set(texelsPerLayer + 3, 1, 0)
  table.send()
  assert.equal(texture.version, version + 1)
  // A change marks its piece's layer alone
  table.set(texelsPerLayer + 3, 2, 0)
  table.send()
  assert.deepEqual([...texture.layerUpdates], [1])
  assert.equal(texture.version, version + 2)
  texture.clearLayerUpdates()
  table.set(5, 0, 0)
  table.send()
  assert.deepEqual([...texture.layerUpdates], [0])
})
