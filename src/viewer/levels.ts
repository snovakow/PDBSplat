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

// The typical drawn diameter of a set of Gaussians, in the covariances' units: the median over them of the diameter a
// round Gaussian of the same mean variance is drawn at, twice the cutoff in standard deviations times the root of a
// third of the covariance's trace. It's 0 for no Gaussians
export function typicalDiameter(covariances: Float32Array, cutoff: number) {
  const count = covariances.length / 6
  if (count === 0) return 0
  const diameters = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const trace = covariances[i * 6] + covariances[i * 6 + 3] + covariances[i * 6 + 5]
    diameters[i] = 2 * cutoff * Math.sqrt(trace / 3)
  }
  diameters.sort()
  const middle = count >> 1
  return count % 2 === 1 ? diameters[middle] : (diameters[middle - 1] + diameters[middle]) / 2
}

// How many pixels across a level's typical Gaussian must still be for that level to be drawn, chosen by eye on the
// GroEL–GroES complex: a splat drawn smaller costs its draw for nothing the eye can use
export const levelPixels = 4

// The pixels a unit of length spans on screen at a view depth: the viewport's height over the height the view spans
// there, from the camera's vertical field of view in degrees
export function pixelsPerUnit(viewportHeight: number, fov: number, depth: number) {
  return viewportHeight / (2 * depth * Math.tan((fov * Math.PI) / 360))
}

// Which level to draw, by the levels' typical diameters, finest first, and the pixels a unit of them spans: the finest
// level whose typical Gaussian still spans the pixels a level needs, or the coarsest where none does
export function levelToDraw(diameters: readonly number[], pixels: number) {
  for (let level = 0; level < diameters.length; level++) {
    if (diameters[level] * pixels >= levelPixels) return level
  }
  return diameters.length - 1
}
