import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultOptions,
  isOption,
  optionKeys,
  viewOptions,
  wholeEntry,
  type Folder,
  type ViewOptions,
} from '../src/options.ts'
import { emptyStructure, StructureBuilder, type AtomRecord, type Structure } from '../src/pdb/structure.ts'
import {
  entryHolds,
  examples,
  firstEntry,
  isShown,
  openingOptions,
  shownAtoms,
  shownModel,
  useStore,
} from '../src/store.ts'
import { hasGhosts, hasSolids, isOpaque, styles } from '../src/viewer/styles.ts'

// The store's pure rules: which atoms are shown, which model, the shown atoms' one array, that unchanged options keep
// their object, that the options table gives the defaults, and that the opening look holds together

const base: AtomRecord = {
  x: 0,
  y: 0,
  z: 0,
  element: 'C',
  atomName: 'CA',
  altLoc: '',
  occupancy: 1,
  bFactor: 20,
  model: 1,
  chain: 'A',
  labelChain: 'A',
  residueName: 'ALA',
  residueNumber: 1,
  insertion: '',
  hydrogen: false,
  water: false,
  firstConformation: true,
  polymer: true,
}

// A structure of the atoms given, each the base atom with its changes, in order
function structureOf(atoms: Partial<AtomRecord>[]): Structure {
  const builder = new StructureBuilder()
  for (const changes of atoms) builder.add({ ...base, ...changes })
  return builder.finish()
}

// A heavy atom, a hydrogen, a water, an alternate in a later conformation and an atom of the second model, the rows 0
// to 4 of the structure they make in that order
const heavy: Partial<AtomRecord> = {}
const hydrogen: Partial<AtomRecord> = { element: 'H', atomName: 'HA', hydrogen: true }
const water: Partial<AtomRecord> = { residueName: 'HOH', residueNumber: 301, water: true, polymer: false }
const alternate: Partial<AtomRecord> = { atomName: 'CB', altLoc: 'B', firstConformation: false }
const later: Partial<AtomRecord> = { model: 2 }

void test('isShown follows Hydrogens, Waters, Alternates and the model shown', () => {
  const shown = { hydrogens: true, waters: true, conformations: 'all' } as const
  const hidden = { hydrogens: false, waters: false, conformations: 'first' } as const
  const structure = structureOf([heavy, hydrogen, water, alternate, later])
  const is = (atom: number, options: Pick<ViewOptions, 'hydrogens' | 'waters' | 'conformations'>, model: number | null) =>
    isShown(structure, atom, options, model)
  for (const model of [null, 1]) {
    assert.equal(is(0, shown, model), true)
    assert.equal(is(0, hidden, model), true)
    assert.equal(is(1, shown, model), true)
    assert.equal(is(1, hidden, model), false)
    assert.equal(is(1, { ...hidden, hydrogens: true }, model), true)
    assert.equal(is(2, shown, model), true)
    assert.equal(is(2, hidden, model), false)
    assert.equal(is(2, { ...hidden, waters: true }, model), true)
    assert.equal(is(3, shown, model), true)
    assert.equal(is(3, hidden, model), false)
    assert.equal(is(3, { ...hidden, conformations: 'all' }, model), true)
  }
  assert.equal(is(4, shown, null), true)
  assert.equal(is(4, shown, 2), true)
  assert.equal(is(4, shown, 1), false)
  assert.equal(is(0, shown, 2), false)
})

void test('shownModel is the first model, the one playing, or null for every model at once', () => {
  const models = [3, 1, 2]
  const state = (shown: 'first' | 'all' | 'play', model: number) => ({ options: { ...defaultOptions, models: shown }, models, model })
  assert.equal(shownModel(state('first', 2)), 3)
  assert.equal(shownModel(state('play', 2)), 2)
  assert.equal(shownModel(state('all', 2)), null)
  // Without models, as before an entry loads, the first is the one held
  assert.equal(shownModel({ options: defaultOptions, models: [], model: 0 }), 0)
})

