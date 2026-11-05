import { OrbitControls, Stats } from '@react-three/drei'
import { useRef, type ComponentRef } from 'react'
import { useStore } from '../store.ts'
import { useBounds } from './bounds.ts'
import { Clip } from './Clip.tsx'
import { Effects } from './Effects.tsx'
import { Framing } from './Framing.tsx'
import { Picking } from './Picking.tsx'
import { ProteinSplats } from './ProteinSplats.tsx'
import { ProteinSurface } from './ProteinSurface.tsx'
import { ShadingUniforms } from './ShadingUniforms.tsx'
import { styleOf } from './styles.ts'

export function Viewer() {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const bounds = useBounds()
  const style = useStore((s) => styleOf(s.options.style))
  // The pipeline renders the scene only while bloom has something to add
  const effects = useStore((s) => s.options.bloom > 0)
  return (
    <>
      <OrbitControls ref={controlsRef} makeDefault />
      <Stats />
      <Framing controlsRef={controlsRef} bounds={bounds} />
      <Clip bounds={bounds} />
      <Picking />
      <ShadingUniforms bounds={bounds} />
      {style.kind === 'splats' ? (
        <ProteinSplats bounds={bounds} colorNode={style.colorNode} />
      ) : (
        <ProteinSurface bounds={bounds} />
      )}
      {effects && <Effects />}
    </>
  )
}
