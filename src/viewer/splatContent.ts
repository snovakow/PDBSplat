// What the splats draw an entry as while its shown atoms and their shapes stand: each shown atom's ellipsoid, the
// blobs of the merged levels Detail builds, each piece's spans and sphere, each level's typical size, the paint, and
// the pick. It's built a batch at a time as an entry arrives, each batch's atoms, residues and chains added after the
// ones before, which nothing a batch adds ever changes but the blob of a chain it adds to, so that each batch costs
// what it brings and the pieces it touches, and an entry that arrives whole is built in one batch alike
import { Ray, type Object3D } from 'three'
import type { Detail } from '../options.ts'
import type { MergedLevels } from '../pdb/merge.ts'
import { chainOf, roomToGrow, sameChoice, type ShownAtoms, type ShownChoice, type Structure } from '../pdb/structure.ts'
import type { PickTest } from '../store.ts'
import { isPickable, paintAtoms, paintMergedRange, type TablePaint } from './atomTable.ts'
import { covarianceSize, ellipsoidExtent, paintSize, surfaceDeviations } from './ellipsoidGeometry.ts'
import { writeAtomShape, type AtomShape } from './ellipsoids.ts'
import { drawnDiameter, levels, medianOf, type Grouping, type Level } from './levels.ts'
import { cutAlong } from './nearPlane.ts'
import {
  atomSpans,
  groupSpans,
  keptLevel,
  noPieces,
  pickByPieces,
  pieceCount,
  pieceSphere,
  PieceWalk,
  sphereSize,
  spheresReach,
  type DrawnLevel,
  type PieceSpans,
} from './pieces.ts'
import { rayInto } from './placement.ts'
import { ellipsoidEntry, invertCovariance, type EllipsoidHit } from './rayEllipsoids.ts'

// The most instances a level's pool holds, though an entry's pool holds no more than the entry's own atoms, residues
// or chains. The atoms' holds the 4,527,463 atoms of the bovine sperm axoneme, the most any entry draws as atoms, and
// the residues' as many; their shapes stay under the 256 MiB a WebGPU buffer takes by default, with room for a wider
// slot. On a 2014 Mac mini's Intel Iris, in Chrome, that entry drew whole from its atoms' pool on both backends, if at
// a frame every fourteen seconds. The chains' holds every chain, so that some level always fits
export const poolCapacity: Record<Level, number> = { atoms: 5_000_000, residues: 5_000_000, chains: Infinity }

// How much more than an entry still arriving is expected to hold at a level its pool is made for, as the expectation
// is an estimate until the rest has come
const arrivingMargin = 1.1

// A count of a structure's so far as it's expected to stand once the structure is whole: the count itself once it is,
// and while it arrives, the count in the share the atoms so far are of the atoms expected
function expectedOf(structure: Structure, count: number) {
  const { arrival, whole, atoms } = structure
  if (whole || !arrival) return count
  return Math.ceil(count * Math.max(1, arrival.expectedAtoms / Math.max(atoms.count, 1)))
}

// How many instances an entry has at a level, at most, or is expected to have once it has all arrived
export function entryCount(structure: Structure, level: Level) {
  const count =
    level === 'atoms' ? structure.atoms.count : level === 'residues' ? structure.residues.count : structure.chains.count
  return expectedOf(structure, count)
}

// How many slots an entry's pool at a level is made with: as many as its instances, or as an entry still arriving is
// expected to have with a margin, up to the level's capacity
export function poolSize(structure: Structure, level: Level) {
  const count = entryCount(structure, level)
  return Math.max(1, Math.min(poolCapacity[level], structure.whole ? count : Math.ceil(count * arrivingMargin)))
}

// Which levels' instances, as the shown atoms and the blobs last merged count them, or as they're expected to once the
// entry has all arrived, fit their pools: the atoms shown, the residues' blobs, and the chains, which always do. A
// level that doesn't fit isn't drawn, so no pool is made for it. Each is 1 or 0, in the levels' order, as one key that
// changes only as a level comes to fit or stops
export function fittingLevels(shownCount: number, merged: MergedLevels | null, structure: Structure) {
  const residues = merged?.residues.count ?? structure.residues.count
  return [expectedOf(structure, shownCount) <= poolCapacity.atoms, expectedOf(structure, residues) <= poolCapacity.residues, true]
    .map(Number)
    .join('')
}

