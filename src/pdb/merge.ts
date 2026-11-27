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
// them: a residue's in the order of the residues, its whole one before its one in part, and a chain's in each layer as
// its first residue there closes
export interface MergedLevel {
  count: number
  centers: Float32Array
  scatters: Float32Array
}

// The residues' and the chains' blobs of the atoms a choice shows, merged by the layer each shown atom is drawn in,
// given by its place among the shown atoms, or in one layer for every shown atom where that's null
export interface MergedLevels {
  choice: ShownChoice
  residues: MergedLevel
  chains: MergedLevel
  layers: Uint8Array | null
}

// The layers a shown atom is drawn in, by its paint's alpha: whole, drawn in part, or hidden. A residue's or a chain's
// members in each of the first two make a blob of their own, whole before in part where it has both, and a hidden one
// is in no blob, so that a blob and the atoms it stands for are always drawn in the same layer
export const wholeLayer = 0
export const partLayer = 1
export const hiddenLayer = 2
const drawnLayers = 2

// The layer an alpha byte draws its atom in
export function layerOfAlpha(alpha: number) {
  return alpha >= 255 ? wholeLayer : alpha <= 0 ? hiddenLayer : partLayer
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
// What the open residue's sums keep, per layer: its members' summed weight, their weighted offsets from its origin,
// three, and the weighted second moments of those offsets, six
const residueSums = 10

// Merges atoms, added in the file's order, by residue and by chain, each layer apart. Each residue's sums are taken
// about its first atom's place, and each chain's about its first residue's centre, so that nothing far from the origin
// loses precision. A residue's blobs are numbered in the order of the residues, its whole one before its one in part,
// and a chain's by layer as its first residue in that layer closes
export class LevelMerge {
  private readonly residues = new LevelColumns()
  // Each chain's blob in each layer by its row, or -1 before its first shown atom there, and how many blobs there are
  private chainBlobs = new Int32Array(64 * drawnLayers).fill(-1)
  private chainCount = 0
  private sums = new Float64Array(64 * chainSums)
  private origins = new Float64Array(64 * 3)
  // The open residue: its row, its chain's, its origin, and its weight's sums in each layer
  private residue = -1
  private chain = -1
  private x0 = 0
  private y0 = 0
  private z0 = 0
  private readonly open = new Float64Array(drawnLayers * residueSums)
  private readonly scatter = new Float64Array(6)
  // How many of the residues' blobs the batches taken so far hold
  private residuesTaken = 0

  // Adds an atom at a place with a weight above 0, in its residue and chain by their rows, in a layer drawn. A
  // residue's atoms come together, and residues of a chain may come apart, as a chain's ligands and waters do
  add(x: number, y: number, z: number, weight: number, residue: number, chain: number, layer = wholeLayer) {
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
    const { open } = this
    const k = layer * residueSums
    open[k] += weight
    open[k + 1] += weight * dx
    open[k + 2] += weight * dy
    open[k + 3] += weight * dz
    open[k + 4] += weight * dx * dx
    open[k + 5] += weight * dx * dy
    open[k + 6] += weight * dx * dz
    open[k + 7] += weight * dy * dy
    open[k + 8] += weight * dy * dz
    open[k + 9] += weight * dz * dz
  }

  // Both levels, once every atom is added, merged by the layers given
  finish(choice: ShownChoice, layers: Uint8Array | null = null): MergedLevels {
    this.closeResidue()
    return { choice, residues: this.residues.finish(), chains: this.chainLevel(), layers }
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

  // Writes the open residue's blob in each layer it has members in, the whole one first, and adds each to its chain's
  // sums in that layer
  private closeResidue() {
    if (this.residue < 0) return
    const { open, scatter, sums } = this
    for (let layer = 0; layer < drawnLayers; layer++) {
      const k = layer * residueSums
      const w = open[k]
      if (!(w > 0)) continue
      const mx = open[k + 1] / w
      const my = open[k + 2] / w
      const mz = open[k + 3] / w
      scatter[0] = open[k + 4] / w - mx * mx
      scatter[1] = open[k + 5] / w - mx * my
      scatter[2] = open[k + 6] / w - mx * mz
      scatter[3] = open[k + 7] / w - my * my
      scatter[4] = open[k + 8] / w - my * mz
      scatter[5] = open[k + 9] / w - mz * mz
      const cx = this.x0 + mx
      const cy = this.y0 + my
      const cz = this.z0 + mz
      this.residues.add(cx, cy, cz, scatter)

      const blob = this.chainBlob(this.chain * drawnLayers + layer, cx, cy, cz)
      const c = blob * chainSums
      const dx = cx - this.origins[blob * 3]
      const dy = cy - this.origins[blob * 3 + 1]
      const dz = cz - this.origins[blob * 3 + 2]
      sums[c] += w
      sums[c + 1] += w * dx
      sums[c + 2] += w * dy
      sums[c + 3] += w * dz
      sums[c + 4] += w * (scatter[0] + dx * dx)
      sums[c + 5] += w * (scatter[1] + dx * dy)
      sums[c + 6] += w * (scatter[2] + dx * dz)
      sums[c + 7] += w * (scatter[3] + dy * dy)
      sums[c + 8] += w * (scatter[4] + dy * dz)
      sums[c + 9] += w * (scatter[5] + dz * dz)
    }
    this.residue = -1
    open.fill(0)
  }

  // The blob of a chain in a layer, by the chain's row times the layers drawn plus the layer, numbered when its first
  // residue in that layer closes, with its origin at that residue's centre
  private chainBlob(key: number, x: number, y: number, z: number) {
    if (key >= this.chainBlobs.length) {
      const blobs = new Int32Array(Math.max(key + 1, Math.ceil(this.chainBlobs.length * growth))).fill(-1)
      blobs.set(this.chainBlobs)
      this.chainBlobs = blobs
    }
    let blob = this.chainBlobs[key]
    if (blob >= 0) return blob
    blob = this.chainCount++
    this.chainBlobs[key] = blob
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

// Adds a structure's first atoms, up to a count, that a choice shows to a merge, from the columns that place them, each
// in the layer given by its place among the shown atoms, or all in one where none are given; a hidden one in none
function mergeAtoms(merge: LevelMerge, structure: AtomPlaces, choice: ShownChoice, count: number, layers: Uint8Array | null) {
  const weights = structure.elements.map((symbol) => weightOf(vdwRadius(symbol)))
  const { positions, flags, element, residue } = structure.atoms
  let shown = 0
  for (let atom = 0; atom < count; atom++) {
    if (!shownBy(flags[atom], modelOf(structure, atom), choice)) continue
    const layer = layers ? layers[shown] : wholeLayer
    shown++
    if (layer === hiddenLayer) continue
    const at = atom * 3
    merge.add(positions[at], positions[at + 1], positions[at + 2], weights[element[atom]], residue[atom], chainOf(structure, atom), layer)
  }
}

// Merges a structure's atoms that a choice shows, from the columns that place them, each in the layer given by its
// place among the shown atoms, or all in one where none are given
export function mergeLevels(structure: AtomPlaces, choice: ShownChoice, layers: Uint8Array | null = null): MergedLevels {
  const merge = new LevelMerge()
  mergeAtoms(merge, structure, choice, structure.atoms.count, layers)
  return merge.finish(choice, layers)
}

// The levels merged again for new layers from the levels merged for the layers before, where the chains whose atoms
// changed layer hold no more than a number of shown atoms, as a pick under a picked Focus moves a residue or a chain
// between layers: those chains merged afresh from their atoms, each alone in the order a whole merge takes them, and
// every other residue's and chain's blobs kept as they were, numbered again as a whole merge numbers them, so that the
// levels are those mergeLevels gives for the new layers. The shown atoms are given by their rows, in order. Null where
// the chains changed hold more atoms than that, which a whole merge then serves better
export function remergeChanged(
  structure: AtomPlaces,
  rows: Uint32Array,
  count: number,
  previous: MergedLevels,
  layers: Uint8Array | null,
  most: number,
): MergedLevels | null {
  const before = previous.layers
  const layerOf = (given: Uint8Array | null, i: number) => (given ? given[i] : wholeLayer)
  const { residue, positions, element } = structure.atoms
  // Each shown atom's chain, and the chains any of whose atoms changed layer, with how many atoms those hold
  const chainOfShown = new Uint32Array(count)
  const chainRows = structure.chains.model.length
  const touched = new Uint8Array(chainRows)
  for (let i = 0; i < count; i++) {
    chainOfShown[i] = chainOf(structure, rows[i])
    if (layerOf(before, i) !== layerOf(layers, i)) touched[chainOfShown[i]] = 1
  }
  let members = 0
  for (let i = 0; i < count; i++) members += touched[chainOfShown[i]]
  if (members > most) return null

  // The changed chains merged afresh, each alone
  const weights = structure.elements.map((symbol) => weightOf(vdwRadius(symbol)))
  const merges = new Map<number, LevelMerge>()
  for (let i = 0; i < count; i++) {
    const chain = chainOfShown[i]
    const layer = layerOf(layers, i)
    if (!touched[chain] || layer === hiddenLayer) continue
    let merge = merges.get(chain)
    if (!merge) {
      merge = new LevelMerge()
      merges.set(chain, merge)
    }
    const atom = rows[i]
    merge.add(positions[atom * 3], positions[atom * 3 + 1], positions[atom * 3 + 2], weights[element[atom]], residue[atom], chain, layer)
  }
  const fresh = new Map<number, { levels: MergedLevels; residue: number; chain: number }>()
  for (const [chain, merge] of merges) fresh.set(chain, { levels: merge.finish(previous.choice, layers), residue: 0, chain: 0 })

  // The levels put together residue by residue, as a whole merge numbers them: a residue's blobs whole then in part,
  // and a chain's in each layer as its first residue there comes. The blobs of the layers before are numbered alike,
  // to find each kept blob where it was
  const residues = new LevelColumns()
  const chainBlobs = new Int32Array(chainRows * drawnLayers).fill(-1)
  const chainsBefore = new Int32Array(chainRows * drawnLayers).fill(-1)
  const chainSources: { from: MergedLevel; at: number }[] = []
  let residueBefore = 0
  let chainCountBefore = 0
  const present = (given: Uint8Array | null, start: number, end: number) => {
    let whole = false
    let part = false
    for (let i = start; i < end; i++) {
      const layer = layerOf(given, i)
      whole ||= layer === wholeLayer
      part ||= layer === partLayer
    }
    return [whole, part]
  }
  const scatter = new Float64Array(6)
  for (let start = 0; start < count; ) {
    const row = residue[rows[start]]
    let end = start
    while (end < count && residue[rows[end]] === row) end++
    const chain = chainOfShown[start]
    const had = present(before, start, end)
    const has = present(layers, start, end)
    const own = fresh.get(chain)
    for (let layer = 0; layer < drawnLayers; layer++) {
      const key = chain * drawnLayers + layer
      if (had[layer] && chainsBefore[key] < 0) chainsBefore[key] = chainCountBefore++
      const was = had[layer] ? residueBefore++ : -1
      if (!has[layer]) continue
      // The residue's blob in this layer, from its chain's fresh merge, or as it was, where its chain's layers stood
      const source = own ? own.levels.residues : previous.residues
      const at = own ? own.residue++ : was
      for (let k = 0; k < 6; k++) scatter[k] = source.scatters[at * 6 + k]
      residues.add(source.centers[at * 3], source.centers[at * 3 + 1], source.centers[at * 3 + 2], scatter)
      if (chainBlobs[key] < 0) {
        chainBlobs[key] = chainSources.length
        chainSources.push(own ? { from: own.levels.chains, at: own.chain++ } : { from: previous.chains, at: chainsBefore[key] })
      }
    }
    start = end
  }
  const chains = new LevelColumns()
  for (const { from, at } of chainSources) {
    for (let k = 0; k < 6; k++) scatter[k] = from.scatters[at * 6 + k]
    chains.add(from.centers[at * 3], from.centers[at * 3 + 1], from.centers[at * 3 + 2], scatter)
  }
  return { choice: previous.choice, residues: residues.finish(), chains: chains.finish(), layers }
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
    mergeAtoms(this.merge, structure, choice, structure.atoms.count, null)
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
// its chains' blobs in place of the last batch's, or the levels afresh where a batch starts them so. An entry arriving
// is merged in one layer, its layers waiting for the whole of it
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
    return { choice: this.choice, residues: this.residues.view(), chains: this.chains, layers: null }
  }
}
