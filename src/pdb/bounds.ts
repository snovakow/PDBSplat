// An entry's bounds, which the view centres the structure on and frames: the centroid of the atoms Models and
// Alternates show at their defaults, waters included, so that showing more models or conformations moves neither the
// structure nor the camera, the radius around it that holds every one's van der Waals sphere, and the angle its
// broadest side faces. While an entry arrives they're kept as its atoms come: the centroid exactly for the atoms so
// far, a radius that holds every one of them, exact unless a batch's share of measuring runs out, and the angle from
// their spread
import { vdwRadii } from './elements.ts'
import { chainOf, firstConformationFlag, modelOf, type AtomPlaces, type Structure } from './structure.ts'

export interface StructureBounds {
  // The centroid's x, y and z
  center: [number, number, number]
  radius: number
  // The angle about the y axis, from the z axis towards x, the camera opens at, facing the structure's broadest side
  broadside: number
}

// The bounds of no atoms, which an entry has before any have arrived
export const noBounds: StructureBounds = { center: [0, 0, 0], radius: 0, broadside: 0 }

// The angle about the y axis, from the z axis towards x, of the level direction a structure spreads least along,
// which is the way to look at it to see its broadest side: from the sums over its atoms of the squares and the
// product of their x and z about the centre. Of the two ways along that direction it's the one within a quarter turn
// of the z axis, and the z axis itself for a structure spread evenly, so that a round structure opens as the file
// gives it
export function broadsideAngle(xx: number, xz: number, zz: number) {
  // The direction of greatest spread makes half this angle with the x axis, towards z, and the camera stands a
  // quarter turn from it
  return -Math.atan2(2 * xz, xx - zz) / 2
}

// The bounds of the structure's atoms at the given rows, worked out exactly
export function measureBounds(structure: AtomPlaces, rows: ArrayLike<number>): StructureBounds {
  const { positions, element } = structure.atoms
  const radii = vdwRadii(structure.elements)
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < rows.length; i++) {
    const atom = rows[i]
    x += positions[atom * 3]
    y += positions[atom * 3 + 1]
    z += positions[atom * 3 + 2]
  }
  // The centroid is the sums times the count's reciprocal, as the running sums give it
  const share = rows.length > 0 ? 1 / rows.length : 1
  const center: StructureBounds['center'] = [x * share, y * share, z * share]

  let radius = 0
  let xx = 0
  let xz = 0
  let zz = 0
  for (let i = 0; i < rows.length; i++) {
    const atom = rows[i]
    const dx = positions[atom * 3] - center[0]
    const dz = positions[atom * 3 + 2] - center[2]
    radius = Math.max(radius, Math.hypot(dx, positions[atom * 3 + 1] - center[1], dz) + radii[element[atom]])
    xx += dx * dx
    xz += dx * dz
    zz += dz * dz
  }
  return { center, radius, broadside: broadsideAngle(xx, xz, zz) }
}

// The floats each chain keeps as its atoms come: a sphere around their van der Waals spheres, its centre's x, y and z
// and its radius, below 0 while the chain has no default atoms; the farthest any of them reached from the centre it
// was last measured from, and that centre's x, y and z; and whether atoms have come since
const chainFloats = 9
const measuredFrom = 4
const changedSince = 8

// The bounds of a structure's default atoms kept as they arrive, a stretch of rows at a time in the file's order. The
// centroid is the sums of their places so far times their count's reciprocal, as the exact bounds take it for the same
// atoms, and the radius is the farthest any atom's sphere reaches from it, as the exact bounds find it, worked out a
// chain at a time and only for the chains that could hold that atom. Each chain keeps a sphere holding its atoms',
// grown just enough to take each atom that falls outside it, and the farthest it reached when last measured: from a
// centroid since moved it can reach no farther than that and the move, nor than its sphere does. The chains that gained
// atoms are measured again, then the rest from the farthest any could reach down, until no chain left could reach past
// the farthest found, or the batch's share of measuring is spent, when the farthest any chain left could reach is taken
// instead, which holds every atom, and is the exact radius but for how far the centroid has moved since. The angle is
// the spread so far, taken about the first atom to keep its precision far from the origin
export class RunningBounds {
  private count = 0
  private x = 0
  private y = 0
  private z = 0
  // The first atom's place, and the sums of the places, the squares and the product of x and z about it
  private readonly shift = new Float64Array(3)
  private sx = 0
  private sz = 0
  private sxx = 0
  private sxz = 0
  private szz = 0
  private chains = new Float64Array(64 * chainFloats).fill(-1)
  // The row after the last added, which the chains are measured up to, and the row the last measure had come to
  private end = 0
  private measuredTo = 0

