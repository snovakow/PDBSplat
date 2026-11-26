import { burialSteps } from './burial.ts'
import { LoadError, loadEntry } from './entryLoad.ts'
import { buffersOf, type EntryReply, type EntryRequest } from './entryWorker.ts'
import { mergeLevels } from './merge.ts'
import { copyPlaces, type AtomPlaces } from './structure.ts'

// Loads one entry, or holds one handed to it, and answers for it: the structure, whole, sent with its arrays
// transferred, then its burial, worked out a stretch at a time so that a request to merge again is answered between
// stretches. It keeps a copy of the columns that place the atoms, since the structure's own go with it
let places: AtomPlaces | null = null

const post = (reply: EntryReply, transfer: ArrayBuffer[] = []) => self.postMessage(reply, { transfer })

self.onmessage = (event: MessageEvent<EntryRequest>) => {
  const request = event.data
  if (request.kind === 'load') void load(request.id, request.choice)
  else if (request.kind === 'hold') {
    places = request.places
    if (request.burial) void bury()
  } else if (places) {
    const merged = mergeLevels(places, request.choice)
    post({ kind: 'merged', serial: request.serial, merged }, buffersOf(merged))
  }
}

async function load(id: string, choice: Extract<EntryRequest, { kind: 'load' }>['choice']) {
  try {
    const result = await loadEntry(id, choice, {
      fetch: (input, init) => fetch(input, init),
      onProgress: (progress) => post({ kind: 'progress', progress }),
    })
    places = copyPlaces(result.structure)
    post({ kind: 'structure', ...result }, buffersOf([result.structure, result.merged]))
  } catch (error) {
    const message = error instanceof LoadError ? error.message : `Couldn't load ${id}: ${String(error)}`
    post({ kind: 'failed', message })
    return
  }
  await bury()
}

async function bury() {
  if (!places) return
  const start = performance.now()
  const steps = burialSteps(places)
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) {
      post({ kind: 'burial', burial: step.value, milliseconds: performance.now() - start }, buffersOf(step.value))
      return
    }
    // Lets a request to merge again be answered
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
