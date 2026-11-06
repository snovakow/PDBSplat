import { OrbitControls, Stats } from '@react-three/drei'
import { useRef, type ComponentRef } from 'react'
import { useStore } from '../store.ts'
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
import { isOpaque, isWeighted, styleOf } from './styles.ts'

export function Viewer() {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const bounds = useBounds()
  const style = useStore((s) => styleOf(s.options.style))
  // The pipeline renders the scene only while it has something to add: bloom, the weighted blend's sums and their
  // composite, or ambient occlusion on an opaque scene
  const effects = useStore(
    (s) => s.options.bloom > 0 || isWeighted(s.options) || (s.options.ao > 0 && isOpaque(s.options)),
  )
  const playing = useStore((s) => s.options.models === 'play')
  return (
    <>
      <OrbitControls ref={controlsRef} makeDefault />
      <Stats />
      <Framing controlsRef={controlsRef} bounds={bounds} />
      <Clip bounds={bounds} />
      <Picking />
      {/* Besides copying the shading options into their uniforms, this gives the surface its depth cue, as fog on the
          scene; the splats take theirs in their colour nodes, so the cue reaches the styles by two routes */}
      <ShadingUniforms bounds={bounds} />
      {style.kind === 'splats' ? (
        <ProteinSplats bounds={bounds} colorNode={style.colorNode} />
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
