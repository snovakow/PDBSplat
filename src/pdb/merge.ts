// The merged levels' blobs, made as the atoms come in the file's order: each residue's shown atoms merged into one
// Gaussian as soon as the residue closes, and each chain's from its residues', by matching moments, which can be done
// a part at a time when each part's weight is carried with it. Only what the atoms' places give is merged here: each
// blob's centre, the weighted mean of its members' centres, and the scatter of their centres about it. The rest of a
// blob's covariance, the weighted mean of its members' own covariances, follows Size, Thermal and Ellipsoids, and is
// added where the atoms are drawn, so that none of those three needs a merge
import { vdwRadius } from './elements.ts'
import { roomToGrow, type AtomRecord } from './structure.ts'
import {
  chainOf,
  firstConformationFlag,
  hydrogenFlag,
  modelOf,
  shownBy,
  waterFlag,
  type AtomPlaces,
  type ShownChoice,
} from './structure.ts'

// A merged level: how many blobs, and each blob's centre and the scatter of its members' centres about it, a
// symmetric tensor in the order [xx, xy, xz, yy, yz, zz]. Its blobs are numbered as the shown atoms first come to
// them, a residue's in the order of the residues, a chain's in the order its first shown atom comes
export interface MergedLevel {
  count: number
  centers: Float32Array
  scatters: Float32Array
}

// The residues' and the chains' blobs of the atoms a choice shows
export interface MergedLevels {
  choice: ShownChoice
  residues: MergedLevel
  chains: MergedLevel
}

// The columns a level grows by, as it fills: by half again
const growth = 1.5

// A level's blobs as they're added, in growing columns
class LevelColumns {
  count = 0
  centers = new Float32Array(3 * 64)
  scatters = new Float32Array(6 * 64)

  add(x: number, y: number, z: number, scatter: Float64Array) {
    const blob = this.count++
    if (blob * 3 === this.centers.length) {
      const capacity = Math.ceil(blob * growth)
      const centers = new Float32Array(capacity * 3)
      centers.set(this.centers)
      this.centers = centers
      const scatters = new Float32Array(capacity * 6)
      scatters.set(this.scatters)
      this.scatters = scatters
    }
    this.centers[blob * 3] = x
    this.centers[blob * 3 + 1] = y
    this.centers[blob * 3 + 2] = z
    this.scatters.set(scatter, blob * 6)
  }

  // Makes room for a count of blobs all told, where it has less
  reserve(capacity: number) {
    if (capacity * 3 <= this.centers.length) return
    const centers = new Float32Array(capacity * 3)
    centers.set(this.centers.subarray(0, this.count * 3))
    this.centers = centers
    const scatters = new Float32Array(capacity * 6)
    scatters.set(this.scatters.subarray(0, this.count * 6))
    this.scatters = scatters
  }

  // Adds blobs already merged after the last, growing to an expected count where they don't fit
  append(level: MergedLevel, expected: number) {
    const end = this.count + level.count
    if (end * 3 > this.centers.length) this.reserve(roomToGrow(end, expected, this.centers.length / 3))
    this.centers.set(level.centers.subarray(0, level.count * 3), this.count * 3)
    this.scatters.set(level.scatters.subarray(0, level.count * 6), this.count * 6)
    this.count = end
  }

  // The blobs from one on, copied
  from(first: number): MergedLevel {
    return {
      count: this.count - first,
      centers: this.centers.slice(first * 3, this.count * 3),
      scatters: this.scatters.slice(first * 6, this.count * 6),
    }
  }

  // The blobs so far, as views of the columns, which later blobs are added after
  view(): MergedLevel {
    return { count: this.count, centers: this.centers.subarray(0, this.count * 3), scatters: this.scatters.subarray(0, this.count * 6) }
  }

  finish(): MergedLevel {
    return this.from(0)
  }
}

