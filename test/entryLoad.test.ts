import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { measureBounds } from '../src/pdb/bounds.ts'
import { atomsIn, inflatedSize, LoadError, loadEntry, type EntryBatch, type LoadProgress, type MergeRequest } from '../src/pdb/entryLoad.ts'
import { buffersOf } from '../src/pdb/entryWorker.ts'
import { MergedGrowth, mergeLevels } from '../src/pdb/merge.ts'
import { parseMmcif } from '../src/pdb/mmcif.ts'
import { defaultAtoms, StructureBuilder, type Structure } from '../src/pdb/structure.ts'

// The load as a worker runs it, against a file server of its own that answers as the RCSB's does: the gzipped file
// with its length, its last four bytes by a range, the plain file where there's no gzipped one, and the failures

const text = [
  'data_1ABC',
  '_struct.title "A small test entry"',
  'loop_',
  '_atom_site.group_PDB',
  '_atom_site.id',
  '_atom_site.type_symbol',
  '_atom_site.label_atom_id',
  '_atom_site.label_comp_id',
  '_atom_site.label_asym_id',
  '_atom_site.label_seq_id',
  '_atom_site.Cartn_x',
  '_atom_site.Cartn_y',
  '_atom_site.Cartn_z',
  '_atom_site.auth_seq_id',
  '_atom_site.auth_asym_id',
  '_atom_site.pdbx_PDB_model_num',
  ...Array.from({ length: 400 }, (_, i) => `ATOM ${i + 1} C CA ALA A ${i + 1} ${i * 1.5} ${i % 7} ${i % 5} ${i + 1} A 1`),
  '#',
  '',
].join('\n')
const plain = new TextEncoder().encode(text)
const gzipped = new Uint8Array(gzipSync(plain))

const choice = { hydrogens: false, waters: false, conformations: 'first', allModels: false } as const

// How the server answers: the files it has, how it answers a range, and how its downloads fail
interface Server {
  gz?: Uint8Array | null
  cif?: Uint8Array | null
  range?: 'answer' | 'refuse' | 'whole' | 'throw' | 'small' | 'held'
  // For a held range, what it waits for before it answers with this inflated size
  hold?: Promise<void>
  heldSize?: number
  status?: number
  offline?: boolean
  breakAfter?: number
}

// A request as the server saw it: its URL and its headers
interface Seen {
  url: string
  method: string
  headers: Record<string, string>
}

// A fetch served from memory, in chunks of a kilobyte. The gzipped file's body waits until any range read of it has
// been answered, so that the trailer comes before the atom table, as it does from the RCSB
function serve(server: Server) {
  const seen: Seen[] = []
  let answered: () => void = () => undefined
  const rangeAnswered = new Promise<void>((resolve) => {
    answered = resolve
  })
  const body = (bytes: Uint8Array, wait: Promise<void>) => {
    let at = 0
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        await wait
        if (server.breakAfter !== undefined && at >= server.breakAfter) {
          controller.error(new TypeError('network error'))
          return
        }
        if (at >= bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(at, at + 1024))
        at += 1024
      },
    })
  }
  const get: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    seen.push({ url, method: init?.method ?? 'GET', headers })
    if (server.offline) throw new TypeError('Failed to fetch')
    if (server.status) return new Response('', { status: server.status })
    const file = url.endsWith('.cif.gz') ? server.gz : url.endsWith('.cif') ? server.cif : null
    if (!file) return new Response('', { status: 404 })
    const range = headers.range
    if (range) {
      const answer = server.range ?? 'answer'
      setTimeout(answered, 5)
      if (answer === 'throw') throw new TypeError('Failed to fetch')
      if (answer === 'refuse') return new Response('', { status: 403 })
      if (answer === 'whole') return new Response(body(file, Promise.resolve()), { status: 200 })
      if (answer === 'small') return new Response(new Uint8Array([1, 0, 0, 0]), { status: 206 })
      if (answer === 'held') {
        await server.hold
        const size = server.heldSize ?? 0
        return new Response(new Uint8Array([size & 255, (size >> 8) & 255, (size >> 16) & 255, size >>> 24]), { status: 206 })
      }
      const [first, last] = range.replace('bytes=', '').split('-').map(Number)
      return new Response(file.slice(first, last + 1), { status: 206 })
    }
    const wait = url.endsWith('.gz') && server.range !== 'held' ? rangeAnswered : Promise.resolve()
    return new Response(body(file, wait), { headers: { 'content-length': String(file.length) } })
  }
  return { get, seen }
}

