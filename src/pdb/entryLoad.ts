// An entry loaded from the RCSB as it downloads: its file fetched gzipped, the compressed bytes counted as they come
// for the progress, inflated and read a chunk at a time, its residues and chains merged as they close, and what has
// been read handed on in batches as it comes, each at a residue's start, with its bounds so far. The fetch is a plain
// GET, with no header but a simple range, so that the RCSB, which refuses the preflight any other request would need,
// answers it from any page
import { measureBounds, RunningBounds, type StructureBounds } from './bounds.ts'
import { StreamMerge, type LoadChoice, type MergedBatch, type MergedLevels } from './merge.ts'
import { MmcifReader } from './mmcif.ts'
import { defaultAtoms, type ShownChoice, type Structure, type StructureBatch } from './structure.ts'

// Where the RCSB's file server keeps every entry, which lets any site fetch its files
const fileServer = 'https://files.rcsb.org/download/'

// The bytes of an atom table's row, about, by which the inflated size sizes the structure's columns, and how many times
// its compressed size a file inflates to, about, when that's all there is to go on: 9FQR's 533 MB inflate from 102 MB
// and hold 4.5 million atoms, 36ZA's 1.2 GB from 250 MB and hold 11.2 million
const bytesPerAtom = 102
const inflation = 5

// How often the progress is told, and how often what has been read is handed on, in milliseconds
const progressEvery = 100
const batchEvery = 300

// How many atoms a batch holds at least: the first, so that an entry of up to as many, every example among them, arrives
// whole however slowly it downloads, and opens on its own framing, and a larger one is first framed on enough of it;
// and each after it, so that where the file is read slowly the batches come less often rather than smaller, and what
// each costs the page and the worker beside its atoms is spent less often
export const batchAtoms = 1 << 16

// How far the load has come: the compressed bytes received and the total, which is null where the file isn't sent
// gzipped, as the fallback to the plain file isn't, and the atoms read
export interface LoadProgress {
  received: number
  total: number | null
  atoms: number
}

// How the structure's columns were sized: from the size the gzip trailer gives, read before the atom table started
// or once it had; from the compressed size, where the trailer couldn't be read or wasn't used; or not at all, where
// the plain file came without its size
export type Sizing = 'trailer' | 'late trailer' | 'estimate' | 'none'

// What a load took: the file read, its compressed and inflated bytes, how its columns were sized and why the trailer
// wasn't used where it wasn't, and how long the download took, the reading took between chunks, and the whole load
export interface LoadReport {
  gzipped: boolean
  compressed: number
  inflated: number
  sizing: Sizing
  trailer: string
  downloadMilliseconds: number
  readMilliseconds: number
  milliseconds: number
}

export interface LoadResult {
  structure: Structure
  merged: MergedLevels
  bounds: StructureBounds
  report: LoadReport
}

// What a load hands on as it reads: the structure's rows and the blobs merged since the batch before, the bounds of
// the default atoms so far, how many atoms the whole entry is expected to hold, the progress, the serial of the
// request to merge again that its blobs answer, if they're merged afresh for one, and on the last batch alone, whose
// bounds are worked out exactly, what the load took
export interface EntryBatch {
  structure: StructureBatch
  merged: MergedBatch
  bounds: StructureBounds
  expected: number
  progress: LoadProgress
  answers: number | null
  report: LoadReport | null
}

// A request to merge the levels again under another choice, which the load takes at its next batch
export interface MergeRequest {
  serial: number
  choice: ShownChoice
}

// A load's failure, with its message as the page shows it
export class LoadError extends Error {}

export interface LoadOptions {
  // The fetch to use, the page's own or a test's
  fetch: typeof fetch
  onProgress?: (progress: LoadProgress) => void
  // Where what has been read is handed on, a batch at a time, the last once the file is read; without it the load
  // gives the structure whole at the end alone
  onBatch?: (batch: EntryBatch) => void
  // A request to merge again, which the load answers at its next batch and then clears
  requests?: { pending: MergeRequest | null }
  // How many atoms a batch holds at least, batchAtoms unless a test asks for fewer
  leastBatch?: number
  now?: () => number
}

// The inflated size, from the last four bytes of a gzip file, its trailer's size of what it holds, modulo 2³². Where
// that comes out below the compressed size it has wrapped past 4 GiB, or the file isn't one member, and isn't used
export function inflatedSize(trailer: Uint8Array, compressed: number) {
  if (trailer.length !== 4) return null
  const size = (trailer[0] | (trailer[1] << 8) | (trailer[2] << 16) | (trailer[3] << 24)) >>> 0
  return size >= compressed ? size : null
}

