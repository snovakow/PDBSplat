import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultOptions, isOption, optionKeys, viewOptions, type Folder, type ViewOptions } from '../src/options.ts'
import type { Atom } from '../src/pdb/mmcif.ts'
import { isShown, shownAtoms, shownModel, useStore } from '../src/store.ts'

// The store's pure rules: which atoms are shown, which model, the shown atoms' one array, that unchanged options keep
// their object, and that the options table gives the defaults

const base: Atom = {
  element: 'C',
  x: 0,
  y: 0,
  z: 0,
  chain: 'A',
  residueName: 'ALA',
  residueNumber: 1,
  insertion: '',
  atomName: 'CA',
  altLoc: '',
  occupancy: 1,
  bFactor: 20,
  model: 1,
  firstConformation: true,
  polymer: true,
  hydrogen: false,
  water: false,
  structure: 'none',
  u: null,
}
const atom = (changes: Partial<Atom>): Atom => ({ ...base, ...changes })

void test('isShown follows Hydrogens, Waters, Alternates and the model shown', () => {
  const shown = { hydrogens: true, waters: true, conformations: 'all' } as const
  const hidden = { hydrogens: false, waters: false, conformations: 'first' } as const
  const heavy = atom({})
  const hydrogen = atom({ element: 'H', hydrogen: true })
  const water = atom({ residueName: 'HOH', water: true, polymer: false })
  const alternate = atom({ altLoc: 'B', firstConformation: false })
  const later = atom({ model: 2 })
  for (const model of [null, 1]) {
    assert.equal(isShown(heavy, shown, model), true)
    assert.equal(isShown(heavy, hidden, model), true)
    assert.equal(isShown(hydrogen, shown, model), true)
    assert.equal(isShown(hydrogen, hidden, model), false)
    assert.equal(isShown(hydrogen, { ...hidden, hydrogens: true }, model), true)
    assert.equal(isShown(water, shown, model), true)
    assert.equal(isShown(water, hidden, model), false)
    assert.equal(isShown(water, { ...hidden, waters: true }, model), true)
    assert.equal(isShown(alternate, shown, model), true)
    assert.equal(isShown(alternate, hidden, model), false)
    assert.equal(isShown(alternate, { ...hidden, conformations: 'all' }, model), true)
  }
  assert.equal(isShown(later, shown, null), true)
  assert.equal(isShown(later, shown, 2), true)
  assert.equal(isShown(later, shown, 1), false)
  assert.equal(isShown(heavy, shown, 2), false)
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
  assert.equal(defaultOptions.opacity, 0.9)
  assert.equal(defaultOptions.blend, 'normal')
})

void test('shownAtoms gives the same array while the entry, Hydrogens, Waters, Alternates and the model stand', () => {
  const heavy = atom({})
  const hydrogen = atom({ element: 'H', hydrogen: true })
  const water = atom({ residueName: 'HOH', water: true, polymer: false })
  const alternate = atom({ altLoc: 'B', firstConformation: false })
  const later = atom({ model: 2 })
  const atoms = [heavy, hydrogen, water, alternate, later]
  const state = (changes: Partial<ViewOptions>, model = 1) => ({ atoms, options: { ...defaultOptions, ...changes }, models: [1, 2], model })
  const shown = shownAtoms(state({}))
  assert.deepEqual(shown, [heavy, hydrogen])
  // Another state with the same inputs, as every other change to the store leaves them, gives the very same array
  assert.equal(shownAtoms(state({})), shown)
  assert.equal(shownAtoms(state({ opacity: 0.5, colorBy: 'chain', style: 'surface' })), shown)
  assert.equal(shownAtoms(state({ models: 'play' }, 1)), shown)
  // Any of its inputs changing gives a new one
  const fewer = shownAtoms(state({ hydrogens: false }))
  assert.notEqual(fewer, shown)
  assert.deepEqual(fewer, [heavy])
  assert.deepEqual(shownAtoms(state({ waters: true })), [heavy, hydrogen, water])
  assert.deepEqual(shownAtoms(state({ conformations: 'all' })), [heavy, hydrogen, alternate])
  assert.deepEqual(shownAtoms(state({ models: 'all' })), [heavy, hydrogen, later])
  assert.deepEqual(shownAtoms(state({ models: 'play' }, 2)), [later])
  const again = shownAtoms(state({}))
  assert.notEqual(again, shown)
  assert.deepEqual(again, shown)
  assert.notEqual(shownAtoms({ ...state({}), atoms: [...atoms] }), again)
  // The store's own state selects the same way
  assert.deepEqual(shownAtoms(useStore.getState()), [])
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
    if (entry.kind === 'style') assert.equal(entry.default, 'soft')
    // A control another hides names that control by its key, which is an option of its own
    if (entry.shownWhile) assert.ok(isOption(entry.shownWhile.option), `${key} depends on ${entry.shownWhile.option}`)
  }
  assert.equal(isOption('toString'), false)
  assert.equal(isOption('style'), true)
  // The values the page opens with
  assert.equal(defaultOptions.style, 'soft')
  assert.equal(defaultOptions.opacity, 0.9)
  assert.equal(defaultOptions.hydrogens, true)
  assert.equal(defaultOptions.waters, false)
})
