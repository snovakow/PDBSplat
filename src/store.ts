import type { Raycaster } from 'three'
import { create } from 'zustand'
import { shallow } from 'zustand/shallow'
import { defaultOptions, type EntryHolds, type ViewOptions } from './options.ts'
import { fetchEntry, isAbort } from './pdb/fetchEntry.ts'
import {
  emptyStructure,
  firstConformationFlag,
  hydrogenFlag,
  modelOf,
  selectAtoms,
  waterFlag,
  type ShownAtoms,
  type Structure,
} from './pdb/structure.ts'
import { hasLigands } from './viewer/focus.ts'

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

// The antibody, whose four chains make a Y of three lobes, each chain in its own colour, the most striking shape among
// the examples, and the one the presets were chosen on. It's one of the examples, so that the Example list shows it
export const firstEntry: string = '1IGT' satisfies (typeof examples)[number]['id']

export type Status = 'idle' | 'loading' | 'ready' | 'failed'

// The options the page opens with: the defaults, with Spin off for a visitor whose system asks for reduced motion, as a
// view that moves by itself is the motion that setting asks a page to leave out
export function openingOptions(reducedMotion: boolean): ViewOptions {
  return reducedMotion ? { ...defaultOptions, spin: false } : defaultOptions
}

// Whether the visitor's system asks for reduced motion. The tests run with no window to ask
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Whether an atom of the structure, by its row, is drawn, by Hydrogens, Waters and Conformations, and by the model
// shown, or every model for null
export function isShown(
  structure: Structure,
  atom: number,
  options: Pick<ViewOptions, 'hydrogens' | 'waters' | 'conformations'>,
  model: number | null,
) {
  const flags = structure.atoms.flags[atom]
  return (
    (options.hydrogens || (flags & hydrogenFlag) === 0) &&
    (options.waters || (flags & waterFlag) === 0) &&
    (options.conformations === 'all' || (flags & firstConformationFlag) !== 0) &&
    (model === null || modelOf(structure, atom) === model)
  )
}

// The model Models shows: the first, or the one playing, or null for every model at once
export function shownModel(state: { options: ViewOptions; models: readonly number[]; model: number }): number | null {
  if (state.options.models === 'all') return null
  return state.options.models === 'play' ? state.model : (state.models[0] ?? state.model)
}

// What the shown atoms were last selected from, and the selection, so that the same one comes back while they stand
interface LastShown {
  structure: Structure
  hydrogens: boolean
  waters: boolean
  conformations: ViewOptions['conformations']
  model: number | null
  shown: ShownAtoms
}
let lastShown: LastShown | null = null

// The atoms drawn: the structure's atoms that isShown keeps under Hydrogens, Waters, Alternates and the model shown.
// The same selection comes back while those stand, so that the panel's count and the drawing components, which each
// read it from the store, select once for every change of it and not at all for any other change, such as of the atom
// under the pointer
export function shownAtoms(state: Pick<State, 'structure' | 'options' | 'models' | 'model'>): ShownAtoms {
  const { structure } = state
  const { hydrogens, waters, conformations } = state.options
  const model = shownModel(state)
  const last = lastShown
  if (
    last &&
    last.structure === structure &&
    last.hydrogens === hydrogens &&
    last.waters === waters &&
    last.conformations === conformations &&
    last.model === model
  ) {
    return last.shown
  }
  const shown = selectAtoms(structure, (atom) => isShown(structure, atom, state.options, model))
  lastShown = { structure, hydrogens, waters, conformations, model, shown }
  return shown
}

// What the entry was last found to hold, so that the same object comes back while its structure stands
let lastHeld: { structure: Structure; holds: EntryHolds } | null = null

// What the entry holds that a control acts on: more than one model, atoms recorded in alternate positions, waters,
// hydrogens, and ligands, as its structure counted them. Before an entry loads it holds none of them
export function entryHolds({ structure }: Pick<State, 'structure'>): EntryHolds {
  if (lastHeld && lastHeld.structure === structure) return lastHeld.holds
  const { tallies } = structure
  const holds: EntryHolds = {
    models: structure.models.length > 1,
    alternates: tallies.alternates > 0,
    waters: tallies.waters > 0,
    hydrogens: tallies.hydrogens > 0,
    ligands: hasLigands(structure),
  }
  lastHeld = { structure, holds }
  return holds
}

// The nearest atom a ray has met so far, by its row, and how far along the ray, or null and Infinity before any
export interface PickHit {
  atom: number | null
  distance: number
}

// A drawing component's test of a ray against the atoms it draws, which writes its nearest hit into hit when that's
// nearer than the one already there
export type PickTest = (raycaster: Raycaster, hit: PickHit) => void

interface State {
  // The entry shown, which stays until the next one is ready
  id: string
  title: string
  // Every model's atoms in every conformation, and its residues, runs and chains
  structure: Structure
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
  // The atom under the pointer and the one last clicked, both by their rows in the shown entry, which a new entry clears
  hovered: number | null
  picked: number | null
  hover: (atom: number | null) => void
  pick: (atom: number | null) => void
  // A pick for each drawing component's atoms while they're drawn, which the pointer's ray is tested against
  picks: readonly PickTest[]
  // Adds a pick, and returns what removes it
  registerPick: (pick: PickTest) => () => void
}

export const useStore = create<State>()((set) => ({
  id: '',
  title: '',
  structure: emptyStructure,
  models: [],
  model: 0,
  status: 'idle',
  error: null,
  options: openingOptions(reducedMotion),
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
      const { models, atoms, tallies } = entry
      set({
        id: entry.id,
        title: entry.title,
        structure: entry,
        models,
        model: models[0] ?? 0,
        status: 'ready',
        hovered: null,
        picked: null,
      })
      // The counts are of the atoms shown at the defaults, then of the models and conformations beyond them
      const { defaults } = tallies
      console.info(
        `PDBSplat: ${entry.id}, "${entry.title}": ${defaults.atoms} atoms, ` +
          `${defaults.waters} of them waters, ${defaults.hydrogens} hydrogens, ` +
          `${defaults.alternates} with alternate locations; ` +
          `${atoms.count} atoms across ${models.length} ${models.length === 1 ? 'model' : 'models'}, ` +
          `${tallies.later} of them in later conformations`,
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