// The levels Detail builds for an entry: every level under auto, and otherwise the one it asks for, followed by the
// coarser ones as far as the first whose pool holds all of the entry's, so that one level always fits
export function builtLevels(detail: Detail, structure: Structure): readonly Level[] {
  if (detail === 'auto') return levels
  const built: Level[] = []
  for (let index = levels.indexOf(detail); index < levels.length; index++) {
    built.push(levels[index])
    if (entryCount(structure, levels[index]) <= poolCapacity[levels[index]]) break
  }
  return built
}

// Whether Detail builds a merged level for an entry, whose blobs the loader merges
export function buildsMerged(detail: Detail, structure: Structure) {
  return builtLevels(detail, structure).some((level) => level !== 'atoms')
}

// A level as its pool is filled from it: the instances each piece owns, a merged level's blobs with its members'
// groups, the paint of each instance, and whether all of them fit the pool, without which the level isn't drawn. A
// merged level's columns have room for the blobs to come, and hold as many as its grouping counts
export interface LevelContent {
  spans: PieceSpans
  blobs: { centers: Float32Array; covariances: Float32Array; grouping: Grouping } | null
  paint: Uint8ClampedArray
  offered: boolean
}

// How many shown atoms a step of the paint takes at most, about a fiftieth of a second's work on a 2014 Mac mini, so
// that a giant's repaint, such as its burial landing, is spread over frames, and an example's is done at once
export const paintStep = 1 << 18

// How many of a level's instances its typical size is taken from at most, evenly spaced among them: every one of a
// level of up to 65,536, as every example's are, and while the entry arrives fewer, taken again only as the count grows
// by a margin, the chains' blobs, which change as they grow, aside, so that neither a batch's cost nor the last's grows
// with all that came before it
const wholeSample = 1 << 16
const arrivingSample = 1 << 12
const arrivingGrowth = 1.25

// How many instances the exact reach works through in a step at most, so that a giant's is spread over frames
const reachStep = 1 << 18

// The colourings whose colours need the whole entry, which an entry still arriving paints without
const wholeColorings = new Set(['bfactor', 'rainbow', 'structure'])

// Whether the paint of a later snapshot of the same entry as it arrives differs from an earlier one's only by the atoms
// it adds, so that only those need painting: the options the same, and the entry's having all arrived changing
// nothing a colouring or a focus waits for
function grownFrom(earlier: TablePaint, later: TablePaint) {
  const { arrival } = later.structure
  if (!arrival || earlier.structure.arrival !== arrival || earlier.structure === later.structure) return false
  const same =
    earlier.colorBy === later.colorBy &&
    earlier.burial === later.burial &&
    earlier.buried === later.buried &&
    earlier.focus === later.focus &&
    earlier.picked === later.picked &&
    earlier.fade === later.fade &&
    earlier.model === later.model &&
    earlier.modelCount === later.modelCount &&
    earlier.conformations === later.conformations &&
    earlier.layered === later.layered
  if (!same) return false
  const waited = wholeColorings.has(later.colorBy) || later.focus === 'ligands'
  return !waited || earlier.structure.whole === later.structure.whole
}

// A column of floats with room for a count, keeping what it held
function roomFor<T extends Float32Array | Float64Array | Uint32Array | Uint8ClampedArray | Int32Array>(
  column: T,
  length: number,
  make: (length: number) => T,
): T {
  if (column.length >= length) return column
  const grown = make(length)
  grown.set(column)
  return grown
}

// The length a growing column takes, as a structure's own columns grow
function grownLength(needed: number, expected: number, had: number) {
  return roomToGrow(needed, expected, had)
}

// An atom's covariance, as each atom is worked out in turn, and an instance's centre
const atomShape = new Float32Array(covarianceSize)
const centreAt = new Float64Array(3)