void test('an entry loads gzipped, its compressed bytes counted against their length, its columns sized from the trailer', async () => {
  const { get, seen } = serve({ gz: gzipped })
  const progress: LoadProgress[] = []
  const { structure, merged, report } = await loadEntry('1ABC', choice, { fetch: get, onProgress: (p) => progress.push(p) })
  assert.deepEqual(structure, parseMmcif(text))
  assert.equal(merged.residues.count, 400)
  assert.equal(merged.chains.count, 1)
  assert.equal(report.sizing, 'trailer')
  assert.equal(report.compressed, gzipped.length)
  assert.equal(report.inflated, plain.length)
  assert.deepEqual(progress.at(-1), { received: gzipped.length, total: gzipped.length, atoms: 400 })
  // Two GETs of the gzipped file, the second for its last four bytes by their places from the start, and no header but
  // that range, so that no request needs a preflight
  assert.deepEqual(seen, [
    { url: 'https://files.rcsb.org/download/1ABC.cif.gz', method: 'GET', headers: {} },
    {
      url: 'https://files.rcsb.org/download/1ABC.cif.gz',
      method: 'GET',
      headers: { range: `bytes=${gzipped.length - 4}-${gzipped.length - 1}` },
    },
  ])
})

void test('a ranged read that fails, is refused, gets the whole file or gives too small a size changes nothing but the sizing', async () => {
  for (const range of ['refuse', 'whole', 'throw', 'small'] as const) {
    const { get } = serve({ gz: gzipped, range })
    const { structure, report } = await loadEntry('1ABC', choice, { fetch: get })
    assert.deepEqual(structure, parseMmcif(text), range)
    assert.equal(report.sizing, 'estimate', range)
  }
})

void test('a trailer that answers once the whole file is read is only noted, and grows nothing', async () => {
  let release: () => void = () => undefined
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  // A trailer of more than the estimate, which would grow the columns, held until the structure is handed on
  const { get } = serve({ gz: gzipped, range: 'held', hold, heldSize: 100_000_000 })
  const { structure, report } = await loadEntry('1ABC', choice, { fetch: get })
  assert.equal(report.sizing, 'estimate')
  // The structure's arrays are handed on, as the worker hands them to the page, before the trailer answers, which then
  // changes nothing and fails nowhere
  const handed = structuredClone(structure, { transfer: buffersOf(structure) })
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(handed, parseMmcif(text))
})

void test("the trailer's size is used only where it's at least the compressed size, as it's kept modulo 2³²", () => {
  assert.equal(inflatedSize(new Uint8Array([0x10, 0x27, 0, 0]), 100), 10000)
  // 36ZA's trailer, which gives its 1.2 GB beside 250 MB compressed
  assert.equal(inflatedSize(new Uint8Array([0x81, 0xd0, 0x66, 0x47]), 250419102), 1197920385)
  assert.equal(inflatedSize(new Uint8Array([1, 0, 0, 0]), 100), null)
  assert.equal(inflatedSize(new Uint8Array([1, 0, 0]), 0), null)
  assert.equal(atomsIn(1020), 10)
})

