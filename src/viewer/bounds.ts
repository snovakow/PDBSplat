import { useMemo } from 'react'
import { Vector3 } from 'three'
import { vdwRadius } from '../pdb/elements.ts'
import { defaultAtoms, type Atom } from '../pdb/mmcif.ts'
import { useStore } from '../store.ts'

export interface Bounds {
  center: Vector3
  radius: number
}

// The loaded entry's bounds, which every style centres the atoms on and the camera frames. They're those of the atoms
// Models and Alternates show at their defaults, waters included, so that showing more models or conformations doesn't
// move the structure or the camera
export function useBounds() {
  const atoms = useStore((s) => s.atoms)
  return useMemo(() => measure(defaultAtoms(atoms)), [atoms])
}

// The centroid, and the radius around it that holds every atom's van der Waals sphere
function measure(atoms: readonly Atom[]): Bounds {
  const center = new Vector3()
  for (const atom of atoms) {
    center.x += atom.x
    center.y += atom.y
    center.z += atom.z
  }
  if (atoms.length > 0) center.divideScalar(atoms.length)

  let radius = 0
  for (const atom of atoms) {
    const distance = Math.hypot(atom.x - center.x, atom.y - center.y, atom.z - center.z)
    radius = Math.max(radius, distance + vdwRadius(atom.element))
  }
  return { center, radius }
}