// How much a widened sphere is padded by, as a share of its radius, so that rounding never leaves an instance outside
const widenSlack = 1e-6

// Widens a piece's sphere to hold each instance of a level it owns from a place in the level's list on, where it
// reaches past it: to the smallest sphere holding both, its centre moved towards the instance
function widenSphere(level: DrawnLevel, piece: number, from: number, spheres: Float64Array) {
  const at = piece * sphereSize
  const { spans } = level
  for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
    for (let i = Math.max(spans.start[s], from); i < spans.end[s]; i++) {
      level.centreOf(i, centreAt)
      const dx = centreAt[0] - spheres[at]
      const dy = centreAt[1] - spheres[at + 1]
      const dz = centreAt[2] - spheres[at + 2]
      const distance = Math.hypot(dx, dy, dz)
      const extent = level.extentOf(i)
      const reach = distance + extent
      const radius = spheres[at + 3]
      if (reach <= radius) continue
      // An instance whose own reach holds the sphere takes its place
      if (extent >= distance + radius) {
        spheres.set([centreAt[0], centreAt[1], centreAt[2], extent * (1 + widenSlack) + widenSlack], at)
        continue
      }
      const grown = (radius + reach) / 2
      const move = distance > 0 ? (grown - radius) / distance : 0
      spheres[at] += dx * move
      spheres[at + 1] += dy * move
      spheres[at + 2] += dz * move
      spheres[at + 3] = grown * (1 + widenSlack) + widenSlack
    }
  }
}

// The work of finding how far from the structure's centre the built levels' instances reach, exactly, a step at a
// time: the pieces in order of how far their spheres reach, each one's instances tested in turn, until the next
// sphere reaches no farther than the farthest instance found
interface ReachWork {
  center: [number, number, number]
  order: number[]
  next: number
  reach: number
}

export class SplatContent {
  // What it was made for, which it keeps: the entry, as every snapshot of it names it, the shown atoms' choice, Detail,
  // the atoms' shape and their elements' radii, and the levels built
  readonly entry: object
  readonly choice: ShownChoice
  readonly detail: Detail
  readonly shape: AtomShape
  readonly radii: number[]
  readonly built: readonly Level[]
  readonly structureObject: Object3D
  // The entry as it has arrived, its shown atoms, and the blobs merged for them
  structure: Structure
  shown: ShownAtoms
  merged: MergedLevels | null = null
  // The shown atoms' spans, which the pick walks at every level, each level's content, each shown atom's weight in its
  // blobs, its van der Waals volume, and its paint, each piece's sphere, each level's typical drawn diameter, which
  // auto switches by, and which levels are offered, as their instances fit their pools
  atoms: PieceSpans = noPieces
  readonly levels: (LevelContent | null)[]
  weights = new Float32Array(0)
  atomPaint = new Uint8ClampedArray(0)
  spheres = new Float64Array(0)
  readonly diameters: number[] = levels.map(() => 0)
  readonly offered: boolean[] = levels.map(() => false)
  // How far from the structure's centre what's drawn reaches: from the pieces' spheres while the entry arrives, and
  // exactly once it has
  reach = 0
  // What it was last painted from, and how many shown atoms are painted from it so far
  painted: TablePaint | null = null
  paintedTo = 0

  // The count each level's typical size was last taken at, and whether it was taken once the entry had all arrived
  private readonly diametersAt: number[] = levels.map(() => 0)
  private readonly diametersExact: boolean[] = levels.map(() => false)
  // Each chain's blob by its row, or -1 before its first shown atom, and each chain blob's weighted sums of its
  // members' covariances and paint so far, with their weights
  private chainBlobs = new Int32Array(0)
  private chainShape = new Float64Array(0)
  private chainShapeWeight = new Float64Array(0)
  private chainPaint = new Float64Array(0)
  private chainPaintWeight = new Float64Array(0)
  private reaching: ReachWork | null = null
  // The levels as the spheres and the reach read them, made again as each batch grows them
  private drawn: DrawnLevel[] | null = null
  // The pick's walk through the pieces, for as many as there are
  private walk = new PieceWalk(0)
  readonly unregister: () => void

