// The loader's worker as the main thread sees it: what it's asked and what it answers, and one worker's life. A worker
// loads one entry, or is handed one already loaded, and then keeps the columns that place its atoms, so that it can
// work out the entry's burial and merge its levels again under another choice of the atoms shown
import type { Burial } from './burial.ts'
import type { EntryBatch, LoadProgress } from './entryLoad.ts'
import type { LoadChoice, MergedLevels } from './merge.ts'
import type { AtomPlaces, ShownChoice } from './structure.ts'

// What a worker is asked: to load an entry by its checked ID, merging its levels under a choice; to hold an entry's
// columns, and work out its burial where it's asked to; or to merge the levels of the entry it holds under a choice
export type EntryRequest =
  | { kind: 'load'; id: string; choice: LoadChoice }
  | { kind: 'hold'; places: AtomPlaces; burial: boolean }
  | { kind: 'merge'; serial: number; choice: ShownChoice }

// What it answers: the load's progress; each batch of what it has read, the last once the file is read, a request to
// merge again made while it reads answered by a batch's blobs; the burial once it's worked out, with how long that
// took; the levels merged again for the request of that serial once the entry is read; or why the load failed, as the
// page shows it
export type EntryReply =
  | { kind: 'progress'; progress: LoadProgress }
  | { kind: 'batch'; batch: EntryBatch }
  | { kind: 'burial'; burial: Burial; milliseconds: number }
  | { kind: 'merged'; serial: number; merged: MergedLevels }
  | { kind: 'failed'; message: string }

// The buffers of every typed array a value holds, once each, which a message transfers rather than copies
export function buffersOf(value: unknown, found = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) found.add(value.buffer)
  } else if (Array.isArray(value)) {
    for (const item of value) buffersOf(item, found)
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) buffersOf(item, found)
  }
  return [...found]
}

// One worker, which tells its replies to a handler until it's ended. A worker that fails to start or stops answers as
// a failed load would
export class EntryWorker {
  private worker: Worker | null

  constructor(onReply: (reply: EntryReply) => void) {
    const worker = new Worker(new URL('./entry.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<EntryReply>) => {
      // A reply already on its way when its worker was ended belongs to no one
      if (this.worker === worker) onReply(event.data)
    }
    worker.onerror = (event) => {
      if (this.worker !== worker) return
      onReply({ kind: 'failed', message: `The loader stopped${event.message ? `: ${event.message}` : ''}` })
    }
    this.worker = worker
  }

  ask(request: EntryRequest) {
    this.worker?.postMessage(request)
  }

  // Ends the worker, and with it any download it was making, and every reply still to come
  end() {
    this.worker?.terminate()
    this.worker = null
  }
}
