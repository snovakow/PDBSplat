import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'
import { Viewer } from './viewer/Viewer.tsx'

// ?webgl in the page URL forces WebGPURenderer's WebGL 2 fallback
async function createRenderer({ canvas }: { canvas: object }) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected an HTMLCanvasElement')
  const forceWebGL = new URLSearchParams(window.location.search).has('webgl')
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL })
  await renderer.init()
  console.info(`PDBSplat: rendering with ${'isWebGPUBackend' in renderer.backend ? 'WebGPU' : 'the WebGL 2 fallback'}`)
  return renderer
}

// Structures are measured in ångströms and span tens to hundreds of them
const camera = { fov: 50, near: 0.1, far: 5000, position: [0, 0, 60] as const }

function App() {
  return (
    <Canvas gl={createRenderer} camera={camera} flat>
      <Viewer />
    </Canvas>
  )
}

export default App
