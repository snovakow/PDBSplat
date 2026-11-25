import { OrbitControls, Stats } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { Group, Quaternion } from 'three'
import { entryHolds, useStore } from '../store.ts'
import { useBounds } from './bounds.ts'
import { Clip } from './Clip.tsx'
import { Effects } from './Effects.tsx'
import { Framing } from './Framing.tsx'
import { ModelPlayer } from './ModelPlayer.tsx'
import { Picking } from './Picking.tsx'
import { placeStructure } from './placement.ts'
import { ProteinField } from './ProteinField.tsx'
import { ProteinSplats } from './ProteinSplats.tsx'
import { ProteinSurface } from './ProteinSurface.tsx'
import { ShadingUniforms } from './ShadingUniforms.tsx'
import { Spin } from './Spin.tsx'
import { isOpaque, isWeighted, styleOf } from './styles.ts'

// The turn the structure is placed by about its centre: none, so that it stands as the file gives it
const asGiven = new Quaternion()

export function Viewer() {
  const get = useThree((s) => s.get)
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const bounds = useBounds()
  // The structure's object, which every style's meshes are children of, in the scene while the viewer is, and placed
  // so that the entry's centre sits at the origin
  const [structureObject] = useState(() => new Group())
  useEffect(() => {
    const { scene } = get()
    scene.add(structureObject)
    return () => {
      scene.remove(structureObject)
    }
  }, [get, structureObject])
  useEffect(() => {
    placeStructure(structureObject, bounds.center, asGiven)
  }, [structureObject, bounds])
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
        <ProteinSplats bounds={bounds} structureObject={structureObject} />
      ) : style.kind === 'surface' ? (
        <ProteinSurface bounds={bounds} structureObject={structureObject} />
      ) : (
        <ProteinField bounds={bounds} structureObject={structureObject} />
      )}
      {effects && <Effects />}
      {playing && <ModelPlayer />}
    </>
  )
}
