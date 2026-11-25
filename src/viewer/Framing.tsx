import type { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, type ComponentRef, type RefObject } from 'react'
import { MathUtils, PerspectiveCamera } from 'three'
import { useStore } from '../store.ts'
import type { Bounds } from './bounds.ts'
import { drawnReach, nearPlane } from './nearPlane.ts'

// Room around the structure when it's framed
const frameMargin = 1.15

interface Props {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>
  bounds: Bounds
}

// A new entry is framed whole, looking level at its centroid from the side it's broadest, whatever the style, and the
// near plane follows the camera
export function Framing({ controlsRef, bounds }: Props) {
  const get = useThree((s) => s.get)
  const structure = useStore((s) => s.structure)

  useEffect(() => {
    const controls = controlsRef.current
    const { camera } = get()
    if (structure.atoms.count === 0 || !controls || !(camera instanceof PerspectiveCamera)) return

    const halfFov = MathUtils.degToRad(camera.fov) / 2
    const halfFovX = Math.atan(Math.tan(halfFov) * camera.aspect)
    const distance = (bounds.radius / Math.sin(Math.min(halfFov, halfFovX))) * frameMargin

    // Spin turns the view about the y axis, so the camera opens on that turn where the structure shows its broadest
    // side, rather than wherever the file's z axis happens to point
    camera.position.set(distance * Math.sin(bounds.broadside), 0, distance * Math.cos(bounds.broadside))
    camera.far = distance * 4 + bounds.radius
    camera.updateProjectionMatrix()
    // Zooming out stops well before the far plane would clip the structure
    controls.maxDistance = distance * 3
    controls.target.set(0, 0, 0)
    controls.update()
  }, [get, controlsRef, structure, bounds])

  // Each frame, after the controls have moved the camera, the near plane goes in front of what's drawn, as the
  // camera's distance from the structure's centre places it. The centre sits at the origin, so a turn about it leaves
  // the near plane where it is, and a zoom or a pan moves it
  useFrame(({ camera }) => {
    if (bounds.radius === 0 || !(camera instanceof PerspectiveCamera)) return
    const near = nearPlane(camera.position.length(), drawnReach(), bounds.radius)
    if (near === camera.near) return
    camera.near = near
    camera.updateProjectionMatrix()
  })

  return null
}