  constructor(
    structure: Structure,
    shown: ShownAtoms,
    choice: ShownChoice,
    detail: Detail,
    shape: AtomShape,
    radii: number[],
    structureObject: Object3D,
    register: (pick: PickTest) => () => void,
  ) {
    this.entry = structure.arrival ?? structure
    this.structure = structure
    this.shown = { ...shown, count: 0 }
    this.choice = choice
    this.detail = detail
    this.shape = shape
    this.radii = radii
    this.built = builtLevels(detail, structure)
    this.structureObject = structureObject
    this.levels = levels.map(() => null)
    for (const level of this.built) {
      const blobs = level === 'atoms' ? null : { centers: new Float32Array(0), covariances: new Float32Array(0), grouping: { groups: new Uint32Array(0), count: 0 } }
      this.levels[levels.indexOf(level)] = { spans: noPieces, blobs, paint: new Uint8ClampedArray(0), offered: false }
    }
    this.unregister = register(this.pick(structureObject))
  }

  // Whether it can grow into a later snapshot of its entry with these shown atoms and blobs: the same entry, choice,
  // Detail and shape, placed by the same object, no fewer atoms, and tensors that haven't arrived to change an
  // ellipsoid already drawn
  growsInto(
    structure: Structure,
    choice: ShownChoice,
    detail: Detail,
    shape: AtomShape,
    merged: MergedLevels | null,
    structureObject: Object3D,
  ) {
    const { arrival } = structure
    const tensorsCame = this.shape.ellipsoids && this.structure.tensors !== structure.tensors
    return (
      structureObject === this.structureObject &&
      arrival !== null &&
      arrival === this.entry &&
      sameChoice(choice, this.choice) &&
      detail === this.detail &&
      shape.scale === this.shape.scale &&
      shape.thermal === this.shape.thermal &&
      shape.ellipsoids === this.shape.ellipsoids &&
      !tensorsCame &&
      structure.atoms.count >= this.structure.atoms.count &&
      (!merged || !this.merged || merged.residues.count >= this.merged.residues.count)
    )
  }

