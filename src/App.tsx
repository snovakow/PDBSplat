import { Canvas } from '@react-three/fiber'
import { button, folder, LevaInputs, useControls } from 'leva'
import { useCallback, useEffect, useState } from 'react'
import { WebGPURenderer } from 'three/webgpu'
import {
  defaultOptions,
  examples,
  firstEntry,
  isShown,
  useStore,
  type Blend,
  type ColorBy,
  type Focus,
  type Status,
} from './store.ts'
import { styles, type Style } from './viewer/styles.ts'
import { Viewer } from './viewer/Viewer.tsx'

// ?webgl in the page URL starts with the panel's Use WebGL 2 on
const webglRequested = new URLSearchParams(window.location.search).has('webgl')

// GPUs that offer WebGPU but can't compile the splat sort's shaders, and take Chrome's GPU process down trying.
// Haswell's Intel Iris (gen-7) fails on CountingSortReset
const failingGPUs = [{ vendor: 'intel', architecture: 'gen-7' }] as const

// The fallback's start is retried while a crashed GPU process restarts, as its WebGL 2 context comes back null till then
const fallbackAttempts = 5
const fallbackRetryDelay = 1000

async function createRenderer(
  canvas: object,
  forceWebGL: boolean,
  fallBack: () => void,
  report: (renderer: string) => void,
) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected an HTMLCanvasElement')
  const failingGPU = forceWebGL ? null : await knownFailingGPU()
  if (failingGPU) {
    console.info(`PDBSplat: this GPU (${failingGPU}) is known to fail WebGPU, so starting on the WebGL 2 fallback`)
  }
  const renderer =
    forceWebGL || failingGPU ? await startFallback(canvas) : await new WebGPURenderer({ canvas, antialias: true }).init()
  const webgpu = 'isWebGPUBackend' in renderer.backend
  console.info(`PDBSplat: rendering with ${webgpu ? 'WebGPU' : 'the WebGL 2 fallback'}`)
  // Two quick toggles can leave an unmounted Canvas's renderer finishing last, so only one still on the page reports
  if (canvas.isConnected) report(webgpu ? 'WebGPU' : failingGPU ? 'WebGL 2, as this GPU fails WebGPU' : 'WebGL 2')
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
      <Panel forceWebGL={forceWebGL} setForceWebGL={setForceWebGL} renderer={renderer} />
    </>
  )
}

const statusText: Record<Status, string> = { idle: '', loading: 'Loading…', ready: 'Ready', failed: '' }

// Each example as the panel lists it, such as "1CRN crambin"
const exampleOptions = Object.fromEntries(examples.map((example) => [`${example.id} ${example.name}`, example.id]))

// The full paths in the panel of the controls that others show for, as a render test reads nothing from a bare key
// inside a folder
const stylePath = 'Look.style'
const focusPath = 'Atoms.focus'
const bloomPath = 'Scene.bloom'

// The Colour by, Focus and Blend choices, each by its label in the panel
const colorByOptions = {
  element: 'element',
  chain: 'chain',
  'B-factor': 'bfactor',
  rainbow: 'rainbow',
} satisfies Record<string, ColorBy>
const focusOptions = { all: 'all', ligands: 'ligands', backbone: 'backbone' } satisfies Record<string, Focus>
const blendOptions = { normal: 'normal', glow: 'glow' } satisfies Record<string, Blend>

interface PanelProps {
  forceWebGL: boolean
  setForceWebGL: (forceWebGL: boolean) => void
  // Which backend is drawing, and why when the GPU is known to fail WebGPU
  renderer: string
}

