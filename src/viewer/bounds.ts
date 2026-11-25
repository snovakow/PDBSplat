import { useMemo } from 'react'
import { Vector3 } from 'three'
import { vdwRadii } from '../pdb/elements.ts'
import { defaultAtoms, type Structure } from '../pdb/structure.ts'
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
  const structure = useStore((s) => s.structure)
  return useMemo(() => measure(structure, defaultAtoms(structure)), [structure])
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

// The centroid of the structure's atoms at the given rows, the radius around it that holds every one's van der Waals
// sphere, and the angle its broadest side faces
function measure(structure: Structure, rows: Uint32Array): Bounds {
  const { positions, element } = structure.atoms
  const radii = vdwRadii(structure.elements)
  const center = new Vector3()
  for (const atom of rows) {
    center.x += positions[atom * 3]
    center.y += positions[atom * 3 + 1]
    center.z += positions[atom * 3 + 2]
  }
  if (rows.length > 0) center.divideScalar(rows.length)

  let radius = 0
  let xx = 0
  let xz = 0
  let zz = 0
  for (const atom of rows) {
    const dx = positions[atom * 3] - center.x
    const dz = positions[atom * 3 + 2] - center.z
    radius = Math.max(radius, Math.hypot(dx, positions[atom * 3 + 1] - center.y, dz) + radii[element[atom]])
    xx += dx * dx
    xz += dx * dz
    zz += dz * dz
  }
  return { center, radius, broadside: broadsideAngle(xx, xz, zz) }
}