// How many atoms a file of an inflated size holds, about
export function atomsIn(inflated: number) {
  return Math.ceil(inflated / bytesPerAtom)
}

// Reads the gzip trailer by a ranged GET of its four bytes at their places from the start, the one kind of range that
// needs no preflight. Any failure gives its reason instead, as the size is then estimated
async function readTrailer(get: typeof fetch, url: string, compressed: number): Promise<number | string> {
  try {
    const response = await get(url, { headers: { Range: `bytes=${compressed - 4}-${compressed - 1}` } })
    if (response.status !== 206) {
      await response.body?.cancel()
      return `the ranged read answered ${response.status}`
    }
    const size = inflatedSize(new Uint8Array(await response.arrayBuffer()), compressed)
    return size ?? 'the trailer gave less than the compressed size'
  } catch (error) {
    return `the ranged read failed (${error instanceof Error ? error.message : String(error)})`
  }
}

// Loads an entry by its ID, already checked, merging its levels under a choice as it reads them
export async function loadEntry(id: string, choice: LoadChoice, options: LoadOptions): Promise<LoadResult> {
  const get = options.fetch
  const now = options.now ?? (() => performance.now())
  const start = now()
  const request = async (url: string) => {
    try {
      return await get(url)
    } catch (error) {
      throw new LoadError(`Couldn't reach the RCSB to fetch ${id}: check the network connection`, { cause: error })
    }
  }

  // The gzipped file, or the plain one where there's none, which the server then sends encoded, its bytes counted by
  // the browser alone
  const gzippedUrl = `${fileServer}${id}.cif.gz`
  let response = await request(gzippedUrl)
  let gzipped = true
  if (response.status === 404) {
    await response.body?.cancel()
    gzipped = false
    response = await request(`${fileServer}${id}.cif`)
  }
  if (response.status === 404) throw new LoadError(`There's no entry ${id} in the PDB`)
  if (!response.ok || !response.body) throw new LoadError(`The RCSB couldn't send ${id} (HTTP ${response.status})`)
  const length = Number(response.headers.get('content-length'))
  const total = gzipped && length > 0 ? length : null

  // The columns are sized from the trailer where it answers before the atom table starts, and from the compressed size
  // otherwise; a trailer that answers later grows them to its size
  const merge = new StreamMerge(choice)
  let sizing: Sizing = total === null ? 'none' : 'estimate'
  let trailerAtoms: number | null = null
  // The bytes the whole file inflates to, once the trailer has given them
  let inflatedTotal: number | null = null
  const reader = new MmcifReader({
    capacity: () => trailerAtoms ?? (total === null ? undefined : atomsIn(total * inflation)),
    onAtom: merge,
  })
  let trailer = total === null ? 'not read, as the file came without its compressed size' : 'not answered'
  // Whether every byte has been read, after which a trailer that answers is only noted, as the structure is whole
  let read = false
  if (total !== null && total > 4) {
    void readTrailer(get, gzippedUrl, total).then((answer) => {
      if (typeof answer === 'string' || read) {
        trailer = typeof answer === 'string' ? answer : 'answered once the file was read'
        return
      }
      trailer = `${answer} bytes inflated`
      inflatedTotal = answer
      trailerAtoms = atomsIn(answer)
      sizing = reader.atomsStarted ? 'late trailer' : 'trailer'
      reader.reserve(trailerAtoms)
    })
  }

  // The compressed bytes, counted as they come and written into the inflater, whose output is read. A failure to read
  // them is the download breaking off, where a failure after them is the file's
  const body = response.body.getReader()
  let received = 0
  let brokeOff = false
  let downloaded = 0
  const inflater = gzipped ? new DecompressionStream('gzip') : null
  const inflated = inflater ? inflater.readable.getReader() : body
  if (inflater) {
    const writer = inflater.writable.getWriter()
    void (async () => {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof body.read>>
        try {
          chunk = await body.read()
        } catch (error) {
          brokeOff = true
          await writer.abort(error)
          return
        }
        if (chunk.done) break
        received += chunk.value.length
        try {
          await writer.write(chunk.value)
        } catch {
          // The inflater failed, which its reader reports, or was cancelled, and the download is dropped
          await body.cancel()
          return
        }
      }
      downloaded = now()
      await writer.close().catch(() => undefined)
    })()
  }

  const unreadable = (error: unknown) =>
    new LoadError(`Couldn't read ${id}'s mmCIF file: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  let inflatedBytes = 0
  let reading = 0
  let told = -Infinity
  const progressNow = (): LoadProgress => ({ received: gzipped ? received : inflatedBytes, total, atoms: reader.atomCount })
  const tell = () => options.onProgress?.(progressNow())

  // How many atoms the whole entry is expected to hold: the atoms read so far, in the share of the atom table's bytes
  // read so far, against the bytes the whole file inflates to, as the trailer gives them; until it does, no fewer than
  // the compressed size gives, as what's been inflated so far lags what's been received
  let tableStart = -1
  const expectedAtoms = () => {
    const atoms = reader.atomCount
    if (read || total === null || tableStart < 0) return atoms
    const estimate = inflatedTotal === null ? atomsIn(total * inflation) : 0
    const whole = inflatedTotal ?? total * inflation
    const tableRead = inflatedBytes - tableStart
    if (tableRead <= 0 || whole <= inflatedBytes) return Math.max(atoms, estimate)
    return Math.max(atoms, estimate, Math.round((atoms * (whole - tableStart)) / tableRead))
  }

  // What has been read is handed on at a residue's start once a batch is due, and the last batch once the file ends,
  // with the bounds so far and the levels merged again where that was asked for
  const { onBatch } = options
  const requests = options.requests ?? { pending: null }
  const bounds = new RunningBounds()
  let boundsTaken = 0
  let lastBatch = start
  let batchAsked = false
  const hand = (structureBatch: StructureBatch, last: { bounds: StructureBounds; report: LoadReport } | null) => {
    if (!onBatch) return
    const places = reader.places()
    if (!places) return
    bounds.add(places, boundsTaken, places.atoms.count)
    boundsTaken = places.atoms.count
    let answers: number | null = null
    if (requests.pending) {
      merge.rechoose(requests.pending.choice, places)
      answers = requests.pending.serial
      requests.pending = null
    }
    onBatch({
      structure: structureBatch,
      merged: merge.take(),
      bounds: last?.bounds ?? bounds.bounds(places),
      expected: expectedAtoms(),
      progress: progressNow(),
      answers,
      report: last?.report ?? null,
    })
  }
  const batchAtNextResidue = () => {
    batchAsked = false
    lastBatch = now()
    hand(reader.takeBatch(), null)
  }
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await inflated.read()
    } catch (error) {
      if (brokeOff || !inflater) {
        throw new LoadError(`The download of ${id} broke off: check the network connection`, { cause: error })
      }
      throw unreadable(error)
    }
    if (chunk.done) break
    inflatedBytes += chunk.value.length
    const before = now()
    try {
      reader.feed(chunk.value)
    } catch (error) {
      await inflated.cancel()
      throw unreadable(error)
    }
    const after = now()
    reading += after - before
    if (tableStart < 0 && reader.atomsStarted) tableStart = inflatedBytes - chunk.value.length
    if (after - told >= progressEvery) {
      told = after
      tell()
    }
    const batchDue = after - lastBatch >= batchEvery && reader.atomCount - boundsTaken >= (options.leastBatch ?? batchAtoms)
    if (onBatch && !batchAsked && reader.atomsStarted && (batchDue || (requests.pending && boundsTaken > 0))) {
      batchAsked = true
      reader.callAtNextResidue(batchAtNextResidue)
    }
  }
  read = true
  tell()

  let structure: Structure
  let lastBatchRead: StructureBatch | null = null
  try {
    if (onBatch) lastBatchRead = reader.takeLastBatch()
    structure = reader.finish()
  } catch (error) {
    throw unreadable(error)
  }
  const report: LoadReport = {
    gzipped,
    compressed: gzipped ? received : length,
    inflated: inflatedBytes,
    sizing,
    trailer,
    downloadMilliseconds: (inflater ? downloaded : now()) - start,
    readMilliseconds: reading,
    milliseconds: now() - start,
  }
  // The exact bounds, of the whole structure's default atoms
  const exact = measureBounds(structure, defaultAtoms(structure))
  if (lastBatchRead) hand(lastBatchRead, { bounds: exact, report })
  return { structure, merged: merge.finish(), bounds: exact, report }
}
