import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultOptions,
  isOption,
  optionKeys,
  viewOptions,
  wholeEntry,
  type Conformations,
  type EntryHolds,
  type ViewOptions,
} from '../src/options.ts'
import { optionShows } from '../src/shownOptions.ts'
import {
  compositeOf,
  hasGhosts,
  hasSolids,
  isBackShell,
  isOpaque,
  isWeighted,
  type Style,
} from '../src/viewer/styles.ts'

// Which controls the panel shows: each only while the other options and the entry leave it something to change, so
// that a hidden control's value changes nothing that's drawn, and no control shows that would draw the same picture
// wherever it's set

const styleIds: Style[] = ['soft', 'spheres', 'surface', 'field']
const focuses: Pick<ViewOptions, 'focus' | 'fade'>[] = [
  { focus: 'all', fade: 0.15 },
  { focus: 'ligands', fade: 0.15 },
  { focus: 'backbone', fade: 0 },
]
const alternates: Conformations[] = ['first', 'all']

// An entry that holds nothing a control acts on: one model, no alternates, no waters, no hydrogens and no ligands
const bareEntry: EntryHolds = { models: false, alternates: false, waters: false, hydrogens: false, ligands: false }

// The options the tests of the controls read, in every combination, over the opening look
function* combinations(): Generator<ViewOptions> {
  for (const style of styleIds) {
    for (const opacity of [1, 0.5]) {
      for (const focus of focuses) {
        for (const conformations of alternates) {
          for (const highlight of [0, 0.7]) {
            for (const ao of [0, 1]) {
              for (const bloom of [0, 1]) {
                for (const ellipsoids of [false, true]) {
                  yield { ...defaultOptions, style, opacity, ...focus, conformations, highlight, ao, bloom, ellipsoids }
                }
              }
            }
          }
        }
      }
    }
  }
}

// What the scene draws by, of the rules the options and the entry decide: the composite, the layers, the back shell,
// and whether ambient occlusion acts
function drawnBy(options: ViewOptions, entry: EntryHolds) {
  return {
    composite: compositeOf(options),
    weighted: isWeighted(options),
    solids: hasSolids(options),
    ghosts: hasGhosts(options, entry),
    backShell: isBackShell(options),
    occlusion: options.ao > 0 && isOpaque(options, entry),
  }
}

void test('each control shows for its styles, and only while the other options leave it something to change', () => {
  const always: (keyof ViewOptions)[] = [
    'style',
    'scale',
    'opacity',
    'colorBy',
    'burial',
    'spin',
    'depthCue',
    'clip',
    'bloom',
  ]
  let rows = 0
  for (const options of combinations()) {
    for (const entry of [wholeEntry, bareEntry]) {
      rows++
      const label = `${JSON.stringify(options)} in ${JSON.stringify(entry)}`
      const shows = (option: keyof ViewOptions) => optionShows(option, options, entry)
      const soft = options.style === 'soft'
      const splats = soft || options.style === 'spheres'
      const solid = options.style === 'spheres' || options.style === 'surface'
      const opaque = isOpaque(options, entry)
      for (const option of always) assert.equal(shows(option), true, `${option}: ${label}`)
      assert.equal(shows('resolution'), !splats, label)
      // Hardness and Blend are the soft splats' alone: the spheres are always layered, and take no Blend
      assert.equal(shows('hardness'), soft, label)
      assert.equal(shows('blend'), soft, label)
      assert.equal(shows('detail'), splats, label)
      assert.equal(shows('ellipsoids'), splats, label)
      assert.equal(shows('focus'), splats, label)
      // The spheres and the surface are lit alike, with Shininess only while there's a highlight to tighten
      assert.equal(shows('shading'), solid, label)
      assert.equal(shows('highlight'), solid, label)
      assert.equal(shows('outline'), solid, label)
      assert.equal(shows('shininess'), solid && options.highlight > 0, label)
      // The back shell below full Opacity, and ambient occlusion while everything drawn is opaque: never both, and
      // neither while the spheres at full Opacity have a see-through layer over their solid one
      assert.equal(shows('backShell'), solid && options.opacity < 1, label)
      assert.equal(shows('ao'), solid && opaque, label)
      assert.equal(shows('backShell') && shows('ao'), false, label)
      // A control hidden takes with it the one that depends on it: AO's radius goes with AO, whatever AO is set to
      assert.equal(shows('aoRadius'), shows('ao') && options.ao > 0, label)
      assert.equal(shows('bloomRadius'), options.bloom > 0, label)
      assert.equal(shows('bloomThreshold'), options.bloom > 0, label)
      assert.equal(shows('thermal'), splats && !options.ellipsoids, label)
      // Fade only while Focus leaves atoms out of focus, which the ligands' doesn't in an entry without ligands
      const outOfFocus = options.focus !== 'all' && (options.focus !== 'ligands' || entry.ligands)
      assert.equal(shows('fade'), splats && outOfFocus, label)
      // The four that choose the atoms shown, each only for an entry that holds what it chooses among
      assert.equal(shows('hydrogens'), entry.hydrogens, label)
      assert.equal(shows('waters'), entry.waters, label)
      assert.equal(shows('models'), entry.models, label)
      assert.equal(shows('conformations'), entry.alternates, label)
    }
  }
  assert.equal(rows, 4 * 2 * 3 * 2 * 2 * 2 * 2 * 2 * 2)
})

