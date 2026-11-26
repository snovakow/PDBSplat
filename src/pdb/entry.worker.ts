import { burialSteps } from './burial.ts'
import { LoadError, loadEntry, type MergeRequest } from './entryLoad.ts'
import { buffersOf, type EntryReply, type EntryRequest } from './entryWorker.ts'
import { mergeLevels } from './merge.ts'
import type { AtomPlaces, ShownChoice, Structure } from './structure.ts'

// Loads one entry, or holds one handed to it, and answers for it: what it reads, in batches, each sent with its
// arrays transferred, then its burial, worked out a stretch at a time so that a request to merge again is answered
// between stretches. It keeps the columns of the structure it read that place the atoms, which no batch took, as each
// sent a copy of its rows
let places: AtomPlaces | null = null
// While it reads, the request to merge again that its next batch answers
let requests: { pending: MergeRequest | null } | null = null

const post = (reply: EntryReply, transfer: ArrayBuffer[] = []) => self.postMessage(reply, { transfer })

self.onmessage = (event: MessageEvent<EntryRequest>) => {
  const request = event.data
  if (request.kind === 'load') void load(request.id, request.choice)
  else if (request.kind === 'hold') {
    places = request.places
    if (request.burial) void bury()
  } else if (places) answer(request.serial, request.choice)
  else if (requests) requests.pending = { serial: request.serial, choice: request.choice }
}

function answer(serial: number, choice: ShownChoice) {
  if (!places) return
  const merged = mergeLevels(places, choice)
  post({ kind: 'merged', serial, merged }, buffersOf(merged))
}

async function load(id: string, choice: Extract<EntryRequest, { kind: 'load' }>['choice']) {
  const asked: { pending: MergeRequest | null } = { pending: null }
  requests = asked
  try {
    const result = await loadEntry(id, choice, {
      fetch: (input, init) => fetch(input, init),
      onProgress: (progress) => post({ kind: 'progress', progress }),
      onBatch: (batch) => post({ kind: 'batch', batch }, buffersOf(batch)),
      requests: asked,
    })
    places = placesOf(result.structure)
  } catch (error) {
    const message = error instanceof LoadError ? error.message : `Couldn't load ${id}: ${String(error)}`
    post({ kind: 'failed', message })
    return
  } finally {
    requests = null
  }
  // A request that came once the last batch had gone is answered as any later one is
  const pending: MergeRequest | null = asked.pending
  if (pending) answer(pending.serial, pending.choice)
  await bury()
}

// The columns of a structure that place its atoms, kept without the rest
function placesOf({ models, elements, atoms, residues, runs, chains }: Structure): AtomPlaces {
  const { count, positions, element, flags, residue } = atoms
  return { models, elements, atoms: { count, positions, element, flags, residue }, residues, runs, chains }
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
