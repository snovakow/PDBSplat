import type { OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import type { ComponentRef, RefObject } from 'react'
import { useStore } from '../store.ts'
import { spinSpeed } from './spinSpeed.ts'

// drei's orbit controls update in a frame callback of priority -1, and a lower priority runs first without taking over
// the render, so each frame sets the speed before they turn the camera by it
const beforeControls = -2

interface Props {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>
}

// While Spin is on, the orbit controls turn the camera about the vertical axis through the point it orbits, so that the
// structure turns in place under the light from the viewer, in every style. They hold the turn while a drag moves the
// view and take it up again from wherever the drag leaves it, and their damping eases it in and out
export function Spin({ controlsRef }: Props) {
  const spin = useStore((s) => s.options.spin)

  useFrame((_, delta) => {
    const controls = controlsRef.current
    if (!controls) return
    controls.autoRotate = spin
    controls.autoRotateSpeed = spinSpeed(delta)
  }, beforeControls)

  return null
}