void test('each of the four that choose the atoms shown follows what the entry holds, by itself', () => {
  const holding = (held: Partial<EntryHolds>): EntryHolds => ({ ...bareEntry, ...held })
  assert.equal(optionShows('models', defaultOptions, holding({ models: true })), true)
  const allButModels = holding({ alternates: true, waters: true, hydrogens: true })
  assert.equal(optionShows('models', defaultOptions, allButModels), false)
  assert.equal(optionShows('conformations', defaultOptions, holding({ alternates: true })), true)
  assert.equal(optionShows('conformations', defaultOptions, holding({ models: true })), false)
  assert.equal(optionShows('waters', defaultOptions, holding({ waters: true })), true)
  assert.equal(optionShows('waters', defaultOptions, holding({ hydrogens: true })), false)
  assert.equal(optionShows('hydrogens', defaultOptions, holding({ hydrogens: true })), true)
  assert.equal(optionShows('hydrogens', defaultOptions, holding({ waters: true })), false)
})

void test('every control shows for some options', () => {
  const seen = new Set<string>()
  for (const options of combinations()) {
    for (const option of optionKeys) if (optionShows(option, options, wholeEntry)) seen.add(option)
  }
  assert.deepEqual([...seen].sort(), [...optionKeys].sort())
})

void test('a hidden control changes nothing that is drawn, nor which controls show', () => {
  // Each a move of one control, to a value it doesn't hold in some combination
  const moves: Partial<ViewOptions>[] = [
    { blend: 'glow' },
    { backShell: true },
    { ao: 0.5 },
    { aoRadius: 8 },
    { shininess: 8 },
    { shading: 0.2 },
    { outline: 0.2 },
    { hardness: 1 },
    { fade: 0.5 },
    { thermal: 2 },
    { detail: 'residues' },
    { resolution: 3 },
    { bloomRadius: 0.9 },
    { conformations: 'all' },
    { conformations: 'first' },
    { models: 'all' },
    { waters: true },
    { hydrogens: false },
  ]
  const hiddenMoves = new Set<Partial<ViewOptions>>()
  for (const options of combinations()) {
    for (const entry of [wholeEntry, bareEntry]) {
      for (const move of moves) {
        const moved = Object.keys(move).filter(isOption)
        if (moved.some((option) => optionShows(option, options, entry))) continue
        hiddenMoves.add(move)
        const after: ViewOptions = { ...options, ...move }
        const label = `${JSON.stringify(move)} on ${JSON.stringify(options)} in ${JSON.stringify(entry)}`
        assert.deepEqual(drawnBy(after, entry), drawnBy(options, entry), label)
        for (const option of optionKeys) {
          assert.equal(optionShows(option, after, entry), optionShows(option, options, entry), label)
        }
      }
    }
  }
  // Every move is of a control that's hidden somewhere
  assert.equal(hiddenMoves.size, moves.length)
})

