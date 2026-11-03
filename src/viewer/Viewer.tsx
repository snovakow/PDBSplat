import { OrbitControls, Stats } from '@react-three/drei'
import { useRef, type ComponentRef } from 'react'
import { ProteinSplats } from './ProteinSplats.tsx'

export function Viewer() {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  return (
    <>
      <OrbitControls ref={controlsRef} makeDefault />
      <Stats />
      <ProteinSplats controlsRef={controlsRef} />
    </>
  )
}
