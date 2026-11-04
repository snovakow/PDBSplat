import { OrbitControls, Stats } from '@react-three/drei'
import { useRef, type ComponentRef } from 'react'
import { useStore } from '../store.ts'
import { useBounds } from './bounds.ts'
import { Framing } from './Framing.tsx'
import { ProteinSplats } from './ProteinSplats.tsx'
import { ProteinSurface } from './ProteinSurface.tsx'
import { ShadingUniforms } from './ShadingUniforms.tsx'
import { styleOf } from './styles.ts'

export function Viewer() {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const bounds = useBounds()
  const style = useStore((s) => styleOf(s.options.style))
  return (
    <>
      <OrbitControls ref={controlsRef} makeDefault />
      <Stats />
      <Framing controlsRef={controlsRef} bounds={bounds} />
      <ShadingUniforms bounds={bounds} />
      {style.kind === 'splats' ? (
        <ProteinSplats bounds={bounds} colorNode={style.colorNode} />
      ) : (
        <ProteinSurface bounds={bounds} />
      )}
    </>
  )
}
