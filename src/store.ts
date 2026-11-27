import type { Raycaster } from 'three'
import { create } from 'zustand'
import { shallow } from 'zustand/shallow'
import { defaultOptions, type EntryHolds, type ViewOptions } from './options.ts'
import { noBounds, type StructureBounds } from './pdb/bounds.ts'
import type { Burial } from './pdb/burial.ts'
import type { LoadProgress } from './pdb/entryLoad.ts'
import { fetchEntry, isAbort, mergeEntry, settleMerges, type Entry, type Loaded } from './pdb/fetchEntry.ts'
import { remergeChanged, type MergedLevels } from './pdb/merge.ts'
import {
  emptyStructure,
  modelOf,
  roomToGrow,
  sameChoice,
  selectAtoms,
  shownBy,
  type ShownAtoms,
  type ShownChoice,
  type Structure,
} from './pdb/structure.ts'
import { hasLigands } from './viewer/focus.ts'

// How many atoms the chains a change of layers touches may hold for their blobs to be merged again on the page itself,
// rather than by the loader's worker: a few hundredths of a second's work, as every example's chains are, and as a pick
// under a picked Focus touches on any entry. A new Focus on a giant touches every chain, which the worker merges
const quickMergeAtoms = 1 << 18

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
  const { hydrogens, waters, conformations } = options
  return shownBy(structure.atoms.flags[atom], modelOf(structure, atom), { hydrogens, waters, conformations, model })
}

// The model Models shows: the first, or the one playing, or null for every model at once
export function shownModel(state: { options: ViewOptions; models: readonly number[]; model: number }): number | null {
  if (state.options.models === 'all') return null
  return state.options.models === 'play' ? state.model : (state.models[0] ?? state.model)
}

// The atoms Hydrogens, Waters, Alternates and the model shown choose
export function shownChoice(state: Pick<State, 'options' | 'models' | 'model'>): ShownChoice {
  const { hydrogens, waters, conformations } = state.options
  return { hydrogens, waters, conformations, model: shownModel(state) }
}

// What the shown atoms were last selected from, and the selection, so that the same one comes back while they stand.
// While a structure arrives, its selection is kept in columns with room to grow, which each batch's shown atoms are
// added to
interface LastShown {
  structure: Structure
  hydrogens: boolean
  waters: boolean
  conformations: ViewOptions['conformations']
  model: number | null
  shown: ShownAtoms
  growing: { mask: Uint8Array; rows: Uint32Array } | null
}
let lastShown: LastShown | null = null
// The atoms another choice chose last, and the choice, so that the same selection comes back while they stand
let lastChosen: { structure: Structure; choice: ShownChoice; shown: ShownAtoms } | null = null

// The atoms drawn: the structure's atoms that isShown keeps under Hydrogens, Waters, Alternates and the model shown.
// The same selection comes back while those stand, so that the panel's count and the drawing components, which each
// read it from the store, select once for every change of it and not at all for any other change, such as of the atom
// under the pointer. A later snapshot of a structure as it arrives keeps every atom the last one's selection chose,
// and the atoms after them are tested alone
export function shownAtoms(state: Pick<State, 'structure' | 'options' | 'models' | 'model'>): ShownAtoms {
  const { structure } = state
  const choice = shownChoice(state)
  const { hydrogens, waters, conformations, model } = choice
  const last = lastShown
  const same =
    last !== null &&
    last.hydrogens === hydrogens &&
    last.waters === waters &&
    last.conformations === conformations &&
    last.model === model
  if (same && last.structure === structure) return last.shown
  // A choice given up for another is kept for chosenAtoms, as what's drawn may stay with it a while, and what was kept
  // of another structure goes, so that an entry no longer shown isn't held
  if (last && !same && !last.growing && last.structure === structure) {
    const { hydrogens: h, waters: w, conformations: c, model: m } = last
    lastChosen = { structure, choice: { hydrogens: h, waters: w, conformations: c, model: m }, shown: last.shown }
  } else if (lastChosen && lastChosen.structure !== structure) lastChosen = null
  const { flags } = structure.atoms
  const keep = (atom: number) => shownBy(flags[atom], modelOf(structure, atom), choice)
  if (!structure.arrival) {
    const shown = selectAtoms(structure, keep)
    lastShown = { structure, hydrogens, waters, conformations, model, shown, growing: null }
    return shown
  }
  // Grown on from the last selection where it's of an earlier snapshot of the same structure
  const onward =
    same &&
    last.growing !== null &&
    last.structure.arrival === structure.arrival &&
    last.structure.atoms.count <= structure.atoms.count
  const from = onward ? last.structure.atoms.count : 0
  let kept = onward ? last.shown.count : 0
  const count = structure.atoms.count
  let growing = onward ? last.growing : null
  if (!growing || growing.mask.length < count) {
    const capacity = roomToGrow(count, structure.arrival.expectedAtoms, growing?.mask.length ?? 0)
    const mask = new Uint8Array(capacity)
    const rows = new Uint32Array(capacity)
    if (growing) {
      mask.set(growing.mask.subarray(0, from))
      rows.set(growing.rows.subarray(0, kept))
    }
    growing = { mask, rows }
  }
  for (let atom = from; atom < count; atom++) {
    if (!keep(atom)) continue
    growing.mask[atom] = 1
    growing.rows[kept++] = atom
  }
  const shown: ShownAtoms = { mask: growing.mask.subarray(0, count), rows: growing.rows.subarray(0, kept), count: kept }
  lastShown = { structure, hydrogens, waters, conformations, model, shown, growing }
  return shown
}