  // Adds the default atoms among the rows from one up to another, the next after those added before
  add(structure: AtomPlaces, from: number, to: number) {
    this.end = Math.max(this.end, to)
    const { positions, element, flags } = structure.atoms
    const radii = vdwRadii(structure.elements)
    const firstModel = structure.models[0]
    for (let atom = from; atom < to; atom++) {
      if ((flags[atom] & firstConformationFlag) === 0 || modelOf(structure, atom) !== firstModel) continue
      const px = positions[atom * 3]
      const py = positions[atom * 3 + 1]
      const pz = positions[atom * 3 + 2]
      if (this.count === 0) this.shift.set([px, py, pz])
      this.count++
      this.x += px
      this.y += py
      this.z += pz
      const dx = px - this.shift[0]
      const dz = pz - this.shift[2]
      this.sx += dx
      this.sz += dz
      this.sxx += dx * dx
      this.sxz += dx * dz
      this.szz += dz * dz
      this.take(chainOf(structure, atom), px, py, pz, radii[element[atom]])
    }
  }

  // The bounds of the atoms added so far, from the structure they were added from, which may hold rows after them
  bounds(structure: Pick<Structure, 'models' | 'elements' | 'atoms' | 'residues' | 'runs' | 'chains'>): StructureBounds {
    if (this.count === 0) return noBounds
    const share = 1 / this.count
    const center: StructureBounds['center'] = [this.x * share, this.y * share, this.z * share]
    const [cx, cy, cz] = center
    const { chains } = this
    const most = (at: number) => {
      const sphere = Math.hypot(chains[at] - cx, chains[at + 1] - cy, chains[at + 2] - cz) + chains[at + 3]
      if (chains[at + changedSince] !== 0) return sphere
      const moved = Math.hypot(chains[at + measuredFrom + 1] - cx, chains[at + measuredFrom + 2] - cy, chains[at + measuredFrom + 3] - cz)
      return Math.min(sphere, chains[at + measuredFrom] + moved)
    }
    // The chains that gained atoms are measured afresh, and then the rest from the farthest any could reach down, as
    // far as the batch's share of measuring goes; past it, the farthest any chain left could reach stands for them
    let budget = Math.max(leastMeasured, (this.end - this.measuredTo) * measuredPerAtom)
    this.measuredTo = this.end
    let radius = 0
    const order: number[] = []
    const reaches: number[] = []
    for (let chain = 0; chain * chainFloats < chains.length; chain++) {
      const at = chain * chainFloats
      if (chains[at + 3] < 0) continue
      if (chains[at + changedSince] !== 0) {
        budget -= this.measureFrom(structure, chain, cx, cy, cz)
        radius = Math.max(radius, chains[at + measuredFrom])
        continue
      }
      order.push(chain)
      reaches[chain] = most(at)
    }
    order.sort((a, b) => reaches[b] - reaches[a])
    for (const chain of order) {
      if (reaches[chain] < radius) break
      if (budget <= 0) {
        radius = reaches[chain]
        break
      }
      budget -= this.measureFrom(structure, chain, cx, cy, cz)
      radius = Math.max(radius, chains[chain * chainFloats + measuredFrom])
    }
    const mx = this.sx * share
    const mz = this.sz * share
    return { center, radius, broadside: broadsideAngle(this.sxx - this.sx * mx, this.sxz - this.sx * mz, this.szz - this.sz * mz) }
  }

