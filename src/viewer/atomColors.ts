import { Color } from 'three'
import { elementColor } from '../pdb/elements.ts'
import type { Atom } from '../pdb/mmcif.ts'
import type { ColorBy } from '../store.ts'

// Each atom's colour, by element or by chain, as r, g, b per atom in three's working colour space
export function atomColors(atoms: Atom[], colorBy: ColorBy) {
  const colors = new Float32Array(atoms.length * 3)
  const chainColors = new Map<string, Color>()
  atoms.forEach((atom, i) => {
    const color = colorBy === 'chain' ? chainColor(chainColors, atom.chain) : elementColor(atom.element)
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
    color = new Color().setHSL((colors.size * 0.618034) % 1, 0.75, 0.55)
    colors.set(chain, color)
  }
  return color
}