void test('without a gzipped file the plain one is read, its progress by atoms alone', async () => {
  const { get, seen } = serve({ gz: null, cif: plain })
  const progress: LoadProgress[] = []
  const { structure, report } = await loadEntry('1ABC', choice, { fetch: get, onProgress: (p) => progress.push(p) })
  assert.deepEqual(structure, parseMmcif(text))
  assert.equal(report.gzipped, false)
  assert.equal(report.sizing, 'none')
  assert.equal(progress.at(-1)?.total, null)
  assert.equal(progress.at(-1)?.atoms, 400)
  assert.deepEqual(
    seen.map((request) => request.url),
    ['https://files.rcsb.org/download/1ABC.cif.gz', 'https://files.rcsb.org/download/1ABC.cif'],
  )
})

void test('a missing entry, a failed request, no network, a broken download and an unreadable file each give their message', async () => {
  const failure = async (server: Server, message: string | RegExp) => {
    const { get } = serve(server)
    await assert.rejects(loadEntry('1ABC', choice, { fetch: get }), (error: unknown) => {
      assert.ok(error instanceof LoadError)
      if (typeof message === 'string') assert.equal(error.message, message)
      else assert.match(error.message, message)
      return true
    })
  }
  await failure({ gz: null, cif: null }, "There's no entry 1ABC in the PDB")
  await failure({ status: 500 }, "The RCSB couldn't send 1ABC (HTTP 500)")
  await failure({ offline: true }, "Couldn't reach the RCSB to fetch 1ABC: check the network connection")
  await failure({ gz: gzipped, breakAfter: 2048 }, 'The download of 1ABC broke off: check the network connection')
  await failure({ gz: null, cif: plain, breakAfter: 2048 }, 'The download of 1ABC broke off: check the network connection')
  await failure({ gz: plain }, /^Couldn't read 1ABC's mmCIF file: /)
  const noAtoms = new Uint8Array(gzipSync(new TextEncoder().encode('data_1ABC\n_struct.title x\n')))
  await failure({ gz: noAtoms }, "Couldn't read 1ABC's mmCIF file: The file has no atom table")
})

// The structure's tables but for its arrival, which one appended from batches has and one read whole hasn't
const tableKeys = ['title', 'models', 'atoms', 'residues', 'runs', 'chains', 'tensors', 'forms', 'elements', 'atomNames', 'residueNames', 'insertions', 'altLocs', 'tallies'] as const
function sameTables(a: Structure, b: Structure, label: string) {
  for (const key of tableKeys) assert.deepEqual(a[key], b[key], `${label}: ${key}`)
}

void test('an entry is handed on in batches, each at a residue start, which append to the structure read whole', async () => {
  const whole = parseMmcif(text)
  const exact = measureBounds(whole, defaultAtoms(whole))
  // A clock that makes every chunk's batch due, one that makes a few due, and one that leaves the last batch alone
  for (const step of [400, 40, 0]) {
    const { get } = serve({ gz: gzipped })
    let clock = 0
    const batches: EntryBatch[] = []
    const result = await loadEntry('1ABC', choice, {
      fetch: get,
      now: () => (clock += step),
      leastBatch: 0,
      onBatch: (batch) => batches.push(structuredClone(batch)),
    })
    const builder = new StructureBuilder(1)
    const growth = new MergedGrowth()
    for (const batch of batches) {
      builder.append(batch.structure, batch.expected)
      growth.append(batch.merged, 0)
      const snapshot = builder.snapshot()
      // Every batch's bounds are those of the default atoms so far, the angle within rounding, and the last's the
      // whole's, exactly
      const arrived = measureBounds(snapshot, defaultAtoms(snapshot))
      assert.deepEqual(batch.bounds.center, arrived.center, `${step}`)
      if (batch.report) assert.equal(batch.bounds.radius, arrived.radius, `${step}`)
      else assert.ok(batch.bounds.radius >= arrived.radius && batch.bounds.radius <= arrived.radius * (1 + 1e-8), `${step}`)
      assert.ok(Math.abs(batch.bounds.broadside - arrived.broadside) < 1e-9, `${step}`)
    }
    assert.ok(step === 0 ? batches.length === 1 : batches.length > 1, `${step}: ${batches.length} batches`)
    sameTables(builder.snapshot(), whole, `${step}`)
    assert.deepEqual(result.structure, whole)
    assert.deepEqual(batches.at(-1)?.bounds, exact)
    assert.deepEqual(result.bounds, exact)
    // The last batch alone says what the load took
    assert.deepEqual(batches.map((batch) => batch.report !== null), batches.map((_, i) => i === batches.length - 1))
    const merged = growth.snapshot()
    const reference = mergeLevels(whole, { hydrogens: false, waters: false, conformations: 'first', model: 1 })
    assert.equal(merged?.residues.count, reference.residues.count)
    assert.deepEqual(merged?.residues.centers, reference.residues.centers)
    assert.deepEqual(merged?.residues.scatters, reference.residues.scatters)
    assert.deepEqual(merged?.chains, reference.chains)
  }
})

