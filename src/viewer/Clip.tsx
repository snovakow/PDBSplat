import { useFrame } from '@react-three/fiber'
import { PerspectiveCamera, Vector3 } from 'three'
import { useStore } from '../store.ts'
import type { Bounds } from './bounds.ts'
import { baseNear } from './nearPlane.ts'

interface Props {
  bounds: Bounds
}

// The way the camera looks, which the structure's depth is measured along
const forward = new Vector3()

// Moves the camera's near plane into the structure from the side facing the camera, cutting away what's in front of
// it, as far as Clip says across the structure's depth. Splats go whole, while the surface shows its cut
export function Clip({ bounds }: Props) {
  const clip = useStore((s) => s.options.clip)

  // The cut follows the view depth of the structure's centre, which sits at the origin, as the camera orbits, zooms or
  // pans. The projection is rebuilt only when the plane moves, and at 0 the plane stays where framing put it
  useFrame(({ camera }) => {
    if (bounds.radius === 0 || !(camera instanceof PerspectiveCamera)) return
    const base = baseNear(bounds.radius)
    const centreDepth = -camera.position.dot(forward.set(0, 0, -1).applyQuaternion(camera.quaternion))
    const front = centreDepth - bounds.radius
    const near = clip > 0 ? Math.max(base, front + clip * 2 * bounds.radius) : base
    if (camera.near === near) return
    camera.near = near
    camera.updateProjectionMatrix()
  })

  return null
}
