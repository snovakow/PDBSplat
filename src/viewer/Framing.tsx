import type { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, type ComponentRef, type RefObject } from 'react'
import { MathUtils, PerspectiveCamera } from 'three'
import { useStore } from '../store.ts'
import type { Bounds } from './bounds.ts'

// Room around the structure when it's framed
const frameMargin = 1.15

interface Props {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>
  bounds: Bounds
}

// A new entry is framed whole, looking down the z axis at its centroid, whatever the style
export function Framing({ controlsRef, bounds }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)

  useEffect(() => {
    const controls = controlsRef.current
    const { camera } = get()
    if (atoms.length === 0 || !controls || !(camera instanceof PerspectiveCamera)) return

    const halfFov = MathUtils.degToRad(camera.fov) / 2
    const halfFovX = Math.atan(Math.tan(halfFov) * camera.aspect)
    const distance = (bounds.radius / Math.sin(Math.min(halfFov, halfFovX))) * frameMargin

    camera.position.set(0, 0, distance)
    camera.near = bounds.radius / 100
    camera.far = distance * 4 + bounds.radius
    camera.updateProjectionMatrix()
    // Zooming out stops well before the far plane would clip the structure
    controls.maxDistance = distance * 3
    controls.target.set(0, 0, 0)
    controls.update()
  }, [get, controlsRef, atoms, bounds])

  return null
}
