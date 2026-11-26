import { Color, DataTexture, RGBAFormat, UnsignedByteType } from 'three'
import { dot, int, ivec2, round, vec3 } from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'
import type { ColorBy, Conformations, Focus } from '../options.ts'
import type { ShownAtoms, Structure } from '../pdb/structure.ts'
import { atomColoring } from './atomColors.ts'
import { focusTest } from './focus.ts'
import type { Grouping } from './levels.ts'

// The atoms' paint: each shown atom's colour and alpha, four bytes per atom in the order they're shown. The ellipsoids
// take it as an attribute of their instances, and the field as a table, a texture its march reads by the index of the
// atom that owns each point. A new colouring, Burial, Focus, Fade or pick rewrites the bytes in place, and rebuilds
// nothing

const bytesPerAtom = 4
// A byte's range: the field writes an owner's index as three bytes, the red the low, the green the middle and the blue
// the high, so it's exact to 2²⁴ atoms
const byteRange = 256
const fullByte = byteRange - 1

export interface AtomTable {
  texture: DataTexture
  // The texture's bytes, which clamp and round what's written
  bytes: Uint8ClampedArray
  // How many atoms it holds, in its first texels
  count: number
}

// What the atoms are painted from: the shown atoms and the structure they're from, Colour by and Burial, with each
// atom's burial by its row, or null until it's worked out, Focus with the picked focus's key and Fade, the model
// shown, or null for every model at once, with how many the entry has, Alternates, and whether what's painted is drawn
// in layers
export interface TablePaint {
  shown: ShownAtoms
  structure: Structure
  colorBy: ColorBy
  burial: number
  buried: Float32Array | null
  focus: Focus
  picked: number | null
  fade: number
  model: number | null
  modelCount: number
  conformations: Conformations
  layered: boolean
}

// The table is as wide as the square root of the atom count rounded up, and as tall as it then needs; an empty one
// is a single texel
export function tableSize(count: number) {
  const width = Math.max(1, Math.ceil(Math.sqrt(count)))
  return { width, height: Math.max(1, Math.ceil(count / width)) }
}

// A table for a count of atoms, unpainted. Its bytes are the linear colour and the alpha as they are, so it takes no
// colour space, and it's read by texel, so it takes no filtering and no mipmaps, as a DataTexture has by default
export function createAtomTable(count: number): AtomTable {
  const { width, height } = tableSize(count)
  const bytes = new Uint8ClampedArray(width * height * bytesPerAtom)
  return { texture: new DataTexture(bytes, width, height, RGBAFormat, UnsignedByteType), bytes, count }
}

// The index the bytes at an offset carry
export function readAtomIndex(source: Uint8ClampedArray, offset: number) {
  return source[offset] + source[offset + 1] * byteRange + source[offset + 2] * byteRange * byteRange
}

// The colour each atom is painted with, reused by every paint
const color = new Color()

// Paints every shown atom's four bytes: its colour from the colouring, darkened by Burial, and its alpha from what
// fades it. An atom in focus has a full alpha, and one out of focus Fade's share of it. Every model drawn at once
// overlaps the others, so each atom then keeps one over the square root of the number of models, where the atoms are
// summed or glow; layered, only the nearest see-through surface shows, which no number of models adds to, so each
// model's atoms stay whole. An atom in one of several conformations keeps its occupancy's share while they're all
// drawn. Only an alternate's occupancy fades it: an atom without one may be given less than 1, and is still drawn
// whole. Opacity acts through the shading's uniform, so it isn't here
export function paintAtoms(bytes: Uint8ClampedArray, paint: TablePaint) {
  const { shown, structure, colorBy, burial, buried, focus, picked, fade, model, modelCount, conformations, layered } = paint
  const colorOf = atomColoring(structure, shown, colorBy, burial, buried)
  const inFocus = focusTest(structure, focus, picked)
  const modelShare = model === null && !layered ? 1 / Math.sqrt(modelCount) : 1
  const { altLoc, occupancy } = structure.atoms
  for (let i = 0; i < shown.count; i++) {
    const atom = shown.rows[i]
    colorOf(atom, color)
    const focusShare = !inFocus || inFocus(atom) ? 1 : fade
    const occupancyShare = conformations === 'all' && altLoc[atom] !== 0 ? occupancy[atom] : 1
    bytes[i * bytesPerAtom] = color.r * fullByte
    bytes[i * bytesPerAtom + 1] = color.g * fullByte
    bytes[i * bytesPerAtom + 2] = color.b * fullByte
    bytes[i * bytesPerAtom + 3] = fullByte * focusShare * modelShare * occupancyShare
  }
}

// Paints a table's bytes, and has its texture sent again
export function paintAtomTable({ texture: table, bytes }: AtomTable, paint: TablePaint) {
  paintAtoms(bytes, paint)
  table.needsUpdate = true
}

// Paints a merged level's groups from the bytes its members are painted in: each group's four bytes are the weighted
// mean of its members' colours and alphas, by the weights the ellipsoids were merged with, so that a blob takes the
// colour of the atoms it stands for and fades as they do
export function paintMerged(
  bytes: Uint8ClampedArray,
  source: Uint8ClampedArray,
  { groups, count }: Grouping,
  weights: ArrayLike<number>,
) {
  const sums = new Float64Array(count * bytesPerAtom)
  const totals = new Float64Array(count)
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    const weight = weights[i]
    totals[group] += weight
    for (let k = 0; k < bytesPerAtom; k++) sums[group * bytesPerAtom + k] += weight * source[i * bytesPerAtom + k]
  }
  for (let group = 0; group < count; group++) {
    const offset = group * bytesPerAtom
    const total = totals[group]
    for (let k = 0; k < bytesPerAtom; k++) bytes[offset + k] = sums[offset + k] / total
  }
}

// The least share of a full alpha an atom can be picked at, so that the pointer passes through atoms faded far out of
// focus to what's behind them
export const minPickOpacity = 0.2

// Whether the atom at a place in the paint can be picked
export function isPickable(bytes: Uint8ClampedArray, index: number) {
  return bytes[index * bytesPerAtom + 3] / fullByte >= minPickOpacity
}

// The index three bytes carry, as a shader reads them from a colour of 0 to 1 per channel: each channel times 255
// rounds back to its byte, and the three bytes make the index
export function atomIndexOf(rgb: Node<'vec3'>) {
  return int(dot(round(rgb.mul(fullByte)), vec3(1, byteRange, byteRange * byteRange)))
}

// The read of an atom's texel from a table, by the atom's index: its row is the index over the table's width, and its
// column the rest. The read follows the table node's texture and the width's value, so that another table can be
// swapped in by setting both
export function atomTexelAt(table: TextureNode, width: Node<'int'>, index: Node<'int'>) {
  const i = index.toVar()
  const row = i.div(width).toVar()
  return table.load(ivec2(i.sub(row.mul(width)), row))
}