// The blobs merged since the last batch, as a batch carries them: the choice they're of, whether they start the levels
// afresh, as a new choice does, the residues' blobs closed since, from the first not yet given, and every chain's blob
// as its residues so far make it
export interface MergedBatch {
  choice: ShownChoice
  reset: boolean
  residues: MergedLevel & { from: number }
  chains: MergedLevel
}

// What a chain's sums keep, per chain: its members' summed weight, their weighted offsets from the chain's origin,
// three, and the weighted second moments of those offsets plus each residue's own scatter, six; and the origin, three
const chainSums = 10

// Merges atoms, added in the file's order, by residue and by chain. Each residue's sums are taken about its first
// atom's place, and each chain's about its first residue's centre, so that nothing far from the origin loses precision
export class LevelMerge {
  private readonly residues = new LevelColumns()
  // Each chain's blob by its row, or -1 before its first shown atom, and how many chains have one
  private chainBlobs = new Int32Array(64).fill(-1)
  private chainCount = 0
  private sums = new Float64Array(64 * chainSums)
  private origins = new Float64Array(64 * 3)
  // The open residue: its row, its chain's, its origin, and its weight's sums
  private residue = -1
  private chain = -1
  private x0 = 0
  private y0 = 0
  private z0 = 0
  private w = 0
  private sx = 0
  private sy = 0
  private sz = 0
  private sxx = 0
  private sxy = 0
  private sxz = 0
  private syy = 0
  private syz = 0
  private szz = 0
  private readonly scatter = new Float64Array(6)
  // How many of the residues' blobs the batches taken so far hold
  private residuesTaken = 0

  // Adds an atom at a place with a weight above 0, in its residue and chain by their rows. A residue's atoms come
  // together, and residues of a chain may come apart, as a chain's ligands and waters do
  add(x: number, y: number, z: number, weight: number, residue: number, chain: number) {
    if (residue !== this.residue) {
      this.closeResidue()
      this.residue = residue
      this.chain = chain
      this.x0 = x
      this.y0 = y
      this.z0 = z
    }
    const dx = x - this.x0
    const dy = y - this.y0
    const dz = z - this.z0
    this.w += weight
    this.sx += weight * dx
    this.sy += weight * dy
    this.sz += weight * dz
    this.sxx += weight * dx * dx
    this.sxy += weight * dx * dy
    this.sxz += weight * dx * dz
    this.syy += weight * dy * dy
    this.syz += weight * dy * dz
    this.szz += weight * dz * dz
  }

  // Both levels, once every atom is added
  finish(choice: ShownChoice): MergedLevels {
    this.closeResidue()
    return { choice, residues: this.residues.finish(), chains: this.chainLevel() }
  }

  // The blobs merged since the last time, at a residue's start, where every residue added is whole: the residues'
  // closed since, and every chain's as it stands
  take(choice: ShownChoice, reset: boolean): MergedBatch {
    this.closeResidue()
    const from = this.residuesTaken
    this.residuesTaken = this.residues.count
    return { choice, reset, residues: { ...this.residues.from(from), from }, chains: this.chainLevel() }
  }

  // Every chain's blob from its sums so far, in the order the chains' blobs were numbered as they came
  private chainLevel(): MergedLevel {
    const { sums, origins } = this
    const chains = new LevelColumns()
    for (let blob = 0; blob < this.chainCount; blob++) {
      const k = blob * chainSums
      const w = sums[k]
      const mx = sums[k + 1] / w
      const my = sums[k + 2] / w
      const mz = sums[k + 3] / w
      const scatter = this.scatter
      scatter[0] = sums[k + 4] / w - mx * mx
      scatter[1] = sums[k + 5] / w - mx * my
      scatter[2] = sums[k + 6] / w - mx * mz
      scatter[3] = sums[k + 7] / w - my * my
      scatter[4] = sums[k + 8] / w - my * mz
      scatter[5] = sums[k + 9] / w - mz * mz
      chains.add(origins[blob * 3] + mx, origins[blob * 3 + 1] + my, origins[blob * 3 + 2] + mz, scatter)
    }
    return chains.finish()
  }

