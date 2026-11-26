// What the panel's Status reads: while an entry loads, how much of its compressed file has come of the whole and how
// many atoms have been read; once it's ready, whether its burial is still being worked out; or why the load failed
import type { Burial } from './pdb/burial.ts'
import type { LoadProgress } from './pdb/entryLoad.ts'
import type { Status } from './store.ts'

// A size in one unit for both sizes of a pair, decimal kilobytes under a megabyte and megabytes from there
function sizes(received: number, total: number) {
  if (total < 1e6) return `${Math.round(received / 1e3)} of ${Math.round(total / 1e3)} kB`
  return `${(received / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`
}

export function statusText(state: {
  status: Status
  error: string | null
  progress: LoadProgress | null
  burial: Burial | null
}): string {
  const { status, error, progress, burial } = state
  if (error !== null) return error
  if (status === 'loading') {
    if (!progress) return 'Loading…'
    const atoms = progress.atoms > 0 ? `${progress.atoms.toLocaleString('en')} atoms` : ''
    if (progress.total === null) return atoms ? `Loading, ${atoms}` : 'Loading…'
    return `${sizes(progress.received, progress.total)}${atoms ? `, ${atoms}` : ''}`
  }
  if (status === 'ready') return burial ? 'Ready' : 'Ready, burial to come'
  return ''
}
