import { Color, SRGBColorSpace } from 'three'
import { burial } from '../pdb/burial.ts'
import { elementColor } from '../pdb/elements.ts'
import { residueKey, type Atom } from '../pdb/mmcif.ts'
import { percentile } from '../pdb/percentile.ts'
import type { ColorBy } from '../store.ts'

// The chain and rainbow colourings' saturation and lightness, in three's HSL over the working colour space
const saturation = 0.75
const lightness = 0.55

// The rainbow's hues, as fractions of the colour wheel: blue at a chain's first residue to red at its last
const rainbowStart = 240 / 360
const rainbowEnd = 0

// The B-factor colouring spreads from blue to red between these percentiles of the entry's B-factors
const lowPercentile = 0.05
const highPercentile = 0.95

// Each atom's colour, by element, chain, B-factor or place along its chain, as r, g, b per atom in three's working
// colour space, darkened by Burial's share of how buried the atom is. The entry's atoms set the B-factor spread, the
// rainbow's ends and the burial, so that hiding atoms recolours none
export function atomColors(atoms: readonly Atom[], colorBy: ColorBy, entry: readonly Atom[], burialStrength: number) {
  const colors = new Float32Array(atoms.length * 3)
  const chainColors = new Map<string, Color>()
  const color = new Color()
  const spread = colorBy === 'bfactor' ? bFactorSpread(entry) : null
  const positions = colorBy === 'rainbow' ? rainbowPositions(entry) : null
  const buried = burialStrength > 0 ? burial(entry).values : null
  atoms.forEach((atom, i) => {
    if (colorBy === 'chain') color.copy(chainColor(chainColors, atom.chain))
    else if (spread) bFactorColor(color, spread, atom.bFactor)
    else {
      // The rainbow leaves ligands, sugars and waters, which are in no polymer chain, in their elements' colours
      const position = positions && atom.polymer ? positions.get(residueKey(atom)) : undefined
      if (position === undefined) color.copy(elementColor(atom.element))
      else color.setHSL(rainbowStart + (rainbowEnd - rainbowStart) * position, saturation, lightness)
    }
    if (buried) color.multiplyScalar(1 - burialStrength * (buried.get(atom) ?? 0))
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  })
  return colors
}

// Chains take hues a golden angle apart, in the order they first appear, so neighbours differ
function chainColor(colors: Map<string, Color>, chain: string) {
  let color = colors.get(chain)
  if (!color) {
    color = new Color().setHSL((colors.size * 0.618034) % 1, saturation, lightness)
    colors.set(chain, color)
  }
  return color
}

interface Spread {
  low: number
  high: number
}

// Each entry's spread, kept beside its atoms, which are never changed
const spreads = new WeakMap<readonly Atom[], Spread>()

// The low and high percentiles of the B-factors of the entry's atoms other than waters, whose B-factors run high
export function bFactorSpread(entry: readonly Atom[]): Spread {
  let spread = spreads.get(entry)
  if (!spread) {
    const values = Float64Array.from(entry.filter((atom) => !atom.water), (atom) => atom.bFactor).sort()
    spread = { low: percentile(values, lowPercentile), high: percentile(values, highPercentile) }
    spreads.set(entry, spread)
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

// Each entry's polymer residues, by residue key, at their place along their chain from 0 at its first to 1 at its last
const rainbows = new WeakMap<readonly Atom[], Map<string, number>>()

// A chain's polymer residues, modified ones such as selenomethionine included, in the file's order
export function rainbowPositions(entry: readonly Atom[]) {
  let positions = rainbows.get(entry)
  if (!positions) {
    const chains = new Map<string, string[]>()
    const seen = new Set<string>()
    for (const atom of entry) {
      if (!atom.polymer) continue
      const key = residueKey(atom)
      if (seen.has(key)) continue
      seen.add(key)
      let residues = chains.get(atom.chain)
      if (!residues) {
        residues = []
        chains.set(atom.chain, residues)
      }
      residues.push(key)
    }
    const placed = new Map<string, number>()
    for (const residues of chains.values()) {
      residues.forEach((key, i) => placed.set(key, residues.length > 1 ? i / (residues.length - 1) : 0))
    }
    rainbows.set(entry, placed)
    positions = placed
  }
  return positions
}
