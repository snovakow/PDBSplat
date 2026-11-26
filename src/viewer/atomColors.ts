import { Color, SRGBColorSpace } from 'three'
import { elementHex } from '../pdb/elements.ts'
import { percentile } from '../pdb/percentile.ts'
import {
  chainOf,
  defaultAtoms,
  polymerFlag,
  residueKey,
  residueNameOf,
  secondaryStructures,
  waterFlag,
  type SecondaryStructure,
  type ShownAtoms,
  type Structure,
} from '../pdb/structure.ts'
import type { ColorBy } from '../options.ts'

// The chain and rainbow colourings' saturation and lightness, in three's HSL over the working colour space
const saturation = 0.75
const lightness = 0.55

// The rainbow's hues, as fractions of the colour wheel: blue at a chain's first residue to red at its last
const rainbowStart = 240 / 360
const rainbowEnd = 0

// The B-factor colouring spreads from blue to red between these percentiles of the entry's B-factors
const lowPercentile = 0.05
const highPercentile = 0.95

// The secondary-structure colouring's colours, Jmol's: a polymer residue takes its range's, or outside any range,
// DNA's or RNA's, or white for anything else
const structureColors: Record<Exclude<SecondaryStructure, 'none'>, Color> = {
  helix: new Color(0xff0080),
  strand: new Color(0xffc800),
  turn: new Color(0x6080ff),
}
const dnaColor = new Color(0xae00fe)
const rnaColor = new Color(0xfd0162)
const otherColor = new Color(0xffffff)
const dnaResidues = new Set(['DA', 'DC', 'DG', 'DT', 'DU'])
const rnaResidues = new Set(['A', 'C', 'G', 'U'])

// Each element's colour as three reads it, made once: hex is sRGB, which Color converts to the renderer's linear
// working space
const elementColorCache = new Map<string, Color>()
function elementColor(symbol: string) {
  let color = elementColorCache.get(symbol)
  if (!color) {
    color = new Color(elementHex(symbol))
    elementColorCache.set(symbol, color)
  }
  return color
}

// Writes an atom's colour, by its row, into a Color, and gives that Color back
export type AtomColoring = (atom: number, color: Color) => Color

// How each atom is coloured, by element, chain, B-factor, place along its chain or secondary structure, in three's
// working colour space, darkened by Burial's share of how buried the atom is, given by its row, or by none until the
// burial is worked out. The entry sets the B-factor spread, the rainbow's ends and the burial, so that hiding atoms
// recolours none; the chains take their hues in the order the shown atoms first come to them
export function atomColoring(
  structure: Structure,
  shown: ShownAtoms,
  colorBy: ColorBy,
  burialStrength: number,
  burial: Float32Array | null,
): AtomColoring {
  const { atoms } = structure
  const { flags } = atoms
  const elements = structure.elements.map(elementColor)
  const chains = colorBy === 'chain' ? chainColors(structure, shown) : null
  const spread = colorBy === 'bfactor' ? bFactorSpread(structure) : null
  const positions = colorBy === 'rainbow' ? rainbowPositions(structure) : null
  const buried = burialStrength > 0 ? burial : null
  return (atom, color) => {
    const polymer = (flags[atom] & polymerFlag) !== 0
    if (chains) color.copy(chains[chainOf(structure, atom)])
    else if (spread) bFactorColor(color, spread, atoms.bFactor[atom])
    // The structure colouring, like the rainbow, leaves atoms outside polymer chains in their elements' colours
    else if (colorBy === 'structure' && polymer) color.copy(structureColor(structure, atom))
    else {
      // The rainbow leaves ligands, sugars and waters, which are in no polymer chain, in their elements' colours
      const position = positions && polymer ? positions[atoms.residue[atom]] : NaN
      if (Number.isNaN(position)) color.copy(elements[atoms.element[atom]])
      else color.setHSL(rainbowStart + (rainbowEnd - rainbowStart) * position, saturation, lightness)
    }
    if (buried) color.multiplyScalar(1 - burialStrength * buried[atom])
    return color
  }
}

