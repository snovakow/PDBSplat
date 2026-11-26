// An entry by its PDB ID: the ID checked, the entry taken from those loaded lately where it's there, and otherwise
// loaded by a worker of its own, which the next load ends, so that a superseded load's download dies with it. The
// worker that delivered the entry shown, or one handed it later, works out its burial and merges its levels again
import type { Burial } from './burial.ts'
import type { LoadProgress, LoadReport } from './entryLoad.ts'
import { buffersOf, EntryWorker, type EntryReply } from './entryWorker.ts'
import type { LoadChoice, MergedLevels } from './merge.ts'
import { copyPlaces, type ShownChoice, type Structure } from './structure.ts'

// Four characters, starting with a digit, such as 1CRN
const idPattern = /^[0-9][A-Z0-9]{3}$/

export interface Entry extends Structure {
  id: string
}

// An entry as a load gives it: the entry, its levels merged under the choice the load was given, and its burial, or
// null until it's worked out, which then comes by the handler
export interface Loaded {
  entry: Entry
  merged: MergedLevels
  burial: Burial | null
}

export interface LoadHandlers {
  progress: (progress: LoadProgress) => void
  burial: (entry: Entry, burial: Burial) => void
}

// The bytes the entries kept may hold all told, the one shown among them, though one larger than this alone is kept
// while it's shown: room for every example and a few large entries, such as a ribosome's or the axoneme 9FQR's, but
// not for a giant beside them, so that no giant is kept for the page's life
export const cacheBytes = 256 * 2 ** 20

// An entry kept: what a load gave, and the bytes its arrays hold
interface Kept {
  loaded: Loaded
  bytes: number
}

function bytesOf(loaded: Loaded) {
  return buffersOf(loaded).reduce((sum, buffer) => sum + buffer.byteLength, 0)
}

// The entries kept, by their IDs, the latest last: an entry kept again moves to the end, and the earliest go once the
// bytes are over the bound, though never the latest
export class EntryCache {
  private readonly kept = new Map<string, Kept>()
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  get(id: string): Loaded | null {
    const kept = this.kept.get(id)
    if (!kept) return null
    this.kept.delete(id)
    this.kept.set(id, kept)
    return kept.loaded
  }

  // Keeps an entry as the latest, or the same entry again with what's been added to it since
  keep(loaded: Loaded) {
    const { id } = loaded.entry
    this.kept.delete(id)
    this.kept.set(id, { loaded, bytes: bytesOf(loaded) })
    let total = 0
    for (const { bytes } of this.kept.values()) total += bytes
    for (const [earliest, { bytes }] of this.kept) {
      if (total <= this.limit || earliest === id) break
      this.kept.delete(earliest)
      total -= bytes
    }
  }

  // The IDs kept, the earliest first
  ids() {
    return [...this.kept.keys()]
  }
}

const cache = new EntryCache(cacheBytes)

// The load under way, which a new load supersedes, and the entry last delivered, with its worker while it has one
let loading: { worker: EntryWorker; reject: (error: Error) => void } | null = null
let shown: { entry: Entry; worker: EntryWorker | null; handlers: LoadHandlers } | null = null

// The merges asked of the shown entry's worker, by their serials, of which only the latest is answered
let merging: { serial: number; resolve: (merged: MergedLevels) => void; reject: (error: Error) => void } | null = null
let serials = 0

function aborted() {
  return new DOMException('A newer load superseded this one', 'AbortError')
}

// Ends the shown entry's worker, as another entry takes its place
function releaseShown() {
  shown?.worker?.end()
  merging?.reject(aborted())
  merging = null
}

// A worker given the shown entry's columns, where it has none, to work out its burial or merge its levels
function workerFor(current: NonNullable<typeof shown>, burial: boolean) {
  if (current.worker) return current.worker
  const worker = new EntryWorker((reply) => answer(current, reply))
  current.worker = worker
  worker.ask({ kind: 'hold', places: copyPlaces(current.entry), burial })
  return worker
}

