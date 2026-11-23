import { OrbitControls, Stats } from '@react-three/drei'
import { useRef, type ComponentRef } from 'react'
import { entryHolds, useStore } from '../store.ts'
import { useBounds } from './bounds.ts'
import { Clip } from './Clip.tsx'
import { Effects } from './Effects.tsx'
import { Framing } from './Framing.tsx'
import { ModelPlayer } from './ModelPlayer.tsx'
import { Picking } from './Picking.tsx'
import { ProteinField } from './ProteinField.tsx'
import { ProteinSplats } from './ProteinSplats.tsx'
import { ProteinSurface } from './ProteinSurface.tsx'
import { ShadingUniforms } from './ShadingUniforms.tsx'
import { Spin } from './Spin.tsx'
import { isOpaque, isWeighted, styleOf } from './styles.ts'

export function Viewer() {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const bounds = useBounds()
  const style = useStore((s) => styleOf(s.options.style))
  // The pipeline renders the scene only while it has something to add: bloom, the soft splats' weighted sums and
  // their composite, or ambient occlusion on an opaque scene
  const effects = useStore(
    (s) => s.options.bloom > 0 || isWeighted(s.options) || (s.options.ao > 0 && isOpaque(s.options, entryHolds(s))),
  )
  const playing = useStore((s) => s.options.models === 'play')
  return (
    <>
      <OrbitControls ref={controlsRef} makeDefault />
      <Stats />
      <Framing controlsRef={controlsRef} bounds={bounds} />
      <Spin controlsRef={controlsRef} />
      <Clip bounds={bounds} />
      <Picking />
      <ShadingUniforms bounds={bounds} />
      {style.kind === 'splats' ? (
        <ProteinSplats bounds={bounds} />
      ) : style.kind === 'surface' ? (
        <ProteinSurface bounds={bounds} />
      ) : (
        <ProteinField bounds={bounds} />
      )}
      {effects && <Effects />}
      {playing && <ModelPlayer />}
    </>
  )
}
