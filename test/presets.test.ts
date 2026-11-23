import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultOptions,
  optionKeys,
  viewOptions,
  wholeEntry,
  type EntryHolds,
  type ViewOptions,
} from '../src/options.ts'
import { presetOf, presets, withPreset } from '../src/presets.ts'
import { optionShows } from '../src/shownOptions.ts'
import { isBackShell, isOpaque, styleOf, styles } from '../src/viewer/styles.ts'

// The presets: that each is a whole set of options the panel can show, that the page opens on one, that choosing one
// sets its look and leaves the atoms shown and Spin as they were, that each is found from its own options, whatever
// its hidden controls hold, and none once a control of the look moves, by the controls the panel shows for the entry,
// and that every effect a preset turns on acts in its look

// The options a preset leaves as they are: those that choose which atoms are shown, and Spin, which moves the view
const keptOptions: string[] = ['hydrogens', 'waters', 'models', 'conformations', 'spin']

void test('each preset is a whole set of options the panel can show, under a name of its own', () => {
  const names = presets.map((preset) => preset.name)
  assert.equal(new Set(names).size, names.length)
  // The panel lists custom beside them, for options that are no preset's
  assert.ok(!names.includes('custom'))
  for (const { name, options } of presets) {
    assert.deepEqual(Object.keys(options).sort(), [...optionKeys].sort(), name)
    for (const key of optionKeys) {
      const entry = viewOptions[key]
      const value = options[key]
      const where = `${name}: ${key}`
      if (entry.kind === 'slider') {
        assert.ok(typeof value === 'number' && value >= entry.min && value <= entry.max, where)
        // On one of the slider's steps, so that dragging it can come back to the preset's value
        const steps = (value - entry.min) / entry.step
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, where)
      }
      if (entry.kind === 'switch') assert.equal(typeof value, 'boolean', where)
      if (entry.kind === 'choice') assert.ok(Object.values(entry.choices).some((choice) => choice === value), where)
      if (entry.kind === 'style') assert.ok(styles.some((style) => style.id === value), where)
    }
  }
})

void test('the page opens on the first preset, glossy, whose options the defaults are', () => {
  assert.equal(presets[0].name, 'glossy')
  assert.deepEqual(presets[0].options, defaultOptions)
  assert.equal(presetOf(defaultOptions, wholeEntry), presets[0])
  // And before an entry loads, when the entry holds nothing
  const nothing: EntryHolds = { models: false, alternates: false, waters: false, hydrogens: false }
  assert.equal(presetOf(defaultOptions, nothing), presets[0])
})

void test('choosing a preset sets every option of its look, and leaves the atoms shown and Spin as they were', () => {
  const before: ViewOptions = {
    ...defaultOptions,
    hydrogens: false,
    waters: true,
    models: 'all',
    conformations: 'all',
    spin: false,
    colorBy: 'structure',
    clip: 0.5,
  }
  for (const preset of presets) {
    const after = withPreset(before, preset)
    for (const key of optionKeys) {
      const kept = keptOptions.includes(key)
      assert.equal(after[key], kept ? before[key] : preset.options[key], `${preset.name}: ${key}`)
    }
  }
})

void test('each preset is found from its own options, whatever it keeps, and none once its look moves', () => {
  // A move of each option of the look, to a value no preset holds it at
  const moves: Partial<ViewOptions>[] = [
    { resolution: 3.3 },
    { scale: 1.35 },
    { opacity: 0.55 },
    { backShell: true },
    { backShell: false },
    { hardness: 0.55 },
    { shading: 0.45 },
    { highlight: 0.15 },
    { shininess: 11 },
    { outline: 0.23 },
    { blend: 'glow' },
    { blend: 'normal' },
    { detail: 'chains' },
    { colorBy: 'structure' },
    { burial: 0.85 },
    { thermal: 2.5 },
    { ellipsoids: true },
    { focus: 'chain' },
    { fade: 0.55 },
    { depthCue: 0.15 },
    { clip: 0.55 },
    { bloom: 2.65 },
    { bloomRadius: 0.85 },
    { bloomThreshold: 0.33 },
    { ao: 0.35 },
    { aoRadius: 8.5 },
  ]
  for (const preset of presets) {
    const { name, options } = preset
    // So no two presets share a look, as the second would never be found
    assert.equal(presetOf(options, wholeEntry), preset, name)
    // The atoms shown, and Spin, changed
    const keptChanged: ViewOptions = {
      ...options,
      hydrogens: !options.hydrogens,
      waters: !options.waters,
      models: 'play',
      spin: !options.spin,
    }
    assert.equal(presetOf(keptChanged, wholeEntry), preset, name)
    for (const move of moves) {
      const moved: ViewOptions = { ...options, ...move }
      const label = `${name}: ${JSON.stringify(move)}`
      for (const key of optionKeys) {
        if (moved[key] === options[key]) continue
        // A control the look shows has moved, so it's the preset's look no longer; one it hides draws nothing
        // different, whatever it holds
        const shows = optionShows(key, options, wholeEntry)
        assert.equal(presetOf(moved, wholeEntry), shows ? undefined : preset, label)
      }
    }
  }
  // Every option of the look is among the moves
  const movedKeys = new Set(moves.flatMap((move) => Object.keys(move)))
  for (const key of optionKeys) {
    assert.equal(movedKeys.has(key) || keptOptions.includes(key) || key === 'style', true, key)
  }
})

void test('a preset is found by the controls the panel shows for the entry', () => {
  // Alternates left on all, from an entry that has alternates, makes a see-through layer only in an entry that has
  // them. In one that has none the glossy look stays solid, so its AO shows and its back shell hides
  const glossy = presets[0]
  const noAlternates: EntryHolds = { ...wholeEntry, alternates: false }
  const aoMoved: ViewOptions = { ...glossy.options, conformations: 'all', ao: 0.5 }
  const shellLeftOn: ViewOptions = { ...glossy.options, conformations: 'all', backShell: true }
  assert.equal(presetOf(aoMoved, noAlternates), undefined)
  assert.equal(presetOf(shellLeftOn, noAlternates), glossy)
  // In one that has them the alternates are see-through, so AO hides and the back shell shows
  assert.equal(presetOf(aoMoved, wholeEntry), glossy)
  assert.equal(presetOf(shellLeftOn, wholeEntry), undefined)
})

void test('every effect a preset turns on acts in its look', () => {
  for (const { name, options } of presets) {
    // Ambient occlusion acts only while everything drawn is opaque
    if (options.ao > 0) assert.equal(isOpaque(options, wholeEntry), true, name)
    // The back shell is drawn only under the see-through spheres or the see-through surface
    if (options.backShell) assert.equal(isBackShell(options, wholeEntry), true, name)
    // Blend acts on the soft splats alone, and Detail on the splats
    if (options.blend !== 'normal') assert.equal(options.style, 'soft', name)
    if (options.detail !== 'auto') assert.equal(styleOf(options.style).kind, 'splats', name)
    // Thermal steps aside while Ellipsoids is on
    if (options.thermal > 0) assert.equal(options.ellipsoids, false, name)
  }
})