// What the shown entry's worker answers once its entry is delivered
function answer(current: NonNullable<typeof shown>, reply: EntryReply) {
  if (shown !== current) return
  if (reply.kind === 'burial') {
    const { entry } = current
    const kept = cache.get(entry.id)
    if (kept?.entry === entry) cache.keep({ ...kept, burial: reply.burial })
    console.info(`PDBSplat: burial of ${entry.atoms.count} atoms in ${Math.round(reply.milliseconds)} ms`)
    current.handlers.burial(entry, reply.burial)
  } else if (reply.kind === 'merged') {
    if (merging?.serial !== reply.serial) return
    merging.resolve(reply.merged)
    merging = null
  } else if (reply.kind === 'failed') {
    merging?.reject(new Error(reply.message))
    merging = null
    current.worker?.end()
    current.worker = null
    console.warn(`PDBSplat: ${current.entry.id}: ${reply.message}`)
  }
}

// The entry by its ID, loaded or kept. A newer request ends this one's load, which then rejects with an AbortError;
// any other failure is an Error with a message to show
export function fetchEntry(input: string, choice: LoadChoice, handlers: LoadHandlers): Promise<Loaded> {
  if (loading) {
    loading.worker.end()
    loading.reject(aborted())
    loading = null
  }

  const id = input.trim().toUpperCase()
  if (!idPattern.test(id)) {
    return Promise.reject(new Error(`"${input}" isn't a PDB ID: those are four characters, starting with a digit`))
  }
  const kept = cache.get(id)
  if (kept) {
    releaseShown()
    const current = { entry: kept.entry, worker: null, handlers }
    shown = current
    if (!kept.burial) workerFor(current, true)
    return Promise.resolve(kept)
  }

  return new Promise<Loaded>((resolve, reject) => {
    const worker = new EntryWorker((reply) => {
      if (reply.kind === 'progress') handlers.progress(reply.progress)
      else if (reply.kind === 'structure') {
        loading = null
        releaseShown()
        const entry: Entry = { id, ...reply.structure }
        const loaded: Loaded = { entry, merged: reply.merged, burial: null }
        const current = { entry, worker, handlers }
        shown = current
        cache.keep(loaded)
        logLoad(id, reply.report)
        // From now on the worker answers for the entry shown
        resolve(loaded)
      } else if (shown?.worker === worker) answer(shown, reply)
      else if (reply.kind === 'failed') {
        loading = null
        worker.end()
        reject(new Error(reply.message))
      }
    })
    loading = { worker, reject }
    worker.ask({ kind: 'load', id, choice })
  })
}

// The shown entry's levels merged again under a choice, by its worker. A newer request, or another entry, supersedes
// this one, which then rejects with an AbortError
export function mergeEntry(entry: Structure, choice: ShownChoice): Promise<MergedLevels> {
  const current = shown
  if (!current || current.entry !== entry) return Promise.reject(aborted())
  merging?.reject(aborted())
  return new Promise<MergedLevels>((resolve, reject) => {
    const serial = ++serials
    merging = { serial, resolve, reject }
    workerFor(current, false).ask({ kind: 'merge', serial, choice })
  })
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

// Logs what a load took, in decimal megabytes, and how its columns were sized
function logLoad(id: string, report: LoadReport) {
  const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1)
  const seconds = (milliseconds: number) => (milliseconds / 1000).toFixed(1)
  const sized =
    report.sizing === 'trailer'
      ? 'sized from the gzip trailer'
      : report.sizing === 'late trailer'
        ? 'grown to the gzip trailer once its atoms had started'
        : report.sizing === 'estimate'
          ? `sized from the compressed size (trailer: ${report.trailer})`
          : 'grown as it was read'
  console.info(
    `PDBSplat: ${id} loaded in ${seconds(report.milliseconds)} s: ` +
      `${megabytes(report.compressed)} MB ${report.gzipped ? 'gzipped' : 'encoded'} downloaded in ` +
      `${seconds(report.downloadMilliseconds)} s, ${megabytes(report.inflated)} MB read in ` +
      `${seconds(report.readMilliseconds)} s of work; ${sized}`,
  )
}
