import type { PackedField, SurfaceInput, SurfaceMesh } from './gaussianSurface.ts'

// What the worker is asked for, on one set of atoms: their surface meshed, or their density sampled on the grid and
// packed for the field's textures
export type SurfaceRequest = { kind: 'mesh'; input: SurfaceInput } | { kind: 'field'; input: SurfaceInput }

export interface SurfaceResult {
  mesh: SurfaceMesh
  // How long the worker took to mesh it
  milliseconds: number
}

export interface FieldResult {
  field: PackedField
  // How long the worker took to sample and pack it
  milliseconds: number
}

// The worker's answer, of the kind it was asked for
type Answer = ({ kind: 'mesh' } & SurfaceResult) | ({ kind: 'field' } & FieldResult)

// The worker's reply: its answer, or why it failed
export type SurfaceReply = Answer | { error: string }

interface Job {
  request: SurfaceRequest
  resolve: (answer: Answer) => void
  reject: (error: Error) => void
}

// A cancelled job may run this long from its start before the worker is cut off for the next one,
// so meshes and fields quicker than this still arrive, and show, while a slider is dragged
const graceMilliseconds = 1000

// Surfaces are meshed and fields sampled off the main thread, one at a time. A newer request replaces one still
// waiting, so dragging a slider meshes or samples the latest value next instead of every step on the way
let worker: Worker | null = null
let running: Job | null = null
let startedAt = 0
let cutoff: ReturnType<typeof setTimeout> | undefined
let waiting: Job | null = null

// Resolves with the mesh, or never settles if it's replaced or cancelled before it starts, or cut off.
// A cancelled request already meshing still resolves if it finishes within its grace
export function requestSurface(input: SurfaceInput) {
  const { result, cancel } = request({ kind: 'mesh', input })
  return { result: result.then(asMesh), cancel }
}

// Resolves with the packed field, on the same queue and terms as a surface
export function requestField(input: SurfaceInput) {
  const { result, cancel } = request({ kind: 'field', input })
  return { result: result.then(asField), cancel }
}

// The worker answers each request with its own kind, so any other answer is a fault
function asMesh(answer: Answer): SurfaceResult {
  if (answer.kind !== 'mesh') throw new Error('the surface worker answered a mesh request with a field')
  return answer
}

function asField(answer: Answer): FieldResult {
  if (answer.kind !== 'field') throw new Error('the surface worker answered a field request with a mesh')
  return answer
}

function request(message: SurfaceRequest) {
  let settle: Pick<Job, 'resolve' | 'reject'> = { resolve: () => undefined, reject: () => undefined }
  const result = new Promise<Answer>((resolve, reject) => {
    settle = { resolve, reject }
  })
  const job: Job = { request: message, ...settle }
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
  worker.postMessage(job.request)
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
  created.onmessage = (event: MessageEvent<SurfaceReply>) => {
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