void test('setOptions keeps the same options object while nothing changes', (t) => {
  const { setOptions } = useStore.getState()
  t.after(() => setOptions(defaultOptions))
  const before = useStore.getState().options
  assert.equal(before, defaultOptions)
  setOptions({})
  assert.equal(useStore.getState().options, before)
  setOptions({ opacity: before.opacity, style: before.style })
  assert.equal(useStore.getState().options, before)
  setOptions({ opacity: 0.5 })
  const changed = useStore.getState().options
  assert.notEqual(changed, before)
  assert.equal(changed.opacity, 0.5)
  assert.equal(changed.style, before.style)
  setOptions({ opacity: 0.5 })
  assert.equal(useStore.getState().options, changed)
  setOptions({ opacity: 0.5, blend: 'glow' })
  assert.notEqual(useStore.getState().options, changed)
  assert.equal(useStore.getState().options.blend, 'glow')
  // The defaults are untouched
  assert.equal(defaultOptions.opacity, 1)
  assert.equal(defaultOptions.blend, 'normal')
})

void test('shownAtoms gives the same selection while the entry, Hydrogens, Waters, Alternates and the model stand', () => {
  const atoms = [heavy, hydrogen, water, alternate, later]
  const structure = structureOf(atoms)
  const state = (changes: Partial<ViewOptions>, model = 1) => ({ structure, options: { ...defaultOptions, ...changes }, models: [1, 2], model })
  const rows = (selected: ReturnType<typeof shownAtoms>) => [...selected.rows]
  const shown = shownAtoms(state({}))
  assert.deepEqual(rows(shown), [0, 1])
  assert.deepEqual([...shown.mask], [1, 1, 0, 0, 0])
  assert.equal(shown.count, 2)
  // Another state with the same inputs, as every other change to the store leaves them, gives the very same selection
  assert.equal(shownAtoms(state({})), shown)
  assert.equal(shownAtoms(state({ opacity: 0.5, colorBy: 'element', style: 'surface' })), shown)
  assert.equal(shownAtoms(state({ models: 'play' }, 1)), shown)
  // Any of its inputs changing gives a new one
  const fewer = shownAtoms(state({ hydrogens: false }))
  assert.notEqual(fewer, shown)
  assert.deepEqual(rows(fewer), [0])
  assert.deepEqual(rows(shownAtoms(state({ waters: true }))), [0, 1, 2])
  assert.deepEqual(rows(shownAtoms(state({ conformations: 'all' }))), [0, 1, 3])
  assert.deepEqual(rows(shownAtoms(state({ models: 'all' }))), [0, 1, 4])
  assert.deepEqual(rows(shownAtoms(state({ models: 'play' }, 2))), [4])
  const again = shownAtoms(state({}))
  assert.notEqual(again, shown)
  assert.deepEqual(again, shown)
  assert.notEqual(shownAtoms({ ...state({}), structure: structureOf(atoms) }), again)
  // The store's own state selects the same way
  assert.equal(shownAtoms(useStore.getState()).count, 0)
})

void test('an entry holds models, alternates, waters, hydrogens and ligands by what its structure counted', () => {
  const plain = structureOf([heavy])
  assert.deepEqual(entryHolds({ structure: plain }), {
    models: false,
    alternates: false,
    waters: false,
    hydrogens: false,
    ligands: false,
  })
  // Before an entry loads it holds none of them
  assert.deepEqual(entryHolds({ structure: emptyStructure }), entryHolds({ structure: plain }))
  const atoms: Partial<AtomRecord>[] = [
    hydrogen,
    water,
    { atomName: 'CB', altLoc: 'A' },
    alternate,
    later,
    { residueName: 'HEM', residueNumber: 142, polymer: false },
  ]
  const full = structureOf(atoms)
  const holds = entryHolds({ structure: full })
  assert.deepEqual(holds, wholeEntry)
  assert.equal(entryHolds({ structure: full }), holds)
  assert.notEqual(entryHolds({ structure: structureOf(atoms) }), holds)
  // Each by its own atoms alone
  const alone = (atom: Partial<AtomRecord>) => entryHolds({ structure: structureOf([atom]) })
  assert.equal(alone(hydrogen).hydrogens, true)
  assert.equal(alone(hydrogen).waters, false)
  assert.equal(alone(water).waters, true)
  assert.equal(alone({ altLoc: 'A' }).alternates, true)
  // A water is outside the polymer chains, as a ligand is, and isn't one
  assert.equal(alone(water).ligands, false)
  assert.equal(alone({ residueName: 'HEM', polymer: false }).ligands, true)
  // A ligand only in a later conformation isn't one
  assert.equal(alone({ residueName: 'HEM', polymer: false, altLoc: 'B', firstConformation: false }).ligands, false)
  assert.equal(entryHolds({ structure: structureOf([heavy, later]) }).models, true)
})