  // Writes the open residue's blob, and adds it to its chain's sums
  private closeResidue() {
    if (this.residue < 0 || !(this.w > 0)) return
    const { w, scatter } = this
    const mx = this.sx / w
    const my = this.sy / w
    const mz = this.sz / w
    scatter[0] = this.sxx / w - mx * mx
    scatter[1] = this.sxy / w - mx * my
    scatter[2] = this.sxz / w - mx * mz
    scatter[3] = this.syy / w - my * my
    scatter[4] = this.syz / w - my * mz
    scatter[5] = this.szz / w - mz * mz
    const cx = this.x0 + mx
    const cy = this.y0 + my
    const cz = this.z0 + mz
    this.residues.add(cx, cy, cz, scatter)

    const blob = this.chainBlob(this.chain, cx, cy, cz)
    const k = blob * chainSums
    const { sums } = this
    const dx = cx - this.origins[blob * 3]
    const dy = cy - this.origins[blob * 3 + 1]
    const dz = cz - this.origins[blob * 3 + 2]
    sums[k] += w
    sums[k + 1] += w * dx
    sums[k + 2] += w * dy
    sums[k + 3] += w * dz
    sums[k + 4] += w * (scatter[0] + dx * dx)
    sums[k + 5] += w * (scatter[1] + dx * dy)
    sums[k + 6] += w * (scatter[2] + dx * dz)
    sums[k + 7] += w * (scatter[3] + dy * dy)
    sums[k + 8] += w * (scatter[4] + dy * dz)
    sums[k + 9] += w * (scatter[5] + dz * dz)

    this.residue = -1
    this.w = this.sx = this.sy = this.sz = 0
    this.sxx = this.sxy = this.sxz = this.syy = this.syz = this.szz = 0
  }

  // The chain's blob, numbered when its first residue closes, which is in the order its first shown atom came, with
  // its origin at that residue's centre
  private chainBlob(chain: number, x: number, y: number, z: number) {
    if (chain >= this.chainBlobs.length) {
      const blobs = new Int32Array(Math.max(chain + 1, Math.ceil(this.chainBlobs.length * growth))).fill(-1)
      blobs.set(this.chainBlobs)
      this.chainBlobs = blobs
    }
    let blob = this.chainBlobs[chain]
    if (blob >= 0) return blob
    blob = this.chainCount++
    this.chainBlobs[chain] = blob
    if ((blob + 1) * 3 > this.origins.length) {
      const capacity = Math.ceil((blob + 1) * growth)
      const sums = new Float64Array(capacity * chainSums)
      sums.set(this.sums)
      this.sums = sums
      const origins = new Float64Array(capacity * 3)
      origins.set(this.origins)
      this.origins = origins
    }
    this.origins[blob * 3] = x
    this.origins[blob * 3 + 1] = y
    this.origins[blob * 3 + 2] = z
    return blob
  }
}

// An atom's weight in its blob: its van der Waals volume, which goes as its radius cubed. Size scales every radius
// alike, so it leaves the weights' shares as they are
function weightOf(radius: number) {
  return radius * radius * radius
}

// Adds a structure's first atoms, up to a count, that a choice shows to a merge, from the columns that place them
function mergeAtoms(merge: LevelMerge, structure: AtomPlaces, choice: ShownChoice, count: number) {
  const weights = structure.elements.map((symbol) => weightOf(vdwRadius(symbol)))
  const { positions, flags, element, residue } = structure.atoms
  for (let atom = 0; atom < count; atom++) {
    if (!shownBy(flags[atom], modelOf(structure, atom), choice)) continue
    const at = atom * 3
    merge.add(positions[at], positions[at + 1], positions[at + 2], weights[element[atom]], residue[atom], chainOf(structure, atom))
  }
}

