import { parseMmcif, type Structure } from './mmcif.ts'

// Four characters, starting with a digit, such as 1CRN
const idPattern = /^[0-9][A-Z0-9]{3}$/

export interface Entry extends Structure {
  id: string
}

const cache = new Map<string, Entry>()
let controller: AbortController | null = null

// A new request aborts the one before it, so a slow response can't overwrite a newer entry.
// An aborted request rejects with an AbortError; any other failure is an Error with a message to show
export async function fetchEntry(input: string): Promise<Entry> {
  controller?.abort()
  controller = null

  const id = input.trim().toUpperCase()
  if (!idPattern.test(id)) throw new Error(`"${input}" isn't a PDB ID: those are four characters, starting with a digit`)
  const cached = cache.get(id)
  if (cached) return cached

  const own = new AbortController()
  controller = own
  const { signal } = own

  let response: Response
  try {
    // The RCSB's file server lets any site fetch its files
    response = await fetch(`https://files.rcsb.org/download/${id}.cif`, { signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`Couldn't reach the RCSB to fetch ${id}: check the network connection`, { cause: error })
  }
  if (response.status === 404) throw new Error(`There's no entry ${id} in the PDB`)
  if (!response.ok) throw new Error(`The RCSB couldn't send ${id} (HTTP ${response.status})`)

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`The download of ${id} broke off: check the network connection`, { cause: error })
  }
  signal.throwIfAborted()

  let entry: Entry
  try {
    entry = { id, ...parseMmcif(text) }
  } catch (error) {
    throw new Error(`Couldn't read ${id}'s mmCIF file: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  cache.set(id, entry)
  if (controller === own) controller = null
  return entry
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
