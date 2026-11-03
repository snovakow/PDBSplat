import { create } from 'zustand'
import { fetchEntry, isAbort } from './pdb/fetchEntry.ts'
import type { Atom } from './pdb/mmcif.ts'

// Crambin: 327 atoms, small and fast to load
export const firstEntry = '1CRN'

export type Status = 'idle' | 'loading' | 'ready' | 'failed'

interface State {
  // The entry shown, which stays until the next one is ready
  id: string
  title: string
  atoms: Atom[]
  // The latest load, and its message if it failed
  status: Status
  error: string | null
  load: (id: string) => Promise<void>
}

export const useStore = create<State>()((set) => ({
  id: '',
  title: '',
  atoms: [],
  status: 'idle',
  error: null,
  load: async (id) => {
    set({ status: 'loading', error: null })
    try {
      const entry = await fetchEntry(id)
      set({ id: entry.id, title: entry.title, atoms: entry.atoms, status: 'ready' })
      const count = (test: (atom: Atom) => boolean) => entry.atoms.filter(test).length
      console.info(
        `PDBSplat: ${entry.id}, "${entry.title}": ${entry.atoms.length} atoms, ` +
          `${count((atom) => atom.water)} of them waters, ${count((atom) => atom.hydrogen)} hydrogens, ` +
          `${count((atom) => atom.altLoc !== '')} with alternate locations`,
      )
    } catch (error) {
      // A newer load aborted this one, and owns the status now
      if (isAbort(error)) return
      const message = error instanceof Error ? error.message : String(error)
      set({ status: 'failed', error: message })
      console.warn(`PDBSplat: ${message}`)
    }
  },
}))
