// How deeply each atom of an entry is buried, by how closely the heavy atoms around it crowd it

import { neighbourGrid } from './neighbours.ts'
import { percentile } from './percentile.ts'
import { chainOf, defaultAtoms, firstConformationFlag, hydrogenFlag, waterFlag, type AtomPlaces } from './structure.ts'

// Heavy atoms within this distance of an atom, in ångströms, count towards its burial
const burialRadius = 10

// Burial spreads from 0 to 1 between these percentiles of the entry's sums
const lowPercentile = 0.05
const highPercentile = 0.95

export interface Burial {
  // Each atom's burial by its row, from 0 at the low percentile's sum or below to 1 at the high one's or above
  values: Float32Array
  // The sums at the two percentiles
  low: number
  high: number
}

// How many atoms' sums are worked out between the pauses a caller may take, which on a 2014 Mac mini is about a
// tenth of a second's work
const stretchAtoms = 1 << 15

// Sums, for each atom, the heavy atoms other than waters around it, each weighted by (1 − (d/R)²)², which falls
// smoothly from 1 beside the atom to 0 at the radius. Hydrogens and waters get a burial too, but don't add to any.
// Each model is a structure of its own, so an atom is buried by its own model's atoms, in their first conformations,
// and the percentiles come from the atoms shown at the defaults, so that showing more models or conformations
// darkens none of them differently. The sums are worked out a stretch of atoms at a time, each step giving how many
// atoms are done, so that a worker can answer its messages between stretches; the values come once every sum is
// known, since the percentiles are taken over all of them, and nothing is given against percentiles that would shift
export function* burialSteps(structure: AtomPlaces): Generator<number, Burial> {
  const { atoms, chains, models } = structure
  const { count, flags, positions } = atoms
  // Each chain's model by its place among the models, and each model's atoms that bury others
  const chainModels = Int32Array.from(chains.model, (model) => models.indexOf(model))
  const burying: number[][] = models.map(() => [])
  for (let atom = 0; atom < count; atom++) {
    if ((flags[atom] & (hydrogenFlag | waterFlag)) !== 0 || (flags[atom] & firstConformationFlag) === 0) continue
    burying[chainModels[chainOf(structure, atom)]].push(atom)
  }
  const grids = burying.map((members) => neighbourGrid(positions, burialRadius, members))
  const radiusSquared = burialRadius * burialRadius

  // One visitor serves every atom, so the search allocates nothing per atom
  let self = -1
  let sum = 0
  const add = (atom: number, distanceSquared: number) => {
    // The grid visits the atom itself, which doesn't bury itself
    if (atom === self) return
    const weight = 1 - distanceSquared / radiusSquared
    sum += weight * weight
  }
  const sums = new Float64Array(count)
  for (let first = 0; first < count; first += stretchAtoms) {
    const last = Math.min(first + stretchAtoms, count)
    for (let atom = first; atom < last; atom++) {
      self = atom
      sum = 0
      grids[chainModels[chainOf(structure, atom)]].forEachWithin(
        positions[atom * 3],
        positions[atom * 3 + 1],
        positions[atom * 3 + 2],
        add,
      )
      sums[atom] = sum
    }
    yield last
  }

  // Waters sit outside the structure, so the spread comes from the rest, as the B-factor colouring's does
  const sorted = Float64Array.from(
    defaultAtoms(structure).filter((atom) => (flags[atom] & waterFlag) === 0),
    (atom) => sums[atom],
  ).sort()
  const low = percentile(sorted, lowPercentile)
  const high = percentile(sorted, highPercentile)
  // Where the two percentiles meet, no atom is more buried than another
  const values = new Float32Array(count)
  if (high > low) for (let atom = 0; atom < count; atom++) values[atom] = clamp01((sums[atom] - low) / (high - low))
  return { values, low, high }
}

// Each entry's burial, worked out at once, kept beside its tables, which are never changed
const burials = new WeakMap<AtomPlaces, Burial>()

export function burial(structure: AtomPlaces): Burial {
  let result = burials.get(structure)
  if (!result) {
    const steps = burialSteps(structure)
    let step = steps.next()
    while (!step.done) step = steps.next()
    result = step.value
    burials.set(structure, result)
  }
  return result
}

// Limits a value to the range 0 to 1
function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1)
}
