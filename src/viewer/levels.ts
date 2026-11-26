// Levels of detail: the atoms merged into one Gaussian per residue or per chain, each level's typical drawn diameter,
// and the rule that picks the level to draw by how large its Gaussians are on screen
import type { Detail } from '../options.ts'
import { chainOf, type ShownAtoms, type Structure } from '../pdb/structure.ts'

// A level the splat styles can draw, finest first: the atoms themselves, one Gaussian per residue, or one per chain
export type Level = Exclude<Detail, 'auto'>
export const levels: readonly Level[] = ['atoms', 'residues', 'chains']

// Items grouped: each item's group, numbered in the order the groups first appear, and how many groups there are
export interface Grouping {
  groups: Uint32Array
  count: number
}

// Items grouped by their keys, each a whole number below the key count, such as a row of a table
export function groupBy(keys: ArrayLike<number>, keyCount: number): Grouping {
  const groups = new Uint32Array(keys.length)
  const numbers = new Int32Array(keyCount).fill(-1)
  let count = 0
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (numbers[key] < 0) numbers[key] = count++
    groups[i] = numbers[key]
  }
  return { groups, count }
}

// The shown atoms grouped as a merged level merges them: by residue, or by chain, each within its own model, so that
// every model drawn at once keeps its own blobs
export function levelGroups(structure: Structure, shown: ShownAtoms, level: Exclude<Level, 'atoms'>): Grouping {
  const keys = new Uint32Array(shown.count)
  for (let i = 0; i < shown.count; i++) {
    const atom = shown.rows[i]
    keys[i] = level === 'residues' ? structure.atoms.residue[atom] : chainOf(structure, atom)
  }
  return groupBy(keys, level === 'residues' ? structure.residues.count : structure.chains.count)
}

// One Gaussian per group: its centre, its covariance in the order [xx, xy, xz, yy, yz, zz], its members' summed
// weight and how many members it has
export interface MergedGaussians {
  centers: Float32Array
  covariances: Float32Array
  weights: Float64Array
  counts: Uint32Array
}

// Merges Gaussians into one per group by matching moments: each group's centre is the weighted mean of its members'
// centres, and its covariance the weighted mean of their covariances plus the scatter of their centres about the mean,
// so that a group spread along a line becomes an ellipsoid along it. Each weight must be above 0
export function mergeGaussians(
  centers: Float32Array,
  covariances: Float32Array,
  weights: ArrayLike<number>,
  { groups, count }: Grouping,
): MergedGaussians {
  const members = groups.length
  const totals = new Float64Array(count)
  const means = new Float64Array(count * 3)
  for (let i = 0; i < members; i++) {
    const group = groups[i]
    const weight = weights[i]
    totals[group] += weight
    means[group * 3] += weight * centers[i * 3]
    means[group * 3 + 1] += weight * centers[i * 3 + 1]
    means[group * 3 + 2] += weight * centers[i * 3 + 2]
  }
  for (let group = 0; group < count; group++) {
    means[group * 3] /= totals[group]
    means[group * 3 + 1] /= totals[group]
    means[group * 3 + 2] /= totals[group]
  }

  // The scatter is taken about the mean itself, rather than as the mean of squares less the square of the mean, which
  // loses precision far from the origin
  const sums = new Float64Array(count * 6)
  const counts = new Uint32Array(count)
  for (let i = 0; i < members; i++) {
    const group = groups[i]
    const weight = weights[i]
    const dx = centers[i * 3] - means[group * 3]
    const dy = centers[i * 3 + 1] - means[group * 3 + 1]
    const dz = centers[i * 3 + 2] - means[group * 3 + 2]
    sums[group * 6] += weight * (covariances[i * 6] + dx * dx)
    sums[group * 6 + 1] += weight * (covariances[i * 6 + 1] + dx * dy)
    sums[group * 6 + 2] += weight * (covariances[i * 6 + 2] + dx * dz)
    sums[group * 6 + 3] += weight * (covariances[i * 6 + 3] + dy * dy)
    sums[group * 6 + 4] += weight * (covariances[i * 6 + 4] + dy * dz)
    sums[group * 6 + 5] += weight * (covariances[i * 6 + 5] + dz * dz)
    counts[group]++
  }

  const merged: MergedGaussians = {
    centers: new Float32Array(count * 3),
    covariances: new Float32Array(count * 6),
    weights: totals,
    counts,
  }
  for (let group = 0; group < count; group++) {
    for (let k = 0; k < 3; k++) merged.centers[group * 3 + k] = means[group * 3 + k]
    for (let k = 0; k < 6; k++) merged.covariances[group * 6 + k] = sums[group * 6 + k] / totals[group]
  }
  return merged
}