  // Takes the atoms a later snapshot of the entry shows after the ones it has, with the blobs merged for them, and
  // gives the pieces whose instances that changed, which their pools take again, or null where the blobs don't match
  // the atoms. The bounds' centre is the one the reach is measured from, and the pools' slots decide what's offered
  grow(
    structure: Structure,
    shown: ShownAtoms,
    merged: MergedLevels | null,
    center: [number, number, number],
    slots: (level: Level) => number,
  ): number[] | null {
    const from = this.shown.count
    const to = shown.count
    const residues = this.levels[1]
    const chains = this.levels[2]
    if ((residues?.blobs || chains?.blobs) && !merged) return null
    const expected = structure.arrival?.expectedAtoms ?? structure.atoms.count
    const { element, residue } = structure.atoms
    const { radii, shape } = this

    this.weights = roomFor(this.weights, to, (length) => new Float32Array(grownLength(length, expected, this.weights.length)))
    this.atomPaint = roomFor(this.atomPaint, to * paintSize, (length) =>
      new Uint8ClampedArray(grownLength(length, expected * paintSize, this.atomPaint.length)),
    )
    // The atoms level is painted with the atoms' own paint
    if (this.levels[0]) this.levels[0].paint = this.atomPaint

    // The residues' blobs of the new atoms each close among them, and are numbered on from the last; the chains' are
    // numbered as their first shown atoms come, and their sums grow
    const residueGroups = residues?.blobs?.grouping
    const chainGroups = chains?.blobs?.grouping
    if (residueGroups) residueGroups.groups = roomFor(residueGroups.groups, to, (length) => new Uint32Array(grownLength(length, expected, 0)))
    if (chainGroups) chainGroups.groups = roomFor(chainGroups.groups, to, (length) => new Uint32Array(grownLength(length, expected, 0)))
    const firstResidueBlob = residueGroups?.count ?? 0
    const newResidues = merged ? merged.residues.count - firstResidueBlob : 0
    const residueSums = new Float64Array(Math.max(newResidues, 0) * covarianceSize)
    const residueWeights = new Float64Array(Math.max(newResidues, 0))
    if (chainGroups) this.roomForChains(structure.chains.count, merged?.chains.count ?? 0)
    let lastResidue = from > 0 ? residue[shown.rows[from - 1]] : -1
    let residueBlob = firstResidueBlob - 1

    for (let i = from; i < to; i++) {
      const atom = shown.rows[i]
      const radius = radii[element[atom]] * shape.scale
      // Each atom's weight as its column holds it, in single precision, as the blobs and their paint are mixed by
      this.weights[i] = radius * radius * radius
      const weight = this.weights[i]
      writeAtomShape(atomShape, 0, structure, atom, radii, shape)
      if (residueGroups) {
        if (residue[atom] !== lastResidue) {
          lastResidue = residue[atom]
          residueBlob++
        }
        residueGroups.groups[i] = residueBlob
        const at = residueBlob - firstResidueBlob
        if (at >= 0 && at < newResidues) {
          residueWeights[at] += weight
          for (let k = 0; k < covarianceSize; k++) residueSums[at * covarianceSize + k] += weight * atomShape[k]
        }
      }
      if (chainGroups) {
        const chain = chainOf(structure, atom)
        let blob = this.chainBlobs[chain]
        if (blob < 0) {
          blob = chainGroups.count++
          this.chainBlobs[chain] = blob
        }
        chainGroups.groups[i] = blob
        if (blob < this.chainShapeWeight.length) {
          this.chainShapeWeight[blob] += weight
          for (let k = 0; k < covarianceSize; k++) this.chainShape[blob * covarianceSize + k] += weight * atomShape[k]
        }
      }
    }

    // The blobs' places come from the loader, and each blob's covariance is its members' scatter about it plus the
    // weighted mean of their own covariances
    if (residueGroups && residues?.blobs && merged) {
      if (residueBlob + 1 !== merged.residues.count) return this.mismatch('residues', merged.residues.count, residueBlob + 1)
      residueGroups.count = merged.residues.count
      residues.blobs.centers = merged.residues.centers
      const { scatters } = merged.residues
      const covariances = roomFor(residues.blobs.covariances, residueGroups.count * covarianceSize, (length) =>
        new Float32Array(grownLength(length, Math.ceil(expectedOf(structure, residueGroups.count) * arrivingMargin) * covarianceSize, 0)),
      )
      for (let at = 0; at < newResidues; at++) {
        const blob = firstResidueBlob + at
        for (let k = 0; k < covarianceSize; k++) {
          const place = blob * covarianceSize + k
          covariances[place] = scatters[place] + residueSums[at * covarianceSize + k] / residueWeights[at]
        }
      }
      residues.blobs.covariances = covariances
      residues.paint = roomFor(residues.paint, covariances.length / covarianceSize * paintSize, (length) => new Uint8ClampedArray(length))
    }
    if (chainGroups && chains?.blobs && merged) {
      if (chainGroups.count !== merged.chains.count) return this.mismatch('chains', merged.chains.count, chainGroups.count)
      chains.blobs.centers = merged.chains.centers
      const { scatters } = merged.chains
      const covariances = new Float32Array(chainGroups.count * covarianceSize)
      for (let blob = 0; blob < chainGroups.count; blob++) {
        for (let k = 0; k < covarianceSize; k++) {
          const place = blob * covarianceSize + k
          covariances[place] = scatters[place] + this.chainShape[place] / this.chainShapeWeight[blob]
        }
      }
      chains.blobs.covariances = covariances
      chains.paint = roomFor(chains.paint, chainGroups.count * paintSize, (length) => new Uint8ClampedArray(length))
    }

    // Each piece's spans, and the pieces whose shown atoms grew
    this.drawn = null
    const before = this.atoms.sizes
    this.structure = structure
    this.shown = shown
    this.merged = merged
    this.atoms = atomSpans(structure, shown)
    const pieces = pieceCount(structure)
    const changed: number[] = []
    for (let piece = 1; piece < pieces; piece++) {
      if ((before[piece] ?? 0) !== this.atoms.sizes[piece]) changed.push(piece)
    }
    for (const owned of this.levels) {
      if (owned) owned.spans = owned.blobs ? groupSpans(this.atoms, owned.blobs.grouping.groups) : this.atoms
    }

    // The spheres of the pieces that changed, each about its first level and holding every level it draws
    // A piece with no sphere yet draws nothing, which its radius below 0 says. A piece new in this batch takes its sphere
    // from everything it draws, and one that had a sphere widens it to hold what it draws that's new: its new atoms,
    // its new residues' blobs, and its chain's blob as it now stands
    this.spheres = roomFor(this.spheres, pieces * sphereSize, (length) =>
      new Float64Array(Math.max(length, this.spheres.length * 2)).fill(-1),
    )
    const drawn = this.drawnLevels()
    const firstNew = [from, firstResidueBlob, 0]
    for (const piece of changed) {
      if (this.spheres[piece * sphereSize + 3] < 0) {
        pieceSphere(drawn, piece, this.spheres)
        continue
      }
      drawn.forEach((level, k) => {
        const index = k === 0 ? 0 : levels.indexOf(this.built.filter((built) => built !== 'atoms')[k - 1])
        widenSphere(level, piece, firstNew[index], this.spheres)
      })
    }
    if (this.walk.pieces.length !== pieces) this.walk = new PieceWalk(pieces)

    this.measure(structure, slots)
    // How far the levels reach from the centre, from the spheres while the entry arrives and exactly once it has
    this.reach = spheresReach(this.spheres, pieces, center[0], center[1], center[2])
    this.reaching = structure.whole ? this.startReach(center) : null
    return changed
  }

