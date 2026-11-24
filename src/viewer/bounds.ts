import { useMemo } from 'react'
import { Vector3 } from 'three'
import { vdwRadius } from '../pdb/elements.ts'
import { defaultAtoms, type Atom } from '../pdb/mmcif.ts'
import { useStore } from '../store.ts'

export interface Bounds {
  center: Vector3
  radius: number
  // The angle about the y axis, from the z axis towards x, the camera opens at, facing the structure's broadest side
  broadside: number
}

// The loaded entry's bounds, which every style centres the atoms on and the camera frames. They're those of the atoms
// Models and Alternates show at their defaults, waters included, so that showing more models or conformations doesn't
// move the structure or the camera
export function useBounds() {
  const atoms = useStore((s) => s.atoms)
  return useMemo(() => measure(defaultAtoms(atoms)), [atoms])
}

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

// The centroid, the radius around it that holds every atom's van der Waals sphere, and the angle its broadest side
// faces
function measure(atoms: readonly Atom[]): Bounds {
  const center = new Vector3()
  for (const atom of atoms) {
    center.x += atom.x
    center.y += atom.y
    center.z += atom.z
  }
  if (atoms.length > 0) center.divideScalar(atoms.length)

  let radius = 0
  let xx = 0
  let xz = 0
  let zz = 0
  for (const atom of atoms) {
    const dx = atom.x - center.x
    const dz = atom.z - center.z
    radius = Math.max(radius, Math.hypot(dx, atom.y - center.y, dz) + vdwRadius(atom.element))
    xx += dx * dx
    xz += dx * dz
    zz += dz * dz
  }
  return { center, radius, broadside: broadsideAngle(xx, xz, zz) }
}
