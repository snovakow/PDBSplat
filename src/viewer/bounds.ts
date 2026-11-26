import { useMemo } from 'react'
import { Vector3 } from 'three'
import { useStore } from '../store.ts'

export interface Bounds {
  center: Vector3
  radius: number
  // The angle about the y axis, from the z axis towards x, the camera opens at, facing the structure's broadest side
  broadside: number
}

// The shown entry's bounds, which every style centres the atoms on and the camera frames: as far as the entry has
// arrived while it does, and exactly once it has. They're those of the atoms Models and Alternates show at their
// defaults, waters included, so that showing more models or conformations doesn't move the structure or the camera
export function useBounds(): Bounds {
  const bounds = useStore((s) => s.bounds)
  return useMemo(
    () => ({ center: new Vector3(...bounds.center), radius: bounds.radius, broadside: bounds.broadside }),
    [bounds],
  )
}
