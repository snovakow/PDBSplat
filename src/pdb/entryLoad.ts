// An entry loaded from the RCSB as it downloads: its file fetched gzipped, the compressed bytes counted as they come
// for the progress, inflated and read a chunk at a time, and its residues and chains merged as they close. The fetch
// is a plain GET, with no header but a simple range, so that the RCSB, which refuses the preflight any other request
// would need, answers it from any page
import { StreamMerge, type LoadChoice, type MergedLevels } from './merge.ts'
import { MmcifReader } from './mmcif.ts'
import type { Structure } from './structure.ts'

// Where the RCSB's file server keeps every entry, which lets any site fetch its files
const fileServer = 'https://files.rcsb.org/download/'

// The bytes of an atom table's row, about, by which the inflated size sizes the structure's columns, and how many times
// its compressed size a file inflates to, about, when that's all there is to go on: 9FQR's 533 MB inflate from 102 MB
// and hold 4.5 million atoms, 36ZA's 1.2 GB from 250 MB and hold 11.2 million
const bytesPerAtom = 102
const inflation = 5

// How often the progress is told, in milliseconds
const progressEvery = 100

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
  report: LoadReport
}

// A load's failure, with its message as the page shows it
export class LoadError extends Error {}

export interface LoadOptions {
  // The fetch to use, the page's own or a test's
  fetch: typeof fetch
  onProgress?: (progress: LoadProgress) => void
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
  const tell = () => options.onProgress?.({ received: gzipped ? received : inflatedBytes, total, atoms: reader.atomCount })
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
    if (after - told >= progressEvery) {
      told = after
      tell()
    }
  }
  read = true
  tell()

  let structure: Structure
  try {
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
  return { structure, merged: merge.finish(), report }
}