// The leva panel: the view options go to the store as they change, and the entry's details come back read-only.
// The Example and Use WebGL 2 handlers act only on changes made in the panel, so the values set below don't echo back
function Panel({ forceWebGL, setForceWebGL, renderer }: PanelProps) {
  const id = useStore((s) => s.id)
  const title = useStore((s) => s.title)
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const shown = useStore((s) => s.atoms.filter((atom) => isShown(atom, s.options)).length)

  const [, set] = useControls(() => {
    const { load, setOptions } = useStore.getState()
    return {
      example: {
        label: 'Example',
        options: exampleOptions,
        value: firstEntry,
        onChange: (example: string, _path, { fromPanel }) => {
          if (fromPanel) void load(example)
        },
      },
      // Without the type, leva takes an ID like 1CRN for the number 1 with the unit CRN, as in 10px
      id: { label: 'PDB ID', value: firstEntry, type: LevaInputs.STRING },
      Load: button((get) => void load(String(get('id')))),
      Look: folder({
        style: {
          label: 'Style',
          options: Object.fromEntries(styles.map((style) => [style.label, style.id])),
          value: defaultOptions.style,
          onChange: (style: Style) => setOptions({ style }),
        },
        resolution: {
          label: 'Resolution',
          value: defaultOptions.resolution,
          min: 0.5,
          max: 4,
          step: 0.1,
          // Only the surface has a resolution
          render: (get) => get(stylePath) === 'surface',
          onChange: (resolution: number) => setOptions({ resolution }),
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
        hardness: {
          label: 'Hardness',
          value: defaultOptions.hardness,
          min: 0,
          max: 1,
          step: 0.05,
          // Spheres always keep a hard edge
          render: (get) => get(stylePath) === 'soft',
          onChange: (hardness: number) => setOptions({ hardness }),
        },
        shading: {
          label: 'Shading',
          value: defaultOptions.shading,
          min: 0,
          max: 1,
          step: 0.05,
          render: (get) => get(stylePath) === 'spheres',
          onChange: (shading: number) => setOptions({ shading }),
        },
        highlight: {
          label: 'Highlight',
          value: defaultOptions.highlight,
          min: 0,
          max: 1,
          step: 0.05,
          render: (get) => get(stylePath) === 'spheres',
          onChange: (highlight: number) => setOptions({ highlight }),
        },
        shininess: {
          label: 'Shininess',
          value: defaultOptions.shininess,
          min: 1,
          max: 64,
          step: 1,
          render: (get) => get(stylePath) === 'spheres',
          onChange: (shininess: number) => setOptions({ shininess }),
        },
        outline: {
          label: 'Outline',
          value: defaultOptions.outline,
          min: 0,
          max: 0.3,
          step: 0.01,
          render: (get) => get(stylePath) === 'spheres',
          onChange: (outline: number) => setOptions({ outline }),
        },
        // Blending acts on splats, so the surface leaves it out
        blend: {
          label: 'Blend',
          options: blendOptions,
          value: defaultOptions.blend,
          render: (get) => get(stylePath) !== 'surface',
          onChange: (blend: Blend) => setOptions({ blend }),
        },
      }),
      Colour: folder({
        colorBy: {
          label: 'Colour by',
          options: colorByOptions,
          value: defaultOptions.colorBy,
          onChange: (colorBy: ColorBy) => setOptions({ colorBy }),
        },
        burial: {
          label: 'Burial',
          value: defaultOptions.burial,
          min: 0,
          max: 1,
          step: 0.05,
          onChange: (burial: number) => setOptions({ burial }),
        },
      }),
      Atoms: folder({
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
        // Thermal, Focus and Fade act on splats, so the surface leaves them out
        thermal: {
          label: 'Thermal',
          value: defaultOptions.thermal,
          min: 0,
          max: 3,
          step: 0.05,
          render: (get) => get(stylePath) !== 'surface',
          onChange: (thermal: number) => setOptions({ thermal }),
        },
        focus: {
          label: 'Focus',
          options: focusOptions,
          value: defaultOptions.focus,
          render: (get) => get(stylePath) !== 'surface',
          onChange: (focus: Focus) => setOptions({ focus }),
        },
        fade: {
          label: 'Fade',
          value: defaultOptions.fade,
          min: 0,
          max: 1,
          step: 0.05,
          render: (get) => get(stylePath) !== 'surface' && get(focusPath) !== 'all',
          onChange: (fade: number) => setOptions({ fade }),
        },
      }),
      Scene: folder({
        depthCue: {
          label: 'Depth cue',
          value: defaultOptions.depthCue,
          min: 0,
          max: 1,
          step: 0.05,
          onChange: (depthCue: number) => setOptions({ depthCue }),
        },
        bloom: {
          label: 'Bloom',
          value: defaultOptions.bloom,
          min: 0,
          max: 3,
          step: 0.05,
          onChange: (bloom: number) => setOptions({ bloom }),
        },
        // Bloom's spread and threshold matter only while it's on. They show just below it, which says what they belong
        // to, so their labels stay short enough for the panel's label column
        bloomRadius: {
          label: 'Radius',
          value: defaultOptions.bloomRadius,
          min: 0,
          max: 1,
          step: 0.05,
          render: (get) => get(bloomPath) > 0,
          onChange: (bloomRadius: number) => setOptions({ bloomRadius }),
        },
        bloomThreshold: {
          label: 'Threshold',
          value: defaultOptions.bloomThreshold,
          min: 0,
          max: 1,
          step: 0.01,
          render: (get) => get(bloomPath) > 0,
          onChange: (bloomThreshold: number) => setOptions({ bloomThreshold }),
        },
      }),
      Info: folder({
        webgl: {
          label: 'Use WebGL 2',
          value: forceWebGL,
          // Inside a folder, leva's types leave a transient control out of set, which the effect below calls with it
          transient: false,
          onChange: (webgl: boolean, _path, { fromPanel }) => {
            if (fromPanel) setForceWebGL(webgl)
          },
        },
        renderer: { label: 'Renderer', value: '', editable: false },
        entry: { label: 'Entry', value: '', editable: false },
        shown: { label: 'Atoms shown', value: '', editable: false },
        status: { label: 'Status', value: '', editable: false },
      }),
    }
  })

  // Once an entry has loaded, the ID field shows it, and so does the example list if it's one of the examples
  useEffect(() => {
    if (!id) return
    set(examples.some((example) => example.id === id) ? { id, example: id } : { id })
  }, [set, id])

  // The checkbox follows the flag, which a WebGPU failure also sets
  useEffect(() => {
    set({ webgl: forceWebGL, renderer: renderer || 'Starting…' })
  }, [set, forceWebGL, renderer])

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