  // Each level's typical size and whether it's offered, as its instances so far stand to its pool's slots. While the
  // entry arrives a level's typical size is the median of a small sample of its instances, evenly spaced among them,
  // taken again as they grow; once it has all arrived, of a larger one, which is every instance of an example's level
  measure(structure: Structure, slots: (level: Level) => number) {
    this.levels.forEach((owned, index) => {
      if (!owned) return
      const count = owned.blobs ? owned.blobs.grouping.count : this.shown.count
      owned.offered = count <= slots(levels[index])
      this.offered[index] = owned.offered
      if (this.detail !== 'auto' || (structure.whole && this.diametersExact[index])) return
      const grown = count >= this.diametersAt[index] * arrivingGrowth || levels[index] === 'chains'
      if (!structure.whole && !grown) return
      const stride = Math.max(1, Math.ceil(count / (structure.whole ? wholeSample : arrivingSample)))
      const diameters = new Float64Array(Math.ceil(count / stride))
      if (owned.blobs) {
        const { covariances } = owned.blobs
        for (let k = 0; k < diameters.length; k++) diameters[k] = drawnDiameter(covariances, k * stride * covarianceSize, surfaceDeviations)
      } else if (owned.offered) {
        // The atoms' shapes aren't kept, so each atom sampled is worked out as it's taken
        for (let k = 0; k < diameters.length; k++) {
          writeAtomShape(atomShape, 0, structure, this.shown.rows[k * stride], this.radii, this.shape)
          diameters[k] = drawnDiameter(atomShape, 0, surfaceDeviations)
        }
      } else return
      this.diametersAt[index] = count
      this.diameters[index] = medianOf(diameters)
      this.diametersExact[index] = structure.whole
    })
  }

