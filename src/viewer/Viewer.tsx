import { OrbitControls, Stats } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { Group } from 'three'
import { entryHolds, useStore } from '../store.ts'
import { Clip } from './Clip.tsx'
import { Effects } from './Effects.tsx'
import { Framing } from './Framing.tsx'
import { ModelPlayer } from './ModelPlayer.tsx'
import { Pace } from './Pace.tsx'
import { Picking } from './Picking.tsx'
import { ProteinField } from './ProteinField.tsx'
import { ProteinSplats } from './ProteinSplats.tsx'
import { ProteinSurface } from './ProteinSurface.tsx'
import { ShadingUniforms } from './ShadingUniforms.tsx'
import { Spin } from './Spin.tsx'
import { isOpaque, isWeighted, styleOf } from './styles.ts'

export function Viewer() {
  const get = useThree((s) => s.get)
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  // The structure's object, which every style's meshes are children of, in the scene while the viewer is, and placed
  // by the framing so that the entry's centre sits at the origin
  const [structureObject] = useState(() => new Group())
  useEffect(() => {
    const { scene } = get()
    scene.add(structureObject)
    return () => {
      scene.remove(structureObject)
    }
  }, [get, structureObject])
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
      <Framing controlsRef={controlsRef} structureObject={structureObject} />
      <Pace controlsRef={controlsRef} />
      <Spin controlsRef={controlsRef} />
      <Clip />
      <Picking structureObject={structureObject} />
      <ShadingUniforms />
      {style.kind === 'splats' ? (
        <ProteinSplats structureObject={structureObject} />
      ) : style.kind === 'surface' ? (
        <ProteinSurface structureObject={structureObject} />
      ) : (
        <ProteinField structureObject={structureObject} />
      )}
      {effects && <Effects />}
      {playing && <ModelPlayer />}
    </>
  )
}