void test('the options table gives the defaults, in the panel folders, with every key of the options', () => {
  const folders: Folder[] = ['Look', 'Colour', 'Atoms', 'Scene']
  assert.deepEqual(Object.keys(defaultOptions), Object.keys(viewOptions))
  assert.deepEqual(optionKeys, Object.keys(viewOptions))
  for (const key of optionKeys) {
    const entry = viewOptions[key]
    assert.equal(defaultOptions[key], entry.default, key)
    assert.ok(folders.includes(entry.folder), `${key} is in ${entry.folder}`)
    assert.ok(entry.label.length > 0, key)
    if (entry.kind === 'slider') {
      assert.ok(entry.min < entry.max && entry.step > 0, key)
      assert.ok(entry.default >= entry.min && entry.default <= entry.max, key)
    }
    if (entry.kind === 'choice') assert.ok(Object.values(entry.choices).includes(entry.default), key)
    if (entry.kind === 'style') assert.ok(styles.some((style) => style.id === entry.default), key)
    // A control another hides names that control by its key, which is an option of its own
    if (entry.shownWhile && 'option' in entry.shownWhile) {
      assert.ok(isOption(entry.shownWhile.option), `${key} depends on ${entry.shownWhile.option}`)
    }
  }
  assert.equal(isOption('toString'), false)
  assert.equal(isOption('style'), true)
  // No slider reaches an end that draws what another setting already does: Opacity stops short of nothing at all,
  // Fade short of fading nothing, as with every atom in focus, and Clip short of cutting everything away
  assert.ok(viewOptions.opacity.min > 0)
  assert.ok(viewOptions.fade.max < 1)
  assert.ok(viewOptions.clip.max < 1)
  // The values the page opens with
  assert.equal(defaultOptions.style, 'spheres')
  assert.equal(defaultOptions.opacity, 1)
  assert.equal(defaultOptions.colorBy, 'chain')
  assert.equal(defaultOptions.hydrogens, true)
  assert.equal(defaultOptions.waters, false)
  assert.equal(defaultOptions.spin, true)
})

void test('the page opens on the defaults, with Spin off for a visitor whose system asks for reduced motion', () => {
  assert.equal(openingOptions(false), defaultOptions)
  assert.deepEqual(openingOptions(true), { ...defaultOptions, spin: false })
})

void test('the opening look is solid spheres, which its ambient occlusion acts on, on one of the examples', () => {
  // The look leans on ambient occlusion, which acts only while everything drawn is opaque, as the solid spheres are.
  // A default that made some of them see-through, such as Opacity below full or a Focus that fades atoms without
  // hiding them, would turn it off unseen
  assert.equal(hasSolids(defaultOptions), true)
  assert.equal(hasGhosts(defaultOptions, wholeEntry), false)
  assert.equal(isOpaque(defaultOptions, wholeEntry), true)
  assert.ok(defaultOptions.ao > 0)
  // The rest of the look is on: the shadows of depth and burial, and the glow
  assert.ok(defaultOptions.depthCue > 0 && defaultOptions.burial > 0 && defaultOptions.bloom > 0)
  // The Example list shows the entry the page opens on
  assert.equal(firstEntry, '1IGT')
  assert.ok(examples.some((example) => example.id === firstEntry))
})
