import { DataTexture, RGBAFormat, UnsignedByteType } from 'three'
import { writeColorBytes } from 'three/addons/utils/GaussianSplatUtils.js'
import { dot, int, ivec2, round, textureLoad, uniform, varyingProperty, vec3 } from 'three/tsl'
import type { ColorBy, Conformations, Focus } from '../options.ts'
import type { Atom } from '../pdb/mmcif.ts'
import { atomColors } from './atomColors.ts'
import { focusTest } from './focus.ts'

// The atom table: each shown atom's colour and alpha, four bytes per atom in splat-index order, in a texture the
// splats' shaders read by the atom's index, which the splat's own colour bytes carry. A splat's bytes are copied into
// its storage when it's built and have no update path, so a new colouring, Burial, Focus, Fade or pick rewrites the
// table in place instead, and needn't rebuild a splat

const bytesPerAtom = 4
// A byte's range: an index is written as three bytes, the red the low, the green the middle and the blue the high,
// so it's exact to 2²⁴ atoms
const byteRange = 256
const fullByte = byteRange - 1

export interface AtomTable {
  texture: DataTexture
  // The texture's bytes, which clamp and round what's written as the splats' own colour bytes do
  bytes: Uint8ClampedArray
}

// What the table is painted from: the shown atoms and the entry they're from, Colour by and Burial, Focus with the
// picked focus's key and Fade, the model shown, or null for every model at once, with how many the entry has, and
// Alternates
export interface TablePaint {
  shown: readonly Atom[]
  entry: readonly Atom[]
  colorBy: ColorBy
  burial: number
  focus: Focus
  picked: string | null
  fade: number
  model: number | null
  modelCount: number
  conformations: Conformations
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
  return { texture: new DataTexture(bytes, width, height, RGBAFormat, UnsignedByteType), bytes }
}

// Writes an atom's index into its splat's colour bytes, with a full alpha, so that three's raycast never skips it
export function writeAtomIndex(target: Uint8ClampedArray, offset: number, index: number) {
  const low = index % byteRange
  const middle = Math.floor(index / byteRange) % byteRange
  const high = Math.floor(index / (byteRange * byteRange))
  writeColorBytes(target, offset, low, middle, high, fullByte)
}

// The index the bytes at an offset carry
export function readAtomIndex(source: Uint8ClampedArray, offset: number) {
  return source[offset] + source[offset + 1] * byteRange + source[offset + 2] * byteRange * byteRange
}

// Paints every shown atom's texel: its colour from the colouring, darkened by Burial, and its alpha from what fades it.
// An atom in focus has a full alpha, and one out of focus Fade's share of it. Every model drawn at once overlaps the
// others, so each atom then keeps one over the square root of the number of models, and an atom in one of several
// conformations keeps its occupancy's share while they're all drawn. Only an alternate's occupancy fades it: an atom
// without one may be given less than 1, and is still drawn whole. Opacity acts through the shading's uniform, so it
// isn't here
export function paintAtomTable({ texture: table, bytes }: AtomTable, paint: TablePaint) {
  const { shown, entry, colorBy, burial, focus, picked, fade, model, modelCount, conformations } = paint
  const rgb = atomColors(shown, colorBy, entry, burial)
  const inFocus = focusTest(entry, focus, picked)
  const modelShare = model === null ? 1 / Math.sqrt(modelCount) : 1
  shown.forEach((atom, i) => {
    const focusShare = !inFocus || inFocus(atom) ? 1 : fade
    const occupancyShare = conformations === 'all' && atom.altLoc !== '' ? atom.occupancy : 1
    const alpha = fullByte * focusShare * modelShare * occupancyShare
    const r = rgb[i * 3] * fullByte
    const g = rgb[i * 3 + 1] * fullByte
    const b = rgb[i * 3 + 2] * fullByte
    writeColorBytes(bytes, i * bytesPerAtom, r, g, b, alpha)
  })
  table.needsUpdate = true
}

// three's raycast skips a splat whose alpha is below this share of full. It reads the splat's own bytes, whose alpha
// is always full, so the pick applies the same rule to the table's alpha, and atoms faded far out of focus stay
// unpickable
export const minPickOpacity = 0.2

export function isPickable({ bytes }: AtomTable, index: number) {
  return bytes[index * bytesPerAtom + 3] / fullByte >= minPickOpacity
}

// The splat's colour varying, three's own, which carries the index bytes: three clamps it to 0–1 and the quad's four
// corners carry one value, so each channel times 255 rounds back to its byte, and the three bytes make the index
const splatColor = varyingProperty('vec4', 'vSplatColor')
const atomIndex = int(dot(round(splatColor.rgb.mul(fullByte)), vec3(1, byteRange, byteRange * byteRange)))

// The read of the splat's atom's texel, by index: its row is the index over the table's width, and its column the rest.
// The width is a uniform set once, so that every table reads through the same shader
export function atomTexel({ texture: table }: AtomTable) {
  const width = uniform(table.image.width, 'int')
  const index = atomIndex.toVar()
  const row = index.div(width).toVar()
  return textureLoad(table, ivec2(index.sub(row.mul(width)), row))
}
