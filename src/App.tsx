import { Canvas } from '@react-three/fiber'
import { button, useControls } from 'leva'
import { useCallback, useEffect, useState } from 'react'
import { WebGPURenderer } from 'three/webgpu'
import { defaultOptions, firstEntry, isShown, useStore, type ColorBy, type Status } from './store.ts'
import { Viewer } from './viewer/Viewer.tsx'

// ?webgl in the page URL forces WebGPURenderer's WebGL 2 fallback
const webglRequested = new URLSearchParams(window.location.search).has('webgl')

// GPUs that offer WebGPU but can't compile the splat sort's shaders, and take Chrome's GPU process down trying.
// Haswell's Intel Iris (gen-7) fails on CountingSortReset
const failingGPUs = [{ vendor: 'intel', architecture: 'gen-7' }] as const

// The fallback's start is retried while a crashed GPU process restarts, as its WebGL 2 context comes back null till then
const fallbackAttempts = 5
const fallbackRetryDelay = 1000

async function createRenderer(canvas: object, forceWebGL: boolean, fallBack: () => void) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected an HTMLCanvasElement')
  const failingGPU = forceWebGL ? null : await knownFailingGPU()
  if (failingGPU) {
    console.info(`PDBSplat: this GPU (${failingGPU}) is known to fail WebGPU, so starting on the WebGL 2 fallback`)
  }
  const renderer =
    forceWebGL || failingGPU ? await startFallback(canvas) : await new WebGPURenderer({ canvas, antialias: true }).init()
  const webgpu = 'isWebGPUBackend' in renderer.backend
  console.info(`PDBSplat: rendering with ${webgpu ? 'WebGPU' : 'the WebGL 2 fallback'}`)
  if (webgpu) watchForFailure(renderer, fallBack)
  return renderer
}

// Names the adapter if it's in failingGPUs, or returns null
async function knownFailingGPU() {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  // Chrome offered WebGPU before adapter.info, which the DOM library types as always there
  const info = adapter?.info
  if (!info) return null
  const { vendor, architecture } = info
  const failing = failingGPUs.some((gpu) => gpu.vendor === vendor && gpu.architecture === architecture)
  return failing ? `${vendor} ${architecture}` : null
}

async function startFallback(canvas: HTMLCanvasElement) {
  for (let attempt = 1; ; attempt++) {
    const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: true })
    try {
      return await renderer.init()
    } catch (error) {
      // dispose() rethrows the failed init's error and frees nothing, so three's context-lost listener stays on the canvas
      await renderer.dispose().catch(() => undefined)
      if (attempt === fallbackAttempts) throw error
      console.warn(`PDBSplat: the WebGL 2 fallback failed to start (${String(error)}), so retrying`)
      await new Promise((resolve) => setTimeout(resolve, fallbackRetryDelay))
    }
  }
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
    <>
      <Canvas key={forceWebGL ? 'webgl' : 'webgpu'} gl={gl} camera={camera} flat>
        <Viewer />
      </Canvas>
      <Panel />
    </>
  )
}

const statusText: Record<Status, string> = { idle: '', loading: 'Loading…', ready: 'Ready', failed: '' }

// The leva panel: the view options go to the store as they change, and the entry's details come back read-only
function Panel() {
  const id = useStore((s) => s.id)
  const title = useStore((s) => s.title)
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const shown = useStore((s) => s.atoms.filter((atom) => isShown(atom, s.options)).length)

  const [, set] = useControls(() => {
    const { load, setOptions } = useStore.getState()
    return {
      id: { label: 'PDB ID', value: firstEntry },
      Load: button((get) => void load(String(get('id')))),
      colorBy: {
        label: 'Colour by',
        options: ['element', 'chain'] satisfies ColorBy[],
        value: defaultOptions.colorBy,
        onChange: (colorBy: ColorBy) => setOptions({ colorBy }),
      },
      scale: {
        label: 'Size',
        value: defaultOptions.scale,
        min: 0.25,
        max: 2,
        step: 0.05,
        onChange: (scale: number) => setOptions({ scale }),
      },
      opacity: {
        label: 'Opacity',
        value: defaultOptions.opacity,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (opacity: number) => setOptions({ opacity }),
      },
      hydrogens: {
        label: 'Hydrogens',
        value: defaultOptions.hydrogens,
        onChange: (hydrogens: boolean) => setOptions({ hydrogens }),
      },
      waters: {
        label: 'Waters',
        value: defaultOptions.waters,
        onChange: (waters: boolean) => setOptions({ waters }),
      },
      entry: { label: 'Entry', value: '', editable: false },
      shown: { label: 'Atoms shown', value: '', editable: false },
      status: { label: 'Status', value: '', editable: false },
    }
  })

  useEffect(() => {
    set({
      entry: id ? `${id}: ${title}` : '',
      shown: id ? shown.toLocaleString('en') : '',
      status: error ?? statusText[status],
    })
  }, [set, id, title, shown, status, error])

  return null
}

export default App