  // Measures how far a chain's default atoms reach from a centre, and keeps it with the centre, giving how many atoms
  // were looked at
  private measureFrom(
    structure: Pick<Structure, 'models' | 'elements' | 'atoms' | 'residues' | 'runs' | 'chains'>,
    chain: number,
    cx: number,
    cy: number,
    cz: number,
  ) {
    const { chains } = this
    const at = chain * chainFloats
    const { reach, atoms } = this.measure(structure, chain, cx, cy, cz)
    chains[at + measuredFrom] = reach
    chains[at + measuredFrom + 1] = cx
    chains[at + measuredFrom + 2] = cy
    chains[at + measuredFrom + 3] = cz
    chains[at + changedSince] = 0
    return atoms
  }

  // The farthest a chain's default atoms' spheres reach from a centre, as the exact bounds measure each but for a
  // hair of slack, and how many atoms it looked at
  private measure(
    structure: Pick<Structure, 'models' | 'elements' | 'atoms' | 'residues' | 'runs' | 'chains'>,
    chain: number,
    cx: number,
    cy: number,
    cz: number,
  ) {
    const { positions, element, flags } = structure.atoms
    const { runs, chains } = structure
    const radii = vdwRadii(structure.elements)
    const firstModel = structure.models[0]
    if (chains.model[chain] !== firstModel) return { reach: 0, atoms: 0 }
    let reach = 0
    let atoms = 0
    for (let k = chains.firstRun[chain]; k < chains.firstRun[chain + 1]; k++) {
      const run = chains.runs[k]
      const last = Math.min(runs.firstAtom[run + 1], this.end)
      atoms += Math.max(0, last - runs.firstAtom[run])
      for (let atom = runs.firstAtom[run]; atom < last; atom++) {
        if ((flags[atom] & firstConformationFlag) === 0) continue
        const at = atom * 3
        const dx = positions[at] - cx
        const dy = positions[at + 1] - cy
        const dz = positions[at + 2] - cz
        reach = Math.max(reach, Math.sqrt(dx * dx + dy * dy + dz * dz) + radii[element[atom]])
      }
    }
    // A square root's rounding may differ from the exact bounds' by a hair, which the slack keeps it beyond
    return { reach: reach * (1 + roundingSlack), atoms }
  }

  // Grows a chain's sphere to hold an atom's: where the atom's reaches past it, the sphere becomes the smallest one
  // holding both, its centre moved towards the atom. The chain is to be measured again
  private take(chain: number, x: number, y: number, z: number, radius: number) {
    if ((chain + 1) * chainFloats > this.chains.length) {
      const grown = new Float64Array(Math.max(chain + 1, (this.chains.length / chainFloats) * 2) * chainFloats).fill(-1)
      grown.set(this.chains)
      this.chains = grown
    }
    const { chains } = this
    const at = chain * chainFloats
    chains[at + changedSince] = 1
    if (chains[at + 3] < 0) {
      chains[at] = x
      chains[at + 1] = y
      chains[at + 2] = z
      chains[at + 3] = radius
      return
    }
    const dx = x - chains[at]
    const dy = y - chains[at + 1]
    const dz = z - chains[at + 2]
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const old = chains[at + 3]
    if (distance + radius <= old) return
    // The larger of the two where one holds the other, and otherwise the sphere through both far sides, padded a
    // little against rounding
    if (old + distance <= radius) {
      chains[at] = x
      chains[at + 1] = y
      chains[at + 2] = z
      chains[at + 3] = radius
      return
    }
    const grown = (old + distance + radius) / 2
    const move = (grown - old) / distance
    chains[at] += dx * move
    chains[at + 1] += dy * move
    chains[at + 2] += dz * move
    chains[at + 3] = grown * (1 + roundingSlack)
  }
}

// How many atoms the bounds of a stretch of them may measure, for each atom the stretch brings and at least, so that
// what a batch's bounds cost goes as the batch, though the chains far out lie in a shell, as a virus's capsid's do
const measuredPerAtom = 2
const leastMeasured = 1 << 16

// How much a grown sphere is padded by, as a share of its radius, so that rounding never leaves an atom just outside
const roundingSlack = 1e-9
