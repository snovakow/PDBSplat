import type { SurfaceInput, SurfaceMesh } from './gaussianSurface.ts'

export interface SurfaceResult {
  mesh: SurfaceMesh
  // How long the worker took to mesh it
  milliseconds: number
}

type Reply = SurfaceResult | { error: string }

interface Job {
  input: SurfaceInput
  resolve: (result: SurfaceResult) => void
  reject: (error: Error) => void
}

// A cancelled mesh may run this long from its start before the worker is cut off for the next one,
// so meshes quicker than this still arrive, and show, while a slider is dragged
const graceMilliseconds = 1000

// Surfaces are meshed off the main thread, one at a time. A newer request replaces one still waiting,
// so dragging a slider meshes the latest value next instead of every step on the way
let worker: Worker | null = null
let running: Job | null = null
let startedAt = 0
let cutoff: ReturnType<typeof setTimeout> | undefined
let waiting: Job | null = null

// Resolves with the mesh, or never settles if it's replaced or cancelled before it starts, or cut off.
// A cancelled request already meshing still resolves if it finishes within its grace
export function requestSurface(input: SurfaceInput) {
  let settle: Pick<Job, 'resolve' | 'reject'> = { resolve: () => undefined, reject: () => undefined }
  const result = new Promise<SurfaceResult>((resolve, reject) => {
    settle = { resolve, reject }
  })
  const job: Job = { input, ...settle }
  waiting = job
  startNext()
  return {
    result,
    cancel: () => {
      if (job === waiting) waiting = null
      else if (job === running) cutOff()
    },
  }
}

function startNext() {
  if (running || !waiting) return
  const job = waiting
  waiting = null
  running = job
  startedAt = performance.now()
  worker ??= createWorker()
  worker.postMessage(job.input)
}

// Ends the running job, and any cut-off waiting on it, and returns the job
function finishRunning() {
  clearTimeout(cutoff)
  cutoff = undefined
  const job = running
  running = null
  return job
}

// Stops the cancelled running job once its grace is up, which a worker can only do by being terminated
function cutOff() {
  const remaining = startedAt + graceMilliseconds - performance.now()
  cutoff ??= setTimeout(() => {
    finishRunning()
    worker?.terminate()
    worker = null
    startNext()
  }, Math.max(0, remaining))
}

function createWorker() {
  const created = new Worker(new URL('./surface.worker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<Reply>) => {
    // A reply already on its way when its worker was cut off belongs to no one
    if (created !== worker) return
    const job = finishRunning()
    if (job) {
      if ('error' in event.data) job.reject(new Error(event.data.error))
      else job.resolve(event.data)
    }
    startNext()
  }
  // A worker that fails to load or crashes fails its job, and the next request starts a new one
  created.onerror = (event) => {
    if (created !== worker) return
    const job = finishRunning()
    created.terminate()
    worker = null
    if (job) job.reject(new Error(event.message || 'the surface worker failed'))
    startNext()
  }
  return created
}
