import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buffersOf } from '../src/pdb/entryWorker.ts'
import { EntryCache, fetchEntry, type Loaded } from '../src/pdb/fetchEntry.ts'
import { StructureBuilder, type AtomRecord } from '../src/pdb/structure.ts'

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
  return { entry: { id, ...builder.finish() }, merged: { choice, residues: empty, chains: empty }, burial: null }
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
  const handlers = { progress: () => undefined, burial: () => undefined }
  const choice = { hydrogens: false, waters: false, conformations: 'first', allModels: false } as const
  await assert.rejects(fetchEntry(' crn1', choice, handlers), {
    message: `" crn1" isn't a PDB ID: those are four characters, starting with a digit`,
  })
  await assert.rejects(fetchEntry('12', choice, handlers), /isn't a PDB ID/)
})
