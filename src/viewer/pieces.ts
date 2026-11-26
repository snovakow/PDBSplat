// The pieces an entry is drawn, culled and picked by: each of its chains is one, a group of runs, numbered by the
// chain's row plus one, so that 0 is no piece. Each piece has a sphere that holds everything it draws at any level, a
// texel in the piece table that says whether it's drawn at each level, and the stretches of each level's instances it
// owns, which its pool slots are filled from
import { DataArrayTexture, FloatType, NearestFilter, RGBAFormat, type Ray } from 'three'
import type { ShownAtoms, Structure } from '../pdb/structure.ts'
import { ellipsoidExtent, noPiece } from './ellipsoidGeometry.ts'
import type { EllipsoidHit } from './rayEllipsoids.ts'

// How many pieces an entry has: one for each chain, and the one that's no piece
export function pieceCount(structure: Structure) {
  return structure.chains.count + 1
}

// A level's instances, piece by piece: the stretches of the level's own list of instances that each piece owns
export interface PieceSpans {
  // Where each piece's stretches start among them, with the stretch count after the last piece
  first: Uint32Array
  // Each stretch's first instance, and the one after its last
  start: Uint32Array
  end: Uint32Array
  // How many instances each piece owns
  sizes: Uint32Array
}

// The spans of no pieces, which content has before anything has arrived
export const noPieces: PieceSpans = {
  first: new Uint32Array(1),
  start: new Uint32Array(0),
  end: new Uint32Array(0),
  sizes: new Uint32Array(0),
}

// Builds spans piece by piece, each new stretch joining the piece's last one where the two overlap or touch
class SpanBuilder {
  private readonly first: Uint32Array
  private readonly sizes: Uint32Array
  private readonly start: number[] = []
  private readonly end: number[] = []
  private piece = 0

  constructor(count: number) {
    this.first = new Uint32Array(count + 1)
    this.sizes = new Uint32Array(count)
  }

  // Opens the next piece, which takes the stretches added until the one after it opens
  open(piece: number) {
    while (this.piece < piece) this.first[++this.piece] = this.start.length
  }

  add(start: number, end: number) {
    if (end <= start) return
    const last = this.start.length - 1
    if (last >= this.first[this.piece] && start <= this.end[last]) {
      if (end > this.end[last]) {
        this.sizes[this.piece] += end - this.end[last]
        this.end[last] = end
      }
      return
    }
    this.start.push(start)
    this.end.push(end)
    this.sizes[this.piece] += end - start
  }

  finish(): PieceSpans {
    this.open(this.sizes.length)
    return { first: this.first, start: Uint32Array.from(this.start), end: Uint32Array.from(this.end), sizes: this.sizes }
  }
}

// The first place in a sorted list holding a value at or above a bound
export function lowerBound(sorted: Uint32Array, bound: number) {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle] < bound) low = middle + 1
    else high = middle
  }
  return low
}

// The shown atoms, piece by piece: for each of a chain's runs, the stretch of the shown list that falls in it. The
// shown list holds the atoms in the file's order, as a run's atoms are, so each run's shown atoms are one stretch of it
export function atomSpans(structure: Structure, shown: ShownAtoms): PieceSpans {
  const { chains, runs } = structure
  const builder = new SpanBuilder(pieceCount(structure))
  const rows = shown.rows.subarray(0, shown.count)
  for (let chain = 0; chain < chains.count; chain++) {
    builder.open(chain + 1)
    for (let k = chains.firstRun[chain]; k < chains.firstRun[chain + 1]; k++) {
      const run = chains.runs[k]
      builder.add(lowerBound(rows, runs.firstAtom[run]), lowerBound(rows, runs.firstAtom[run + 1]))
    }
  }
  return builder.finish()
}

// A merged level's groups, piece by piece, from the shown atoms' spans and each shown atom's group. The groups are
// numbered in the order the shown list first reaches them, so the groups of a stretch of it are themselves a stretch,
// and a chain's runs, which share their chain's one blob, make one stretch of a single group
export function groupSpans(atoms: PieceSpans, groups: Uint32Array): PieceSpans {
  const builder = new SpanBuilder(atoms.sizes.length)
  for (let piece = 0; piece < atoms.sizes.length; piece++) {
    builder.open(piece)
    for (let s = atoms.first[piece]; s < atoms.first[piece + 1]; s++) {
      builder.add(groups[atoms.start[s]], groups[atoms.end[s] - 1] + 1)
    }
  }
  return builder.finish()
}

// What a level draws, for its piece's sphere: its spans, and its instances' centres and covariances
export interface DrawnInstances {
  spans: PieceSpans
  centers: Float32Array
  covariances: Float32Array
}

// A level as its piece's sphere reads it: its spans, and each instance's centre and how far its ellipsoid reaches
// from it, which a level whose instances' shapes aren't kept works out as it's asked
export interface DrawnLevel {
  spans: PieceSpans
  centreOf: (instance: number, centre: Float64Array) => void
  extentOf: (instance: number) => number
}

