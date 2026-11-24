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
import { customLook, presetList, presetOf, presets, withPreset } from '../src/presets.ts'
import { optionShows } from '../src/shownOptions.ts'
import { compositeOf, hasGhosts, hasSolids, isBackShell, isOpaque, styleOf, styles } from '../src/viewer/styles.ts'

// The presets: that each is a whole set of options the panel can show, that the page opens on one, that choosing one
// sets its look and leaves the atoms shown and Spin as they were, that each is found from its own options, whatever
// its hidden controls hold, and none once a control of the look moves, by the controls the panel shows for the entry,
// that the Preset list offers custom only while it reads it, that every effect a preset turns on acts in its look,
// and that between them they show every style and every way the renderer lays the atoms over one another

// The options a preset leaves as they are: those that choose which atoms are shown, and Spin, which moves the view
const keptOptions: string[] = ['hydrogens', 'waters', 'models', 'conformations', 'spin']

void test('each preset is a whole set of options the panel can show, under a name of its own', () => {
  const names = presets.map((preset) => preset.name)
  assert.equal(new Set(names).size, names.length)
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

void test('the page opens on the first preset, the space-filling model, whose options the defaults are', () => {
  assert.equal(presets[0].name, 'space-filling')
  assert.deepEqual(presets[0].options, defaultOptions)
  assert.equal(presetOf(defaultOptions, wholeEntry), presets[0])
  // And before an entry loads, when the entry holds nothing
  const nothing: EntryHolds = { models: false, alternates: false, waters: false, hydrogens: false, ligands: false }
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
  // them. In one that has none the opening look stays solid, so its AO shows, and a move of it leaves the preset
  const opening = presets[0]
  const noAlternates: EntryHolds = { ...wholeEntry, alternates: false }
  const aoMoved: ViewOptions = { ...opening.options, conformations: 'all', ao: 0.5 }
  assert.equal(presetOf(aoMoved, noAlternates), undefined)
  // In one that has them the alternates are see-through, so AO hides, and holds what it likes
  assert.equal(presetOf(aoMoved, wholeEntry), opening)
  // The back shell hides at the look's full Opacity in either, so one left on is the preset's look still
  const shellLeftOn: ViewOptions = { ...opening.options, conformations: 'all', backShell: true }
  assert.equal(presetOf(shellLeftOn, noAlternates), opening)
  assert.equal(presetOf(shellLeftOn, wholeEntry), opening)
  // The ligands' Focus fades the rest of an entry that has ligands, where Fade shows and AO, which acts on nothing
  // see-through, hides. In an entry without any, every atom stays solid: Fade hides, and AO shows
  const ligandFocus = presets.find((preset) => preset.options.focus === 'ligands')
  assert.ok(ligandFocus)
  const noLigands: EntryHolds = { ...wholeEntry, ligands: false }
  const fadeMoved: ViewOptions = { ...ligandFocus.options, fade: 0.55 }
  assert.equal(presetOf(fadeMoved, wholeEntry), undefined)
  assert.equal(presetOf(fadeMoved, noLigands), ligandFocus)
  const occlusionMoved: ViewOptions = { ...ligandFocus.options, ao: 0.35 }
  assert.equal(presetOf(occlusionMoved, wholeEntry), ligandFocus)
  assert.equal(presetOf(occlusionMoved, noLigands), undefined)
  // Every preset keeps a look of its own in such an entry
  for (const preset of presets) assert.equal(presetOf(preset.options, noLigands), preset, preset.name)
})

void test('the Preset list offers custom only while custom is what it reads', () => {
  const names = presets.map((preset) => preset.name)
  // No preset goes by the name the list reads for none
  assert.equal(names.includes(customLook), false)
  // A preset's look reads its name, among the presets alone: choosing custom would set nothing
  for (const preset of presets) {
    assert.deepEqual(presetList(preset.options, wholeEntry), { reads: preset.name, names })
  }
  // Once a control of the look has moved, the list reads custom, which it lists then, after the presets
  const moved: ViewOptions = { ...presets[0].options, scale: 1.35 }
  assert.deepEqual(presetList(moved, wholeEntry), { reads: customLook, names: [...names, customLook] })
  // Either list is the same array each time, so that the panel builds its list again only when the names change
  assert.equal(presetList(moved, wholeEntry).names, presetList({ ...moved, scale: 1.4 }, wholeEntry).names)
  assert.equal(presetList(presets[0].options, wholeEntry).names, presetList(presets[1].options, wholeEntry).names)
})

void test('every effect a preset turns on acts in its look', () => {
  const noLigands: EntryHolds = { ...wholeEntry, ligands: false }
  for (const { name, options } of presets) {
    // Ambient occlusion acts only while everything drawn is opaque, which the ligands' Focus leaves it in an entry
    // without ligands, and no other Focus that fades does
    const opaque = isOpaque(options, wholeEntry) || (options.focus === 'ligands' && isOpaque(options, noLigands))
    if (options.ao > 0) assert.equal(opaque, true, name)
    // The back shell is drawn only below full Opacity, under the spheres or the surface
    if (options.backShell) assert.equal(isBackShell(options), true, name)
    // Blend acts on the soft splats alone, and Detail on the splats
    if (options.blend !== 'normal') assert.equal(options.style, 'soft', name)
    if (options.detail !== 'auto') assert.equal(styleOf(options.style).kind, 'splats', name)
    // Thermal steps aside while Ellipsoids is on
    if (options.thermal > 0) assert.equal(options.ellipsoids, false, name)
  }
})

void test('between them the presets show every style, and every way the renderer lays the atoms over one another', () => {
  const looks = presets.map((preset) => preset.options)
  // Each of the four styles
  assert.deepEqual(new Set(looks.map((options) => options.style)), new Set(styles.map((style) => style.id)))
  // The soft splats summed and glowing, and the spheres layered
  const composites = new Set(looks.map((options) => compositeOf(options)))
  assert.deepEqual(composites, new Set(['layered', 'summed', 'glow', null]))
  // The spheres' layers: solid alone, see-through alone with its back shell, and a see-through layer over solids
  const layers = (options: ViewOptions) =>
    [hasSolids(options), hasGhosts(options, wholeEntry), isBackShell(options)].join(' ')
  const drawn = new Set(looks.filter((options) => options.style === 'spheres').map(layers))
  assert.deepEqual(drawn, new Set(['true false false', 'false true true', 'true true false']))
  // And the atoms as themselves and merged into their residues' ellipsoids
  assert.ok(looks.some((options) => options.detail === 'residues'))
})