// The covariances of a merged level's blobs, each the scatter of its members' centres about its own, as the loader
// merged them, plus the weighted mean of its members' own covariances, which follow Size, Thermal and Ellipsoids. It
// is what mergeGaussians gives for the same members, with the part that their places alone set made elsewhere
export function blobCovariances(
  scatters: Float32Array,
  covariances: Float32Array,
  weights: ArrayLike<number>,
  { groups, count }: Grouping,
): Float32Array {
  const sums = new Float64Array(count * 6)
  const totals = new Float64Array(count)
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    const weight = weights[i]
    totals[group] += weight
    for (let k = 0; k < 6; k++) sums[group * 6 + k] += weight * covariances[i * 6 + k]
  }
  const blobs = new Float32Array(count * 6)
  for (let group = 0; group < count; group++) {
    for (let k = 0; k < 6; k++) blobs[group * 6 + k] = scatters[group * 6 + k] + sums[group * 6 + k] / totals[group]
  }
  return blobs
}

// The bits of a double, high word and low word, as the histograms below read them. Two doubles at or above 0 are in
// the same order as their bits read as whole numbers, high word first
const double = new Float64Array(1)
const words = new Uint32Array(double.buffer)
const [lowWord, highWord] = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? [0, 1] : [1, 0]

// The digits a double's bits are read in, sixteen bits each from the highest, and how many values a digit takes
const digitCount = 4
const digitValues = 1 << 16

// One of a double's four digits, from the highest
function digitOf(value: number, digit: number) {
  double[0] = value
  const word = words[digit < 2 ? highWord : lowWord]
  return digit % 2 === 0 ? word >>> 16 : word & 0xffff
}

// The value at a rank among values at or above 0, as a sort would place it, without sorting them: a histogram of
// their highest digit finds the digit the ranked value has, and each lower digit's histogram, over the values that
// share the digits found so far, the next, until a few values are left to sort, or every digit is found and the values
// left are all the same
function ranked(values: Float64Array, rank: number) {
  const counts = new Uint32Array(digitValues)
  // The values whose digits so far match, as their digits are found
  let matching = values
  for (let digit = 0; digit < digitCount; digit++) {
    if (matching.length <= digitValues) return Float64Array.from(matching).sort()[rank]
    counts.fill(0)
    for (let i = 0; i < matching.length; i++) counts[digitOf(matching[i], digit)]++
    let found = 0
    while (rank >= counts[found]) rank -= counts[found++]
    const next = new Float64Array(counts[found])
    for (let i = 0, k = 0; i < matching.length; i++) if (digitOf(matching[i], digit) === found) next[k++] = matching[i]
    matching = next
  }
  return matching[0]
}

// The diameter a Gaussian with a covariance at an offset is drawn at, as a round one of the same mean variance is: twice
// the cutoff in standard deviations times the root of a third of the covariance's trace
export function drawnDiameter(covariances: ArrayLike<number>, at: number, cutoff: number) {
  const trace = covariances[at] + covariances[at + 3] + covariances[at + 5]
  return 2 * cutoff * Math.sqrt(trace / 3)
}

// The median of values at or above 0, or 0 for none
export function medianOf(values: Float64Array) {
  const count = values.length
  if (count === 0) return 0
  const middle = count >> 1
  return count % 2 === 1 ? ranked(values, middle) : (ranked(values, middle - 1) + ranked(values, middle)) / 2
}

// The typical drawn diameter of a set of Gaussians, in the covariances' units: the median over them of the diameter
// each is drawn at. It's 0 for no Gaussians
export function typicalDiameter(covariances: Float32Array, cutoff: number) {
  const count = covariances.length / 6
  const diameters = new Float64Array(count)
  for (let i = 0; i < count; i++) diameters[i] = drawnDiameter(covariances, i * 6, cutoff)
  return medianOf(diameters)
}

// How many pixels across a level's typical Gaussian must still be for that level to be drawn, chosen by eye on the
// GroEL–GroES complex: a splat drawn smaller costs its draw for nothing the eye can use
export const levelPixels = 4

// The pixels a unit of length spans on screen at a view depth: the viewport's height over the height the view spans
// there, from the camera's vertical field of view in degrees
export function pixelsPerUnit(viewportHeight: number, fov: number, depth: number) {
  return viewportHeight / (2 * depth * Math.tan((fov * Math.PI) / 360))
}

// The level drawn for the whole structure, by its place in levels, given the levels' typical diameters, finest first,
// and the pixels a unit of them spans: under auto the finest level offered whose typical Gaussian still spans the
// pixels a level needs, or the coarsest offered where none does, and under a fixed Detail that level, or the finest one
// offered past it where it isn't. A level is offered only where all its instances fit its pool, and the coarsest always
// is; a level not offered may give any diameter
export function levelDrawn(detail: Detail, offered: readonly boolean[], diameters: readonly number[], pixels: number) {
  const coarsest = levels.length - 1
  if (detail !== 'auto') {
    let level = levels.indexOf(detail)
    while (level < coarsest && !offered[level]) level++
    return level
  }
  let last = coarsest
  for (let level = 0; level < levels.length; level++) {
    if (!offered[level]) continue
    if (diameters[level] * pixels >= levelPixels) return level
    last = level
  }
  return last
}