// A level whose centres and covariances are kept, as its sphere reads it
export function keptLevel({ spans, centers, covariances }: DrawnInstances): DrawnLevel {
  return {
    spans,
    centreOf: (i, centre) => {
      centre[0] = centers[i * 3]
      centre[1] = centers[i * 3 + 1]
      centre[2] = centers[i * 3 + 2]
    },
    extentOf: (i) => ellipsoidExtent(covariances, i * 6),
  }
}

// The floats of a sphere: its centre's x, y and z, and its radius
export const sphereSize = 4

// How much a sphere's radius is padded by, as a share of it and in ångströms, so that rounding never leaves a surface
// that touches the sphere just outside it, for the cull or the pick
const sphereSlack = 1e-6

// An instance's centre, as a sphere reads it
const centre = new Float64Array(3)

// Writes the sphere around a piece, in the structure's own space, into the spheres at its place: about the middle of
// the box around its first level's centres, out to the farthest any instance of any level given reaches from it, or a
// radius below 0 for a piece that draws nothing
export function pieceSphere(drawn: readonly DrawnLevel[], piece: number, spheres: Float64Array) {
  const at = piece * sphereSize
  const { spans } = drawn[0]
  if (spans.sizes[piece] === 0) {
    spheres[at + 3] = -1
    return
  }
  let lowX = Infinity
  let lowY = Infinity
  let lowZ = Infinity
  let highX = -Infinity
  let highY = -Infinity
  let highZ = -Infinity
  for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
    for (let i = spans.start[s]; i < spans.end[s]; i++) {
      drawn[0].centreOf(i, centre)
      lowX = Math.min(lowX, centre[0])
      lowY = Math.min(lowY, centre[1])
      lowZ = Math.min(lowZ, centre[2])
      highX = Math.max(highX, centre[0])
      highY = Math.max(highY, centre[1])
      highZ = Math.max(highZ, centre[2])
    }
  }
  spheres[at] = (lowX + highX) / 2
  spheres[at + 1] = (lowY + highY) / 2
  spheres[at + 2] = (lowZ + highZ) / 2
  let radius = 0
  for (const level of drawn) {
    const owned = level.spans
    for (let s = owned.first[piece]; s < owned.first[piece + 1]; s++) {
      for (let i = owned.start[s]; i < owned.end[s]; i++) {
        level.centreOf(i, centre)
        const x = centre[0] - spheres[at]
        const y = centre[1] - spheres[at + 1]
        const z = centre[2] - spheres[at + 2]
        radius = Math.max(radius, Math.hypot(x, y, z) + level.extentOf(i))
      }
    }
  }
  spheres[at + 3] = radius * (1 + sphereSlack) + sphereSlack
}

// The spheres around every piece, each as pieceSphere writes it, from levels whose centres and covariances are kept
export function pieceSpheres(drawn: readonly DrawnInstances[]): Float64Array {
  const count = drawn[0].spans.sizes.length
  const spheres = new Float64Array(count * sphereSize)
  const levels = drawn.map(keptLevel)
  for (let piece = 0; piece < count; piece++) pieceSphere(levels, piece, spheres)
  return spheres
}

// How far from a point anything a piece draws reaches, at most: the farthest any piece's sphere does
export function spheresReach(spheres: Float64Array, count: number, x: number, y: number, z: number) {
  let reach = 0
  for (let piece = noPiece + 1; piece < count; piece++) {
    const at = piece * sphereSize
    if (spheres[at + 3] < 0) continue
    reach = Math.max(reach, Math.hypot(spheres[at] - x, spheres[at + 1] - y, spheres[at + 2] - z) + spheres[at + 3])
  }
  return reach
}

// How far past the view's edges a piece is still taken as in view, as a share of the view's half-width and
// half-height, so that a piece the view turns towards is filled before it reaches the edge. It also covers the pixel
// or so the vertex stage widens every ellipsoid by, which is a far smaller angle
export const viewMargin = 0.2

// The floats of the view's four side planes: each plane's normal, of unit length and pointing into the view, and its
// offset, so that a point lies inside where the normal's dot with it plus the offset isn't below 0
export const planesSize = 16

// Writes the planes of the view's left, right, bottom and top sides, each widened by a margin, in the space a matrix
// takes into clip space, given as three's column-major elements. A point is in view where its clip x and y lie
// within ±w, and within ±(1 + margin)w inside the widened sides. The near and far planes are left out: a piece the
// near plane cuts may still be partly drawn, and the sides alone already leave out what's behind the camera
export function sidePlanes(clip: ArrayLike<number>, margin: number, target: Float64Array) {
  const row = (i: number, k: number) => clip[k * 4 + i]
  const widen = 1 + margin
  for (let side = 0; side < 4; side++) {
    // x then y, each with its low side first, whose sign takes the axis's own row
    const axis = side >> 1
    const sign = side & 1 ? -1 : 1
    let length = 0
    for (let k = 0; k < 4; k++) {
      const value = widen * row(3, k) + sign * row(axis, k)
      target[side * 4 + k] = value
      if (k < 3) length += value * value
    }
    length = Math.sqrt(length)
    for (let k = 0; k < 4; k++) target[side * 4 + k] /= length
  }
}