// Each shown atom's colour under a colouring, as r, g, b per atom in the order they're shown
export function atomColors(
  structure: Structure,
  shown: ShownAtoms,
  colorBy: ColorBy,
  burialStrength: number,
  burial: Float32Array | null,
) {
  const colorOf = atomColoring(structure, shown, colorBy, burialStrength, burial)
  const colors = new Float32Array(shown.count * 3)
  const color = new Color()
  for (let i = 0; i < shown.count; i++) {
    colorOf(shown.rows[i], color)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  return colors
}

// A modified residue inside a range takes its colour, and a nucleotide outside any range is coloured as DNA or RNA
function structureColor(structure: Structure, atom: number) {
  const structureOf = secondaryStructures[structure.residues.structure[structure.atoms.residue[atom]]]
  if (structureOf !== 'none') return structureColors[structureOf]
  const name = residueNameOf(structure, atom)
  if (dnaResidues.has(name)) return dnaColor
  if (rnaResidues.has(name)) return rnaColor
  return otherColor
}

// Each chain's colour, by its row. Chains take hues a golden angle apart, by name, in the order the shown atoms first
// come to them, so neighbours differ and a chain keeps its hue in every model; the chains none of them reach come after
function chainColors(structure: Structure, shown: ShownAtoms) {
  const { chains } = structure
  const hues = new Map<string, Color>()
  const hueOf = (name: string) => {
    let color = hues.get(name)
    if (!color) {
      color = new Color().setHSL((hues.size * 0.618034) % 1, saturation, lightness)
      hues.set(name, color)
    }
    return color
  }
  let last = -1
  for (let i = 0; i < shown.count; i++) {
    const chain = chainOf(structure, shown.rows[i])
    if (chain === last) continue
    last = chain
    hueOf(chains.name[chain])
  }
  return chains.name.map(hueOf)
}

interface Spread {
  low: number
  high: number
}

// Each entry's spread, kept beside its tables, which are never changed
const spreads = new WeakMap<Structure, Spread>()

// The low and high percentiles of the B-factors of the entry's atoms other than waters, whose B-factors run high.
// They're taken from the atoms shown at the defaults, so that showing more models or conformations recolours none
export function bFactorSpread(structure: Structure): Spread {
  let spread = spreads.get(structure)
  if (!spread) {
    const { flags, bFactor } = structure.atoms
    const values = Float64Array.from(
      defaultAtoms(structure).filter((atom) => (flags[atom] & waterFlag) === 0),
      (atom) => bFactor[atom],
    ).sort()
    spread = { low: percentile(values, lowPercentile), high: percentile(values, highPercentile) }
    spreads.set(structure, spread)
  }
  return spread
}

// Blue at the low percentile and below, through white, to red at the high one and above, mixed in sRGB.
// Where the two percentiles meet, every atom is white
function bFactorColor(color: Color, { low, high }: Spread, bFactor: number) {
  if (!(high > low)) return color.setRGB(1, 1, 1, SRGBColorSpace)
  const t = Math.min(Math.max((bFactor - low) / (high - low), 0), 1)
  const fade = t < 0.5 ? 2 * t : 2 * (1 - t)
  return t < 0.5 ? color.setRGB(fade, fade, 1, SRGBColorSpace) : color.setRGB(1, fade, fade, SRGBColorSpace)
}

// Each entry's residues' places along their chains, kept beside its tables
const rainbows = new WeakMap<Structure, Float64Array>()

// Each residue's place along its chain, by its row, from 0 at the chain's first polymer residue to 1 at its last, or
// NaN for a residue in no polymer. A chain's polymer residues, modified ones such as selenomethionine included, are
// those shown at the defaults, in the file's order, and a residue of another model or conformation takes the place of
// the one with its chain's name, its number and its insertion code, so it takes the same place in every model
export function rainbowPositions(structure: Structure) {
  let positions = rainbows.get(structure)
  if (!positions) {
    const { atoms, residues, chains } = structure
    const placed = new Float64Array(residues.count).fill(NaN)
    const chainResidues = new Map<string, number[]>()
    let last = -1
    for (const atom of defaultAtoms(structure)) {
      const residue = atoms.residue[atom]
      if ((atoms.flags[atom] & polymerFlag) === 0 || residue === last) continue
      last = residue
      const name = chains.name[chainOf(structure, atom)]
      let listed = chainResidues.get(name)
      if (!listed) {
        listed = []
        chainResidues.set(name, listed)
      }
      if (listed.at(-1) !== residue) listed.push(residue)
    }
    for (const listed of chainResidues.values()) {
      listed.forEach((residue, i) => {
        placed[residue] = listed.length > 1 ? i / (listed.length - 1) : 0
      })
    }
    // The other models' residues meet the first model's by their keys
    if (structure.models.length > 1) {
      const byKey = new Map<string, number>()
      for (const listed of chainResidues.values()) for (const residue of listed) byKey.set(residueKey(structure, residue), placed[residue])
      const firstModel = structure.models[0]
      for (let residue = 0; residue < residues.count; residue++) {
        if (chains.model[structure.runs.chain[residues.run[residue]]] === firstModel) continue
        placed[residue] = byKey.get(residueKey(structure, residue)) ?? NaN
      }
    }
    rainbows.set(structure, placed)
    positions = placed
  }
  return positions
}
