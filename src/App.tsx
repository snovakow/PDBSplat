import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useState } from 'react'
import { WebGPURenderer } from 'three/webgpu'
import { firstEntry, useStore } from './store.ts'
import { Viewer } from './viewer/Viewer.tsx'

// ?webgl in the page URL forces WebGPURenderer's WebGL 2 fallback
const webglRequested = new URLSearchParams(window.location.search).has('webgl')

async function createRenderer(canvas: object, forceWebGL: boolean, fallBack: () => void) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected an HTMLCanvasElement')
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL })
  await renderer.init()
  const webgpu = 'isWebGPUBackend' in renderer.backend
  console.info(`PDBSplat: rendering with ${webgpu ? 'WebGPU' : 'the WebGL 2 fallback'}`)
  if (webgpu) watchForFailure(renderer, fallBack)
  return renderer
}

// Some GPUs offer WebGPU but can't compile three's shaders, such as the splat sort's on a 2014 Intel Iris.
// A GPUInternalError or a lost device switches to the WebGL 2 fallback; validation errors are bugs, so they don't
function watchForFailure(renderer: WebGPURenderer, fallBack: () => void) {
  const logError = renderer.onError
  const logDeviceLost = renderer.onDeviceLost
  let switching = false
  const switchToWebGL = (reason: string) => {
    if (switching) return
    switching = true
    console.warn(`PDBSplat: ${reason}, so switching to the WebGL 2 fallback`)
    fallBack()
  }

  renderer.onError = (info) => {
    logError.call(renderer, info)
    // @types/three 0.187 types the argument as a string, but three passes { api, type, message, originalEvent }
    const details: unknown = info
    if (typeof details === 'object' && details !== null && 'type' in details && details.type === 'GPUInternalError') {
      switchToWebGL('WebGPU hit a GPUInternalError')
    }
  }
  renderer.onDeviceLost = (info) => {
    logDeviceLost.call(renderer, info)
    switchToWebGL(`the WebGPU device was lost (${info.message})`)
  }
}

// Structures are measured in ångströms and span tens to hundreds of them
const camera = { fov: 50, near: 0.1, far: 5000, position: [0, 0, 60] as const }

function App() {
  const load = useStore((s) => s.load)
  useEffect(() => {
    void load(firstEntry)
  }, [load])

  const [forceWebGL, setForceWebGL] = useState(webglRequested)
  // The Canvas's key follows the flag, so setting it mounts a new Canvas whose factory forces the fallback
  const gl = useCallback(
    ({ canvas }: { canvas: object }) => createRenderer(canvas, forceWebGL, () => setForceWebGL(true)),
    [forceWebGL],
  )

  return (
    <Canvas key={forceWebGL ? 'webgl' : 'webgpu'} gl={gl} camera={camera} flat>
      <Viewer />
    </Canvas>
  )
}

export default App