void test("a control that waits on a slider shows from the slider's first step in from one end, and hides only at that end", () => {
  const waiting: (keyof ViewOptions)[] = ['shininess', 'aoRadius', 'bloomRadius', 'bloomThreshold']
  // They're the controls that wait on a slider's being above its low end
  const { highlight, ao, bloom } = viewOptions
  const lowEnds = new Map([
    ['highlight', highlight.min],
    ['ao', ao.min],
    ['bloom', bloom.min],
  ])
  const found = optionKeys.filter((key) => {
    const { shownWhile } = viewOptions[key]
    if (!shownWhile || !('above' in shownWhile)) return false
    assert.equal(shownWhile.above, lowEnds.get(shownWhile.option), key)
    return true
  })
  assert.deepEqual(found.sort(), [...waiting].sort())
  // The opening look shows all three sliders, so the controls waiting on them follow them alone
  const lowest: ViewOptions = { ...defaultOptions, highlight: highlight.min, ao: ao.min, bloom: bloom.min }
  const first: ViewOptions = {
    ...defaultOptions,
    highlight: highlight.min + highlight.step,
    ao: ao.min + ao.step,
    bloom: bloom.min + bloom.step,
  }
  for (const option of waiting) {
    assert.equal(optionShows(option, lowest, wholeEntry), false, option)
    assert.equal(optionShows(option, first, wholeEntry), true, option)
  }
  // The back shell waits the other way: on Opacity being below its high end, from its first step down
  const { opacity } = viewOptions
  assert.deepEqual(viewOptions.backShell.shownWhile, { option: 'opacity', below: opacity.max })
  const justBelow: ViewOptions = { ...defaultOptions, opacity: opacity.max - opacity.step }
  assert.equal(optionShows('backShell', justBelow, wholeEntry), true)
  assert.equal(optionShows('backShell', { ...defaultOptions, opacity: opacity.max }, wholeEntry), false)
})

void test('the opening look shows ambient occlusion, and neither the back shell nor a Blend', () => {
  assert.equal(optionShows('ao', defaultOptions, wholeEntry), true)
  assert.equal(optionShows('aoRadius', defaultOptions, wholeEntry), true)
  assert.equal(optionShows('shininess', defaultOptions, wholeEntry), true)
  assert.equal(optionShows('backShell', defaultOptions, wholeEntry), false)
  assert.equal(optionShows('blend', defaultOptions, wholeEntry), false)
  // Below full Opacity the spheres are see-through: the back shell shows, and ambient occlusion, which no longer
  // acts, goes with its radius
  const glass: ViewOptions = { ...defaultOptions, opacity: 0.5 }
  assert.equal(optionShows('backShell', glass, wholeEntry), true)
  assert.equal(optionShows('ao', glass, wholeEntry), false)
  assert.equal(optionShows('aoRadius', glass, wholeEntry), false)
  // At full Opacity the atoms that Focus fades are one see-through layer over the solid ones, which neither acts on
  const faded: ViewOptions = { ...defaultOptions, focus: 'ligands', fade: 0.15 }
  assert.equal(optionShows('backShell', faded, wholeEntry), false)
  assert.equal(optionShows('ao', faded, wholeEntry), false)
  // In an entry without ligands their Focus keeps every atom solid: Fade, with nothing to fade, hides, and ambient
  // occlusion stays. The backbone's Focus fades its side chains in any entry
  assert.equal(optionShows('fade', faded, wholeEntry), true)
  assert.equal(optionShows('fade', faded, bareEntry), false)
  assert.equal(optionShows('ao', faded, bareEntry), true)
  assert.equal(optionShows('aoRadius', faded, bareEntry), true)
  const sideChainsFaded: ViewOptions = { ...faded, focus: 'backbone' }
  assert.equal(optionShows('fade', sideChainsFaded, bareEntry), true)
  assert.equal(optionShows('ao', sideChainsFaded, bareEntry), false)
  // Fade is the splats' alone, so the surface hides it whatever Focus was left on
  assert.equal(optionShows('fade', { ...faded, style: 'surface' }, wholeEntry), false)
  // Alternates left on all draws nothing see-through in an entry that has none, so ambient occlusion stays
  const all: ViewOptions = { ...defaultOptions, conformations: 'all' }
  assert.equal(optionShows('ao', all, wholeEntry), false)
  assert.equal(optionShows('ao', all, bareEntry), true)
})
