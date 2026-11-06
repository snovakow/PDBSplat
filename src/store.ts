import type { Raycaster } from 'three'
import { create } from 'zustand'
import { shallow } from 'zustand/shallow'
import { defaultOptions, type ViewOptions } from './options.ts'
import { fetchEntry, isAbort } from './pdb/fetchEntry.ts'
import { defaultAtoms, type Atom } from './pdb/mmcif.ts'

// Entries the panel offers, smallest first, each of which tests something the others don't
export const examples = [
  // 327 atoms, protein only
  { id: '1CRN', name: 'crambin' },
  // 566 atoms: two DNA strands, with phosphorus and 80 waters
  { id: '1BNA', name: 'B-DNA' },
  // 637 atoms: crambin again, with its hydrogens, and 843 with every alternate conformation of its 17 residues that have them
  { id: '1EJG', name: 'crambin + H' },
  // 1,231 atoms in each of an NMR entry's ten models
  { id: '1D3Z', name: 'ubiquitin NMR' },
  // 4,779 atoms: four chains, four hemes with their iron, and 221 waters
  { id: '4HHB', name: 'haemoglobin' },
  // 12,956 atoms: an intact antibody, four protein chains in a Y with two sugar chains
  { id: '1IGT', name: 'antibody' },
] as const

// Crambin, small and quick to load
export const firstEntry: string = examples[0].id

export type Status = 'idle' | 'loading' | 'ready' | 'failed'

// Whether an atom is drawn, by Hydrogens, Waters and Conformations, and by the model shown, or every model for null
export function isShown(
  atom: Atom,
  options: Pick<ViewOptions, 'hydrogens' | 'waters' | 'conformations'>,
  model: number | null,
) {
  return (
    (options.hydrogens || !atom.hydrogen) &&
    (options.waters || !atom.water) &&
    (options.conformations === 'all' || atom.firstConformation) &&
    (model === null || atom.model === model)
  )
}

// The model Models shows: the first, or the one playing, or null for every model at once
export function shownModel(state: { options: ViewOptions; models: readonly number[]; model: number }): number | null {
  if (state.options.models === 'all') return null
  return state.options.models === 'play' ? state.model : (state.models[0] ?? state.model)
}

// What the shown atoms were last selected from, and the selection, so that the same array comes back while they stand
interface ShownAtoms {
  atoms: readonly Atom[]
  hydrogens: boolean
  waters: boolean
  conformations: ViewOptions['conformations']
  model: number | null
  shown: readonly Atom[]
}
let lastShown: ShownAtoms | null = null

// The atoms drawn: the entry's atoms that isShown keeps under Hydrogens, Waters, Alternates and the model shown. The
// same array comes back while those stand, so that the panel's count and the drawing components, which each read it
// from the store, filter the entry once for every change of it and not at all for any other change, such as of the
// atom under the pointer
export function shownAtoms(state: Pick<State, 'atoms' | 'options' | 'models' | 'model'>): readonly Atom[] {
  const { atoms } = state
  const { hydrogens, waters, conformations } = state.options
  const model = shownModel(state)
  const last = lastShown
  if (
    last &&
    last.atoms === atoms &&
    last.hydrogens === hydrogens &&
    last.waters === waters &&
    last.conformations === conformations &&
    last.model === model
  ) {
    return last.shown
  }
  const shown = atoms.filter((atom) => isShown(atom, state.options, model))
  lastShown = { atoms, hydrogens, waters, conformations, model, shown }
  return shown
}

// The nearest atom a ray has met so far, and how far along the ray, or null and Infinity before any
export interface PickHit {
  atom: Atom | null
  distance: number
}

// A drawing component's test of a ray against the atoms it draws, which writes its nearest hit into hit when that's
// nearer than the one already there
export type PickTest = (raycaster: Raycaster, hit: PickHit) => void

interface State {
  // The entry shown, which stays until the next one is ready
  id: string
  title: string
  // Every model's atoms in every conformation
  atoms: Atom[]
  // The entry's models, in the file's order, and the one shown while Models plays them
  models: readonly number[]
  model: number
  // Moves playback on to the next model, and from the last back to the first
  nextModel: () => void
  // The latest load, and its message if it failed
  status: Status
  error: string | null
  load: (id: string) => Promise<void>
  options: ViewOptions
  setOptions: (changes: Partial<ViewOptions>) => void
  // The atom under the pointer and the one last clicked, both of the shown entry, which a new entry clears
  hovered: Atom | null
  picked: Atom | null
  hover: (atom: Atom | null) => void
  pick: (atom: Atom | null) => void
  // A pick for each drawing component's atoms while they're drawn, which the pointer's ray is tested against
  picks: readonly PickTest[]
  // Adds a pick, and returns what removes it
  registerPick: (pick: PickTest) => () => void
}

export const useStore = create<State>()((set) => ({
  id: '',
  title: '',
  atoms: [],
  models: [],
  model: 0,
  status: 'idle',
  error: null,
  options: defaultOptions,
  hovered: null,
  picked: null,
  picks: [],
  // Unchanged values keep the same options object, so the scene doesn't rebuild for nothing
  setOptions: (changes) =>
    set((state) => {
      const options = { ...state.options, ...changes }
      return shallow(options, state.options) ? state : { options }
    }),
  nextModel: () =>
    set((state) => {
      const { models, model } = state
      const next = models[(models.indexOf(model) + 1) % models.length]
      return next === undefined || next === model ? state : { model: next }
    }),
  hover: (hovered) => set((state) => (state.hovered === hovered ? state : { hovered })),
  pick: (picked) => set((state) => (state.picked === picked ? state : { picked })),
  registerPick: (pick) => {
    set((state) => ({ picks: [...state.picks, pick] }))
    return () => set((state) => ({ picks: state.picks.filter((registered) => registered !== pick) }))
  },
  load: async (id) => {
    set({ status: 'loading', error: null })
    try {
      const entry = await fetchEntry(id)
      const { atoms, models } = entry
      set({
        id: entry.id,
        title: entry.title,
        atoms,
        models,
        model: models[0] ?? 0,
        status: 'ready',
        hovered: null,
        picked: null,
      })
      // The counts are of the atoms shown at the defaults, then of the models and conformations beyond them
      const first = defaultAtoms(atoms)
      const count = (test: (atom: Atom) => boolean) => first.filter(test).length
      const later = atoms.filter((atom) => !atom.firstConformation).length
      console.info(
        `PDBSplat: ${entry.id}, "${entry.title}": ${first.length} atoms, ` +
          `${count((atom) => atom.water)} of them waters, ${count((atom) => atom.hydrogen)} hydrogens, ` +
          `${count((atom) => atom.altLoc !== '')} with alternate locations; ` +
          `${atoms.length} atoms across ${models.length} ${models.length === 1 ? 'model' : 'models'}, ` +
          `${later} of them in later conformations`,
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
