import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useState } from 'react'
import { AtomLabel } from './AtomLabel.tsx'
import { Panel } from './Panel.tsx'
import { firstEntry, useStore } from './store.ts'
import { createRenderer } from './viewer/renderer.ts'
import { Viewer } from './viewer/Viewer.tsx'

// ?webgl in the page URL starts with the panel's Use WebGL 2 on
const webglRequested = new URLSearchParams(window.location.search).has('webgl')

// Structures are measured in ångströms and span tens to hundreds of them
const camera = { fov: 50, near: 0.1, far: 5000, position: [0, 0, 60] as const }

function App() {
  const load = useStore((s) => s.load)
  useEffect(() => {
    void load(firstEntry)
  }, [load])

  const [forceWebGL, setForceWebGL] = useState(webglRequested)
  const [renderer, setRenderer] = useState('')
  // The Canvas's key follows the flag, so setting it mounts a new Canvas whose factory forces the fallback, or stops forcing it
  const gl = useCallback(
    ({ canvas }: { canvas: object }) =>
      createRenderer(canvas, forceWebGL, () => setForceWebGL(true), setRenderer),
    [forceWebGL],
  )

  return (
    <>
      <Canvas key={forceWebGL ? 'webgl' : 'webgpu'} gl={gl} camera={camera} flat>
        <Viewer />
      </Canvas>
      <AtomLabel />
      <Panel forceWebGL={forceWebGL} setForceWebGL={setForceWebGL} renderer={renderer} />
    </>
  )
}

export default App