// The atoms a choice other than the one shown chooses, as the blobs the loader last merged may have been merged for
// while a newer choice's are on their way
export function chosenAtoms(structure: Structure, choice: ShownChoice): ShownAtoms {
  if (lastChosen?.structure === structure && sameChoice(lastChosen.choice, choice)) return lastChosen.shown
  const { flags } = structure.atoms
  const shown = selectAtoms(structure, (atom) => shownBy(flags[atom], modelOf(structure, atom), choice))
  lastChosen = { structure, choice, shown }
  return shown
}

// What the entry was last found to hold, so that the same object comes back while its structure stands, or while what
// it holds does
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
  // A later snapshot of an entry as it arrives mostly holds what the one before did, which then comes back as it was
  const held = structure.arrival !== null && lastHeld?.structure.arrival === structure.arrival ? lastHeld.holds : undefined
  const same =
    held !== undefined &&
    held.models === holds.models &&
    held.alternates === holds.alternates &&
    held.waters === holds.waters &&
    held.hydrogens === holds.hydrogens &&
    held.ligands === holds.ligands
  const kept = same ? held : holds
  lastHeld = { structure, holds: kept }
  return kept
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
  // The entry shown, which stays until the next one's first batch arrives, and then grows as the rest of it does
  id: string
  title: string
  // Every model's atoms in every conformation, and its residues, runs and chains
  structure: Structure
  // The entry's models, in the file's order, and the one shown while Models plays them
  models: readonly number[]
  model: number
  // Moves playback on to the next model, and from the last back to the first
  nextModel: () => void
  // The entry's bounds, as far as it has arrived and exactly once it has
  bounds: StructureBounds
  // The latest load, and its message if it failed, and how far it has come while it's under way
  status: Status
  error: string | null
  progress: LoadProgress | null
  load: (id: string) => Promise<void>
  // The shown entry's residues and chains merged into blobs, under the choice of atoms and the layers they were merged
  // for, which the loader merges again on request; and its burial, null until the loader has worked it out
  merged: MergedLevels | null
  requestMerge: (choice: ShownChoice, layers: Uint8Array | null) => void
  burial: Burial | null
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

// Each load's number, so that a superseded load's progress, which may still be on its way, changes nothing
let loads = 0

// The store's entry once a load has given it, whole or as far as it has arrived. A later batch of the entry shown keeps
// the model played, the atoms hovered and picked, and the burial; any other entry starts on its first model with none
function arrivedState(state: State, { entry, merged, bounds, burial }: Loaded): Partial<State> {
  const { models } = entry
  const grown = entry.arrival !== null && state.structure.arrival === entry.arrival
  return {
    id: entry.id,
    title: entry.title,
    structure: entry,
    models,
    model: grown && models.includes(state.model) ? state.model : (models[0] ?? 0),
    merged,
    bounds,
    burial: grown ? (state.burial ?? burial) : burial,
    ...(grown ? {} : { hovered: null, picked: null }),
  }
}

export const useStore = create<State>()((set, get) => ({
  id: '',
  title: '',
  structure: emptyStructure,
  bounds: noBounds,
  models: [],
  model: 0,
  status: 'idle',
  error: null,
  progress: null,
  merged: null,
  burial: null,
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
    const load = ++loads
    set({ status: 'loading', error: null, progress: null })
    const { hydrogens, waters, conformations, models: shownModels } = get().options
    try {
      const loaded = await fetchEntry(
        id,
        { hydrogens, waters, conformations, allModels: shownModels === 'all' },
        {
          progress: (progress) => {
            if (load === loads) set({ progress })
          },
          // Each batch puts the entry as it stands on screen, the first in place of the entry shown before
          arrived: (arrived) => {
            if (load === loads) set(arrivedState(get(), arrived))
          },
          // The burial lands on the entry it was worked out for, while that's the one shown
          burial: (of: Entry, landed: Burial) => {
            if (get().structure === of) set({ burial: landed })
          },
        },
      )
      // A later call for the same entry shares its load, and the latest call alone takes it
      if (load !== loads) return
      const { entry } = loaded
      set({ ...arrivedState(get(), loaded), status: 'ready', progress: null })
      // The counts are of the atoms shown at the defaults, then of the models and conformations beyond them
      const { models, atoms, tallies } = entry
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
      set({ status: 'failed', error: message, progress: null })
      console.warn(`PDBSplat: ${message}`)
    }
  },
  // The levels merged again for the entry shown, once the loader has them, unless another entry is shown by then. New
  // layers for the choice already merged, where they touch few atoms, are merged here and now, from the levels as
  // they stand
  requestMerge: (choice, layers) => {
    const state = get()
    const { structure } = state
    const standing = state.merged
    if (standing && structure.whole && sameChoice(standing.choice, choice) && sameChoice(shownChoice(state), choice)) {
      const shown = shownAtoms(state)
      const again = remergeChanged(structure, shown.rows, shown.count, standing, layers, quickMergeAtoms)
      if (again) {
        settleMerges()
        set({ merged: again })
        return
      }
    }
    mergeEntry(structure, choice, layers).then(
      (merged) => {
        if (get().structure === structure) set({ merged })
      },
      (error: unknown) => {
        if (!isAbort(error)) console.warn(`PDBSplat: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  },
}))
