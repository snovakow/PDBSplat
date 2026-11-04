// How deeply each atom of an entry is buried, by how closely the heavy atoms around it crowd it

import type { Atom } from './mmcif.ts'
import { neighbourGrid } from './neighbours.ts'
import { percentile } from './percentile.ts'

// Heavy atoms within this distance of an atom, in ångströms, count towards its burial
const burialRadius = 10

// Burial spreads from 0 to 1 between these percentiles of the entry's sums
const lowPercentile = 0.05
const highPercentile = 0.95

export interface Burial {
  // Each atom's burial, from 0 at the low percentile's sum or below to 1 at the high one's or above
  values: Map<Atom, number>
  // The sums at the two percentiles
  low: number
  high: number
}

// Each entry's burial, kept beside its atoms, which are never changed
const burials = new WeakMap<readonly Atom[], Burial>()

// Sums, for each atom, the heavy atoms other than waters around it, each weighted by (1 − (d/R)²)², which falls
// smoothly from 1 beside the atom to 0 at the radius. Hydrogens and waters get a burial too, but don't add to any
export function burial(entry: readonly Atom[]): Burial {
  let result = burials.get(entry)
  if (!result) {
    const start = performance.now()
    const neighbours = entry.filter((atom) => !atom.hydrogen && !atom.water)
    const grid = neighbourGrid(neighbours, burialRadius)
    const radiusSquared = burialRadius * burialRadius

    // One visitor serves every atom, so the search allocates nothing per atom
    let self: Atom | null = null
    let sum = 0
    const add = (index: number, distanceSquared: number) => {
      // The grid visits the atom itself, which doesn't bury itself
      if (neighbours[index] === self) return
      const weight = 1 - distanceSquared / radiusSquared
      sum += weight * weight
    }
    const sums = new Float64Array(entry.length)
    entry.forEach((atom, i) => {
      self = atom
      sum = 0
      grid.forEachWithin(atom.x, atom.y, atom.z, add)
      sums[i] = sum
    })

    // Waters sit outside the structure, so the spread comes from the rest, as the B-factor colouring's does
    const sorted = sums.filter((_, i) => !entry[i].water).sort()
    const low = percentile(sorted, lowPercentile)
    const high = percentile(sorted, highPercentile)
    // Where the two percentiles meet, no atom is more buried than another
    const values = new Map(
      entry.map((atom, i): [Atom, number] => [atom, high > low ? clamp01((sums[i] - low) / (high - low)) : 0]),
    )
    result = { values, low, high }
    burials.set(entry, result)
    console.info(`PDBSplat: burial of ${entry.length} atoms in ${Math.round(performance.now() - start)} ms`)
  }
  return result
}

// Limits a value to the range 0 to 1
function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1)
}
