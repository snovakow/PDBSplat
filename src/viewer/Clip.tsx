import { useFrame } from '@react-three/fiber'
import { PerspectiveCamera, Vector3 } from 'three'
import { useStore } from '../store.ts'
import { viewBounds } from './framing.ts'
import { clipDepth } from './shading.ts'

// The way the camera looks, which the structure's depth is measured along
const forward = new Vector3()

// Cuts away what's in front of a plane across the structure, facing the camera, as far in from its front as Clip says
// across its depth. Every style takes the cut in its own shader, pixel by pixel, at the one depth set here: the
// spheres are cut across and show a flat face, the soft splats fade out as they come through, the surface opens where
// it's cut, and the field starts there. The camera's near plane is no part of it, and stays in front of the structure
export function Clip() {
  const clip = useStore((s) => s.options.clip)

  // The cut follows the view depth of the structure's centre, which sits at the origin, as the camera orbits, zooms or
  // pans, and spans the radius the view stands on as it eases. At 0 nothing is cut
  useFrame(({ camera }) => {
    const { radius } = viewBounds
    if (radius === 0 || !(camera instanceof PerspectiveCamera)) return
    const centreDepth = -camera.position.dot(forward.set(0, 0, -1).applyQuaternion(camera.quaternion))
    const front = centreDepth - radius
    clipDepth.value = clip > 0 ? front + clip * 2 * radius : 0
  })

  return null
}