void test('a request to merge again while the entry is read is answered by the next batch, the levels merged afresh', async () => {
  const whole = parseMmcif(text)
  const { get } = serve({ gz: gzipped })
  let clock = 0
  const batches: EntryBatch[] = []
  const requests: { pending: MergeRequest | null } = { pending: null }
  const asked = { hydrogens: true, waters: true, conformations: 'all', model: null } as const
  await loadEntry('1ABC', choice, {
    fetch: get,
    now: () => (clock += 400),
    leastBatch: 0,
    requests,
    onBatch: (batch) => {
      batches.push(structuredClone(batch))
      if (batches.length === 3) requests.pending = { serial: 7, choice: asked, layers: null }
    },
  })
  assert.ok(batches.length > 4)
  assert.deepEqual(batches.map((batch) => batch.answers), batches.map((_, i) => (i === 3 ? 7 : null)))
  assert.deepEqual(batches.map((batch) => batch.merged.reset), batches.map((_, i) => i === 0 || i === 3))
  const growth = new MergedGrowth()
  for (const batch of batches) growth.append(batch.merged, 0)
  const merged = growth.snapshot()
  assert.deepEqual(merged?.choice, asked)
  const reference = mergeLevels(whole, asked)
  assert.deepEqual(merged?.residues.centers, reference.residues.centers)
  assert.deepEqual(merged?.chains, reference.chains)
})

void test('a request to merge again by layers while the entry is read waits for all of it, no batch answering it', async () => {
  const { get } = serve({ gz: gzipped })
  let clock = 0
  const batches: EntryBatch[] = []
  const requests: { pending: MergeRequest | null } = { pending: null }
  const asked = { hydrogens: true, waters: true, conformations: 'all', model: null } as const
  await loadEntry('1ABC', choice, {
    fetch: get,
    now: () => (clock += 400),
    leastBatch: 0,
    requests,
    onBatch: (batch) => {
      batches.push(batch)
      if (batches.length === 2) requests.pending = { serial: 9, choice: asked, layers: new Uint8Array(4) }
    },
  })
  assert.ok(batches.length > 4)
  // Nothing answers it, and the levels go on merged in one layer, under the load's own choice
  assert.ok(batches.every((batch, i) => batch.answers === null && batch.merged.reset === (i === 0)))
  assert.equal(requests.pending?.serial, 9)
})

void test('an entry of fewer atoms than a batch holds arrives in one batch, however slowly it comes', async () => {
  const { get } = serve({ gz: gzipped })
  let clock = 0
  const batches: EntryBatch[] = []
  await loadEntry('1ABC', choice, { fetch: get, now: () => (clock += 400), onBatch: (batch) => batches.push(batch) })
  assert.equal(batches.length, 1)
  assert.ok(batches[0].report)
  assert.equal(batches[0].structure.atoms.count, 400)
})
