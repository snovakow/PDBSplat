import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noBounds } from '../src/pdb/bounds.ts'
import type { EntryBatch, LoadReport } from '../src/pdb/entryLoad.ts'
import { buffersOf, type EntryReply, type EntryRequest } from '../src/pdb/entryWorker.ts'
import { EntryCache, fetchEntry, isAbort, mergeEntry, setWorkerMaker, type Loaded } from '../src/pdb/fetchEntry.ts'
import type { MergedLevels } from '../src/pdb/merge.ts'
import { StructureBuilder, type AtomRecord, type ShownChoice } from '../src/pdb/structure.ts'

// The entries kept, bounded by the bytes they hold, and an ID checked before anything loads

const atom: AtomRecord = {
  x: 0,
  y: 0,
  z: 0,
  element: 'C',
  atomName: 'CA',
  altLoc: '',
  occupancy: 1,
  bFactor: 20,
  model: 1,
  chain: 'A',
  labelChain: 'A',
  residueName: 'ALA',
  residueNumber: 1,
  insertion: '',
  hydrogen: false,
  water: false,
  firstConformation: true,
  polymer: true,
}

// An entry of a count of atoms, as a load gives it
function loaded(id: string, atoms: number): Loaded {
  const builder = new StructureBuilder()
  for (let i = 0; i < atoms; i++) builder.add({ ...atom, residueNumber: i })
  const empty = { count: 0, centers: new Float32Array(0), scatters: new Float32Array(0) }
  const choice = { hydrogens: false, waters: false, conformations: 'first', model: 1 } as const
  return { entry: { id, ...builder.finish() }, merged: { choice, residues: empty, chains: empty, layers: null }, bounds: noBounds, burial: null }
}

const bytesOf = (entry: Loaded) => buffersOf(entry).reduce((sum, buffer) => sum + buffer.byteLength, 0)

void test("a message's buffers are each listed once, from every typed array it holds", () => {
  const shared = new Float32Array(8)
  const buffers = buffersOf({ a: shared, b: [shared.subarray(2), new Uint8Array(3)], c: { d: 'text', e: 4 } })
  assert.equal(buffers.length, 2)
  assert.ok(buffers.includes(shared.buffer))
})

void test('the cache keeps the latest entries within its bytes, the earliest going first, and the latest whatever its size', () => {
  const small = loaded('1AAA', 100)
  const other = loaded('1BBB', 100)
  const large = loaded('1CCC', 1000)
  const cache = new EntryCache(bytesOf(small) + bytesOf(other) + 16)
  cache.keep(small)
  cache.keep(other)
  assert.deepEqual(cache.ids(), ['1AAA', '1BBB'])
  // One taken from the cache becomes the latest
  assert.equal(cache.get('1AAA'), small)
  assert.deepEqual(cache.ids(), ['1BBB', '1AAA'])
  // One larger than the bound alone is kept while it's the latest, and goes when another comes
  cache.keep(large)
  assert.deepEqual(cache.ids(), ['1CCC'])
  cache.keep(small)
  assert.deepEqual(cache.ids(), ['1AAA'])
  assert.equal(cache.get('1CCC'), null)
  // Kept again with its burial, the same entry counts its new bytes and stays the latest
  cache.keep(other)
  cache.keep({ ...small, burial: { values: new Float32Array(10_000), low: 0, high: 1 } })
  assert.deepEqual(cache.ids(), ['1AAA'])
})