// Whether a sphere lies at all within the side planes
export function sphereInView(planes: Float64Array, x: number, y: number, z: number, radius: number) {
  for (let side = 0; side < 4; side++) {
    const at = side * 4
    if (planes[at] * x + planes[at + 1] * y + planes[at + 2] * z + planes[at + 3] < -radius) return false
  }
  return true
}

// The piece table the vertex stage reads: a texel per piece, a channel per level, whose value below 0 hides the
// piece's instances at that level and whose value at 0 or above draws them. It's a stack of square layers, so that a
// change sends again only the layers it touched
export const tableSide = 64
export const texelsPerLayer = tableSide * tableSide
export const hiddenTexel = -1
export const shownTexel = 0
// The channels of a texel, of which the levels take the first three and the last stays hidden
const texelSize = 4

export class PieceTable {
  readonly texture: DataArrayTexture
  readonly values: Float32Array
  // How many pieces it has a texel for
  readonly capacity: number
  // Whether the texture has been sent whole once, before which a change of some layers alone would send only those
  // and leave the rest unset on the GPU
  private sent = false
  private changed = false

  // A table for a count of pieces, all hidden, or holding the values of a smaller one it takes the place of
  constructor(count: number, from?: PieceTable) {
    const layers = Math.max(1, Math.ceil(count / texelsPerLayer))
    this.capacity = layers * texelsPerLayer
    this.values = new Float32Array(layers * texelsPerLayer * texelSize).fill(hiddenTexel)
    if (from) this.values.set(from.values)
    // The values are read by texel, so they take no filtering and no mipmaps
    const texture = new DataArrayTexture(this.values, tableSide, tableSide, layers)
    texture.format = RGBAFormat
    texture.type = FloatType
    texture.minFilter = NearestFilter
    texture.magFilter = NearestFilter
    texture.generateMipmaps = false
    texture.onUpdate = () => {
      this.sent = true
    }
    texture.needsUpdate = true
    this.texture = texture
  }

  // Sets a piece's value at a level, and marks its layer to be sent where that changes it
  set(piece: number, level: number, value: number) {
    const at = piece * texelSize + level
    if (this.values[at] === value) return
    this.values[at] = value
    this.changed = true
    if (this.sent) this.texture.addLayerUpdate(Math.floor(piece / texelsPerLayer))
  }

  // Has the GPU's copy take the changes since the last time
  send() {
    if (!this.changed) return
    this.changed = false
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
  }
}

// The pieces a ray passes through, by their spheres: each one's piece and how far along the ray it's entered, nearest
// first, kept in arrays made once for an entry's pieces
export class PieceWalk {
  readonly pieces: Uint32Array
  readonly entries: Float64Array
  count = 0

  constructor(count: number) {
    this.pieces = new Uint32Array(count)
    this.entries = new Float64Array(count)
  }
}

// Writes into hit the instance a ray meets first among the pieces, testing only the pieces whose spheres it passes
// through beyond the cut, nearest entry first, and stopping once the next one's entry lies beyond the best hit. Each
// piece's test writes its own nearer hit, and takes the lower index where two lie at the same distance, as a walk of
// every instance in order does, so the hit is the one that walk finds. The ray's direction has unit length
export function pickByPieces(
  ray: Ray,
  spheres: Float64Array,
  cut: number,
  walk: PieceWalk,
  hit: EllipsoidHit,
  test: (piece: number) => void,
) {
  const { origin, direction } = ray
  hit.index = -1
  hit.distance = Infinity
  walk.count = 0
  for (let piece = noPiece + 1; piece < walk.pieces.length; piece++) {
    const at = piece * sphereSize
    const radius = spheres[at + 3]
    if (radius < 0) continue
    const x = origin.x - spheres[at]
    const y = origin.y - spheres[at + 1]
    const z = origin.z - spheres[at + 2]
    const along = -(x * direction.x + y * direction.y + z * direction.z)
    const missSquared = x * x + y * y + z * z - along * along
    if (missSquared > radius * radius) continue
    const half = Math.sqrt(radius * radius - missSquared)
    if (along + half < cut) continue
    // Kept sorted by entry as it's built: the pieces a ray meets are few
    const entry = Math.max(along - half, cut)
    let k = walk.count++
    while (k > 0 && walk.entries[k - 1] > entry) {
      walk.entries[k] = walk.entries[k - 1]
      walk.pieces[k] = walk.pieces[k - 1]
      k--
    }
    walk.entries[k] = entry
    walk.pieces[k] = piece
  }
  for (let k = 0; k < walk.count; k++) {
    if (walk.entries[k] > hit.distance) break
    test(walk.pieces[k])
  }
}
