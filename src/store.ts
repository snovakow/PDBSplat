import { create } from 'zustand'
import { shallow } from 'zustand/shallow'
import { fetchEntry, isAbort } from './pdb/fetchEntry.ts'
import type { Atom } from './pdb/mmcif.ts'

// Crambin: 327 atoms, small and fast to load
export const firstEntry = '1CRN'

export type Status = 'idle' | 'loading' | 'ready' | 'failed'

export type ColorBy = 'element' | 'chain'

// What the panel sets and the scene draws
export interface ViewOptions {
  colorBy: ColorBy
  // Times each atom's van der Waals radius
  scale: number
  opacity: number
  hydrogens: boolean
  waters: boolean
}

export const defaultOptions: ViewOptions = { colorBy: 'element', scale: 1, opacity: 0.9, hydrogens: true, waters: false }

export function isShown(atom: Atom, options: ViewOptions) {
  return (options.hydrogens || !atom.hydrogen) && (options.waters || !atom.water)
}

interface State {
  // The entry shown, which stays until the next one is ready
  id: string
  title: string
  atoms: Atom[]
  // The latest load, and its message if it failed
  status: Status
  error: string | null
  load: (id: string) => Promise<void>
  options: ViewOptions
  setOptions: (changes: Partial<ViewOptions>) => void
}

export const useStore = create<State>()((set) => ({
  id: '',
  title: '',
  atoms: [],
  status: 'idle',
  error: null,
  options: defaultOptions,
  // Unchanged values keep the same options object, so the scene doesn't rebuild for nothing
  setOptions: (changes) =>
    set((state) => {
      const options = { ...state.options, ...changes }
      return shallow(options, state.options) ? state : { options }
    }),
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