void test("an ID that isn't four characters starting with a digit is refused before anything loads", async () => {
  const handlers = { progress: () => undefined, arrived: () => undefined, burial: () => undefined }
  const choice = { hydrogens: false, waters: false, conformations: 'first', allModels: false } as const
  await assert.rejects(fetchEntry(' crn1', choice, handlers), {
    message: `" crn1" isn't a PDB ID: those are four characters, starting with a digit`,
  })
  await assert.rejects(fetchEntry('12', choice, handlers), /isn't a PDB ID/)
})

// A stand-in for the loader's worker: what it was asked, whether it was ended, and a way to answer as it would
interface StandIn {
  asked: EntryRequest[]
  ended: boolean
  reply: (reply: EntryReply) => void
}

// Has the loads and merges that follow made by stand-ins, kept in the order they're made
function standIns() {
  const made: StandIn[] = []
  setWorkerMaker((onReply) => {
    const worker: StandIn = { asked: [], ended: false, reply: onReply }
    made.push(worker)
    return {
      ask: (request) => worker.asked.push(request),
      end: () => {
        worker.ended = true
      },
    }
  })
  return made
}

const report: LoadReport = {
  gzipped: true,
  compressed: 100,
  inflated: 500,
  sizing: 'trailer',
  trailer: '500 bytes inflated',
  downloadMilliseconds: 1,
  readMilliseconds: 1,
  milliseconds: 2,
}

// A batch of a few atoms as a load hands it on, the last of its entry where it has a report
function batchOf(atoms: number, last: boolean): EntryBatch {
  const builder = new StructureBuilder()
  for (let i = 0; i < atoms; i++) builder.add({ ...atom, residueNumber: i })
  const empty = { count: 0, centers: new Float32Array(0), scatters: new Float32Array(0) }
  const choice = { hydrogens: false, waters: false, conformations: 'first', model: 1 } as const
  return {
    structure: builder.takeBatch('a test', last),
    merged: { choice, reset: true, residues: { ...empty, from: 0 }, chains: empty },
    bounds: noBounds,
    expected: atoms,
    progress: { received: 0, total: null, atoms },
    answers: null,
    report: last ? report : null,
  }
}

// Levels merged for a choice, as a worker answers
function levelsFor(choice: ShownChoice): MergedLevels {
  const empty = { count: 0, centers: new Float32Array(0), scatters: new Float32Array(0) }
  return { choice, residues: empty, chains: empty, layers: null }
}

const loadChoice = { hydrogens: false, waters: false, conformations: 'first', allModels: false } as const
const shownChoice = (model: number): ShownChoice => ({ hydrogens: false, waters: false, conformations: 'first', model })

void test('a merge asked of a load that a newer load ends is asked again of a worker of its own, and lands', async (t) => {
  t.mock.method(console, 'info', () => undefined)
  const made = standIns()
  const told: { shown: Loaded | null } = { shown: null }
  const handlers = {
    progress: () => undefined,
    arrived: (arrived: Loaded) => {
      told.shown = arrived
    },
    burial: () => undefined,
  }
  const first = fetchEntry('1AAA', loadChoice, handlers)
  first.catch(() => undefined)
  const [loader] = made
  assert.deepEqual(loader.asked.map((request) => request.kind), ['load'])
  // Its first batch makes it the entry shown, and a merge is asked of the load
  loader.reply({ kind: 'batch', batch: batchOf(4, false) })
  const shown = told.shown
  assert.ok(shown)
  const { entry } = shown
  const merging = mergeEntry(entry, shownChoice(1), null)
  assert.equal(loader.asked.at(-1)?.kind, 'merge')
  // A newer load ends the first, whose entry stays shown, and the merge goes to a worker given that entry's columns
  const second = fetchEntry('1BBB', loadChoice, handlers)
  assert.ok(loader.ended)
  assert.equal(made.length, 3)
  const held = made.find((worker) => worker.asked[0]?.kind === 'hold')
  assert.ok(held)
  const asked = held.asked[1]
  assert.ok(asked?.kind === 'merge')
  held.reply({ kind: 'merged', serial: asked.serial, merged: levelsFor(asked.choice) })
  assert.deepEqual((await merging).choice, shownChoice(1))
  // The newer load fails, and the first entry stays with its worker
  const newer = made.find((worker) => worker.asked[0]?.kind === 'load' && worker !== loader)
  newer?.reply({ kind: 'failed', message: 'There\'s no entry 1BBB in the PDB' })
  await assert.rejects(second, /no entry 1BBB/)
  await assert.rejects(first, (error) => isAbort(error))
  setWorkerMaker(null)
})

void test('a merge a newer request superseded still lands where nothing newer has, and one older than a merge landed is dropped', async (t) => {
  t.mock.method(console, 'info', () => undefined)
  const made = standIns()
  const handlers = { progress: () => undefined, arrived: () => undefined, burial: () => undefined }
  const loading = fetchEntry('1CCC', loadChoice, handlers)
  const [worker] = made
  worker.reply({ kind: 'batch', batch: batchOf(3, true) })
  const { entry } = await loading
  const serialOf = (request: EntryRequest | undefined) => (request?.kind === 'merge' ? request.serial : -1)
  // Two asked, the first answered while the second is still to come: the first lands
  const layers = new Uint8Array([0, 1, 2])
  const one = mergeEntry(entry, shownChoice(1), null)
  const two = mergeEntry(entry, shownChoice(2), layers)
  const [askedOne, askedTwo] = worker.asked.slice(-2)
  // The worker is given a copy of the layers
  assert.ok(askedTwo.kind === 'merge' && askedTwo.layers !== layers && askedTwo.layers?.join() === '0,1,2')
  worker.reply({ kind: 'merged', serial: serialOf(askedOne), merged: levelsFor(shownChoice(1)) })
  assert.deepEqual((await one).choice, shownChoice(1))
  // The second lands after it, holding the layers it was asked for
  worker.reply({ kind: 'merged', serial: serialOf(askedTwo), merged: levelsFor(shownChoice(2)) })
  const landed = await two
  assert.deepEqual(landed.choice, shownChoice(2))
  assert.equal(landed.layers, layers)
  // Of two more, the later answered first lands, and the earlier is dropped, its answer coming after changing nothing
  const three = mergeEntry(entry, shownChoice(3), null)
  const four = mergeEntry(entry, shownChoice(4), null)
  const [askedThree, askedFour] = worker.asked.slice(-2)
  worker.reply({ kind: 'merged', serial: serialOf(askedFour), merged: levelsFor(shownChoice(4)) })
  assert.deepEqual((await four).choice, shownChoice(4))
  await assert.rejects(three, (error) => isAbort(error))
  worker.reply({ kind: 'merged', serial: serialOf(askedThree), merged: levelsFor(shownChoice(3)) })
  setWorkerMaker(null)
})