// Merges a structure's atoms that a choice shows, from the columns that place them
export function mergeLevels(structure: AtomPlaces, choice: ShownChoice): MergedLevels {
  const merge = new LevelMerge()
  mergeAtoms(merge, structure, choice, structure.atoms.count)
  return merge.finish(choice)
}

// The choice a load is merged under, as the page asks for it before the entry's models are known: the first model, or
// every one
export interface LoadChoice {
  hydrogens: boolean
  waters: boolean
  conformations: 'first' | 'all'
  allModels: boolean
}

// Merges the atoms a reader adds as it reads them, those a load's choice shows, with the first model taken as the
// first atom's, until another choice is asked for, when the atoms read so far are merged again under it and the
// atoms after them join that
export class StreamMerge {
  private merge = new LevelMerge()
  private readonly asked: LoadChoice
  private choice: ShownChoice | null = null
  // Whether the next batch starts the levels afresh: the first does, and so does the one after another choice
  private reset = true
  private readonly weights = new Map<string, number>()
  private readonly place = new Float32Array(3)

  constructor(asked: LoadChoice) {
    this.asked = asked
  }

  atom(atom: AtomRecord, _row: number, residue: number, chain: number) {
    this.choice ??= choiceOf(this.asked, this.asked.allModels ? null : atom.model)
    const flags =
      (atom.hydrogen ? hydrogenFlag : 0) | (atom.water ? waterFlag : 0) | (atom.firstConformation ? firstConformationFlag : 0)
    if (!shownBy(flags, atom.model, this.choice)) return
    let weight = this.weights.get(atom.element)
    if (weight === undefined) {
      weight = weightOf(vdwRadius(atom.element))
      this.weights.set(atom.element, weight)
    }
    // The structure keeps its places in single precision, which the blobs are merged from as anywhere else
    const { place } = this
    place[0] = atom.x
    place[1] = atom.y
    place[2] = atom.z
    this.merge.add(place[0], place[1], place[2], weight, residue, chain)
  }

  // Merges the atoms read so far again under another choice, which the atoms after them are merged under too
  rechoose(choice: ShownChoice, structure: AtomPlaces) {
    this.choice = choice
    this.merge = new LevelMerge()
    mergeAtoms(this.merge, structure, choice, structure.atoms.count)
    this.reset = true
  }

  // What's been merged since the last batch, at a residue's start
  take(): MergedBatch {
    const batch = this.merge.take(this.choice ?? choiceOf(this.asked, null), this.reset)
    this.reset = false
    return batch
  }

  finish(): MergedLevels {
    return this.merge.finish(this.choice ?? choiceOf(this.asked, null))
  }
}

// The choice a load asked for, with its model found
function choiceOf({ hydrogens, waters, conformations }: LoadChoice, model: number | null): ShownChoice {
  return { hydrogens, waters, conformations, model }
}

// The merged levels as the page holds them while an entry arrives: each batch's residue blobs after the last, and
// its chains' blobs in place of the last batch's, or the levels afresh where a batch starts them so
export class MergedGrowth {
  private choice: ShownChoice | null = null
  private residues = new LevelColumns()
  private chains: MergedLevel = { count: 0, centers: new Float32Array(0), scatters: new Float32Array(0) }

  // Takes a batch, growing the residues' columns to a count expected of the whole where they're short
  append(batch: MergedBatch, expectedResidues: number) {
    if (batch.reset) this.residues = new LevelColumns()
    if (batch.residues.from !== this.residues.count) {
      throw new Error(`A batch of merged residues from ${batch.residues.from} came after ${this.residues.count}`)
    }
    this.residues.append(batch.residues, expectedResidues)
    this.chains = batch.chains
    this.choice = batch.choice
  }

  // The levels as they stand, the residues' as views of their growing columns, or null before any batch
  snapshot(): MergedLevels | null {
    if (!this.choice) return null
    return { choice: this.choice, residues: this.residues.view(), chains: this.chains }
  }
}