  // Works on the exact reach for a step, and gives it once it's found, or null while there's more to do
  reachOnward(): number | null {
    const work = this.reaching
    if (!work) return null
    // The atoms reach only where they're built, though their spans make every piece's sphere
    const drawn = this.drawnLevels()
    const built = this.built.includes('atoms') ? drawn : drawn.slice(1)
    const [cx, cy, cz] = work.center
    let tested = 0
    const centre = centreAt
    while (work.next < work.order.length && tested < reachStep) {
      const piece = work.order[work.next]
      const at = piece * sphereSize
      const bound = Math.hypot(this.spheres[at] - cx, this.spheres[at + 1] - cy, this.spheres[at + 2] - cz) + this.spheres[at + 3]
      if (bound <= work.reach) {
        work.next = work.order.length
        break
      }
      for (const level of built) {
        const { spans } = level
        for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
          for (let i = spans.start[s]; i < spans.end[s]; i++) {
            level.centreOf(i, centre)
            const reach = Math.hypot(centre[0] - cx, centre[1] - cy, centre[2] - cz) + level.extentOf(i)
            if (reach > work.reach) work.reach = reach
            tested++
          }
        }
      }
      work.next++
    }
    if (work.next < work.order.length) return null
    this.reaching = null
    this.reach = work.reach
    return work.reach
  }

  // Whether what it was last painted from stands, and every shown atom is painted from it
  paintedFrom(inputs: TablePaint) {
    return this.painted === inputs && this.paintedTo === this.shown.count
  }

  // Paints a step of the shown atoms from the inputs, and the blobs they're merged into, telling each piece repainted.
  // Inputs that differ from the last only by the atoms an arriving entry has added paint on from where the last
  // stopped, and any others paint afresh from the first. Inputs of other shown atoms wait for the content that draws them
  paintOnward(inputs: TablePaint, repainted: (piece: number) => void) {
    if (inputs.shown !== this.shown) return
    if (this.painted !== inputs && !(this.painted && grownFrom(this.painted, inputs))) {
      this.paintedTo = 0
      this.chainPaint.fill(0)
      this.chainPaintWeight.fill(0)
    }
    this.painted = inputs
    const { rows, count } = this.shown
    const from = this.paintedTo
    if (from >= count) return
    // A step ends where a residue does, so that each residue's blob is painted from all its members
    const { residue } = this.structure.atoms
    let to = Math.min(count, from + paintStep)
    while (to < count && residue[rows[to]] === residue[rows[to - 1]]) to++
    paintAtoms(this.atomPaint, inputs, from, to)
    const residues = this.levels[1]
    if (residues?.blobs) paintMergedRange(residues.paint, this.atomPaint, residues.blobs.grouping.groups, this.weights, from, to)
    const chains = this.levels[2]
    if (chains?.blobs) {
      const { groups, count: blobs } = chains.blobs.grouping
      this.roomForChains(this.structure.chains.count, blobs)
      for (let i = from; i < to; i++) {
        const blob = groups[i]
        const weight = this.weights[i]
        this.chainPaintWeight[blob] += weight
        for (let k = 0; k < paintSize; k++) this.chainPaint[blob * paintSize + k] += weight * this.atomPaint[i * paintSize + k]
      }
      for (let blob = 0; blob < blobs; blob++) {
        const total = this.chainPaintWeight[blob]
        if (!(total > 0)) continue
        for (let k = 0; k < paintSize; k++) chains.paint[blob * paintSize + k] = this.chainPaint[blob * paintSize + k] / total
      }
    }
    this.paintedTo = to
    let last = -1
    for (let i = from; i < to; i++) {
      const piece = chainOf(this.structure, rows[i]) + 1
      if (piece === last) continue
      last = piece
      repainted(piece)
    }
  }

  // The levels as a piece's sphere reads them: the atoms, whether or not they're built, as the first, then each merged
  // level built, in order
  private drawnLevels(): DrawnLevel[] {
    this.drawn ??= this.makeDrawnLevels()
    return this.drawn
  }

  private makeDrawnLevels(): DrawnLevel[] {
    const { structure, shown, radii, shape } = this
    const { positions } = structure.atoms
    const atoms: DrawnLevel = {
      spans: this.atoms,
      centreOf: (i, centre) => {
        const at = shown.rows[i] * 3
        centre[0] = positions[at]
        centre[1] = positions[at + 1]
        centre[2] = positions[at + 2]
      },
      extentOf: (i) => {
        writeAtomShape(atomShape, 0, structure, shown.rows[i], radii, shape)
        return ellipsoidExtent(atomShape, 0)
      },
    }
    const drawn = [atoms]
    for (const level of this.built) {
      const blobs = this.levels[levels.indexOf(level)]
      if (level === 'atoms' || !blobs?.blobs) continue
      drawn.push(keptLevel({ spans: blobs.spans, centers: blobs.blobs.centers, covariances: blobs.blobs.covariances }))
    }
    return drawn
  }

  // The exact reach's work from its start, the pieces in order of how far their spheres reach from the centre
  private startReach(center: [number, number, number]): ReachWork {
    const [cx, cy, cz] = center
    const { spheres } = this
    const bound = (piece: number) => {
      const at = piece * sphereSize
      return Math.hypot(spheres[at] - cx, spheres[at + 1] - cy, spheres[at + 2] - cz) + spheres[at + 3]
    }
    const order: number[] = []
    for (let piece = 1; piece < pieceCount(this.structure); piece++) if (spheres[piece * sphereSize + 3] >= 0) order.push(piece)
    order.sort((a, b) => bound(b) - bound(a))
    return { center, order, next: 0, reach: 0 }
  }

  // Room in the chains' columns for a count of chains and of chain blobs
  private roomForChains(chains: number, blobs: number) {
    if (this.chainBlobs.length < chains) {
      const grown = new Int32Array(Math.max(chains, this.chainBlobs.length * 2)).fill(-1)
      grown.set(this.chainBlobs)
      this.chainBlobs = grown
    }
    const room = Math.max(blobs, chains)
    if (this.chainShapeWeight.length < room) {
      const length = Math.max(room, this.chainShapeWeight.length * 2)
      this.chainShape = roomFor(this.chainShape, length * covarianceSize, (size) => new Float64Array(size))
      this.chainShapeWeight = roomFor(this.chainShapeWeight, length, (size) => new Float64Array(size))
      this.chainPaint = roomFor(this.chainPaint, length * paintSize, (size) => new Float64Array(size))
      this.chainPaintWeight = roomFor(this.chainPaintWeight, length, (size) => new Float64Array(size))
    }
  }

  private mismatch(level: string, merged: number, shown: number): null {
    console.warn(`PDBSplat: the loader merged ${merged} ${level} where ${shown} are shown`)
    return null
  }

  // A ray picks the atom whose ellipsoid it meets first, whichever level is drawn, so the label names the atom under
  // the pointer at every level, and an atom of the blob under it. It passes through an atom faded far out of focus, and
  // through whatever the cut has taken. The ray is tested in the structure's own space, where the atoms' ellipsoids
  // are, and the cut is as far along it there as in the scene. Only the pieces whose spheres it passes through are
  // tested, nearest first, and each atom's ellipsoid is worked out as it's tested, from the atoms arrived so far
  private pick(structureObject: Object3D): PickTest {
    const found: EllipsoidHit = { index: -1, distance: Infinity }
    const local = new Ray()
    const shapeOf = new Float32Array(covarianceSize)
    const inverse = new Float32Array(covarianceSize)
    // How far along the ray the cut lies, for the pick under way
    const along = { cut: 0 }
    const testPiece = (piece: number) => {
      const { atoms, shown, structure, radii, shape, atomPaint } = this
      const { positions } = structure.atoms
      for (let s = atoms.first[piece]; s < atoms.first[piece + 1]; s++) {
        for (let i = atoms.start[s]; i < atoms.end[s]; i++) {
          const atom = shown.rows[i]
          writeAtomShape(shapeOf, 0, structure, atom, radii, shape)
          invertCovariance(shapeOf, 0, inverse, 0)
          const distance = ellipsoidEntry(local, positions, atom * 3, inverse, 0, along.cut)
          if (distance > found.distance || (distance === found.distance && i > found.index)) continue
          if (!isPickable(atomPaint, i)) continue
          found.index = i
          found.distance = distance
        }
      }
    }
    return (raycaster, hit) => {
      if (this.shown.count === 0) return
      along.cut = cutAlong(raycaster.ray, raycaster.camera)
      pickByPieces(rayInto(raycaster.ray, structureObject, local), this.spheres, along.cut, this.walk, found, testPiece)
      if (found.index < 0 || found.distance >= hit.distance) return
      hit.atom = this.shown.rows[found.index]
      hit.distance = found.distance
    }
  }
}
