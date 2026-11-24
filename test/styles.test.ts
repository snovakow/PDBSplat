import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Blend, Conformations, ViewOptions } from '../src/options.ts'
import {
  compositeOf,
  hasGhosts,
  hasSolids,
  isBackShell,
  isOpaque,
  isWeighted,
  leavesOutOfFocus,
  styleOf,
  styles,
  type Composite,
  type Style,
} from '../src/viewer/styles.ts'

// The truth table of the splats' composites and the layered spheres' layers, and the styles' lookup

type Options = Pick<ViewOptions, 'style' | 'blend' | 'opacity' | 'focus' | 'fade' | 'conformations' | 'backShell'>

const styleIds: Style[] = ['soft', 'spheres', 'surface', 'field']
const blends: Blend[] = ['normal', 'glow']
const opacities = [0, 0.5, 0.9, 1]
const focuses: Pick<Options, 'focus' | 'fade'>[] = [
  { focus: 'all', fade: 0.15 },
  { focus: 'ligands', fade: 0.15 },
  { focus: 'ligands', fade: 1 },
  { focus: 'backbone', fade: 0 },
  { focus: 'residue', fade: 0.5 },
]
const conformations: Conformations[] = ['first', 'all']

// Every combination of the options the rules read
function* combinations(): Generator<Options> {
  for (const style of styleIds) {
    for (const blend of blends) {
      for (const opacity of opacities) {
        for (const focus of focuses) {
          for (const conformation of conformations) {
            for (const backShell of [false, true]) {
              yield { style, blend, opacity, ...focus, conformations: conformation, backShell }
            }
          }
        }
      }
    }
  }
}

// The rules as the README states them. The spheres are layered by depth, and take no Blend; the soft splats glow under
// the glow Blend and are summed by weight under the normal one; and the surface and the field draw no splats
function composite(options: Options): Composite | null {
  if (options.style === 'spheres') return 'layered'
  if (options.style !== 'soft') return null
  return options.blend === 'glow' ? 'glow' : 'summed'
}

// Whether some atom is see-through without being hidden: below full Opacity, faded by Focus to more than nothing,
// which the ligands' Focus does only in an entry that has ligands, or an alternate at its occupancy's share, in an
// entry that has alternates
function seeThrough(options: Options, alternates: boolean, ligands: boolean) {
  const outOfFocus = options.focus !== 'all' && (options.focus !== 'ligands' || ligands)
  const faded = outOfFocus && options.fade > 0 && options.fade < 1
  return options.opacity < 1 || faded || (options.conformations === 'all' && alternates)
}

// What an entry may hold of what the layers ask of it, in every combination
const entries = [false, true].flatMap((alternates) => [false, true].map((ligands) => ({ alternates, ligands })))

void test('the truth table of the composites, the layers, opaque and back shell over every combination', () => {
  let rows = 0
  let layeredRows = 0
  for (const options of combinations()) {
    for (const held of entries) {
      rows++
      const { alternates, ligands } = held
      const expected = composite(options)
      const layered = expected === 'layered'
      if (layered) layeredRows++
      const label = `${JSON.stringify(options)}, alternates ${alternates}, ligands ${ligands}`
      const ghosts = layered && seeThrough(options, alternates, ligands)
      assert.equal(compositeOf(options), expected, label)
      // Every splat style has a composite, none of which sorts its splats, and the surface and the field have none
      assert.equal(expected !== null, styleOf(options.style).kind === 'splats', label)
      assert.equal(isWeighted(options), expected === 'summed', label)
      assert.equal(hasGhosts(options, held), ghosts, label)
      assert.equal(hasSolids(options), layered && options.opacity === 1, label)
      // The layered spheres always have a layer to draw
      if (layered) assert.equal(hasSolids(options) || hasGhosts(options, held), true, label)
      const surface = options.style === 'surface'
      assert.equal(isOpaque(options, held), (layered && !ghosts) || (surface && options.opacity === 1), label)
      // The back shell is for the spheres and the surface below full Opacity, whatever else is see-through
      const hollow = (layered || surface) && options.opacity < 1
      assert.equal(isBackShell(options), options.backShell && hollow, label)
      // It's never drawn where the view is opaque, nor with a solid layer, which would hide it
      assert.equal(isBackShell(options) && isOpaque(options, held), false, label)
      assert.equal(isBackShell(options) && hasSolids(options), false, label)
    }
  }
  assert.equal(rows, 4 * 2 * 4 * 5 * 2 * 2 * 4)
  // Layered: the spheres, whatever the rest, the Blend among it
  assert.equal(layeredRows, 2 * 4 * 5 * 2 * 2 * 4)
})

void test('Focus leaves atoms out of focus but on all, and the ligands\' only in an entry that has ligands', () => {
  for (const ligands of [false, true]) {
    assert.equal(leavesOutOfFocus({ focus: 'all' }, { ligands }), false)
    assert.equal(leavesOutOfFocus({ focus: 'ligands' }, { ligands }), ligands)
    assert.equal(leavesOutOfFocus({ focus: 'backbone' }, { ligands }), true)
    // A picked Focus counts before any atom is picked
    assert.equal(leavesOutOfFocus({ focus: 'residue' }, { ligands }), true)
    assert.equal(leavesOutOfFocus({ focus: 'chain' }, { ligands }), true)
  }
})

void test('the rows the README names', () => {
  // An entry with alternates to draw and ligands to keep in focus, and one with neither
  const held = { alternates: true, ligands: true }
  const bare = { alternates: false, ligands: false }
  const spheres: Options = {
    style: 'spheres',
    blend: 'normal',
    opacity: 1,
    focus: 'all',
    fade: 0.15,
    conformations: 'first',
    backShell: false,
  }
  // At full Opacity with nothing faded, the spheres are solid and hide what's behind them
  assert.equal(hasSolids(spheres), true)
  assert.equal(hasGhosts(spheres, held), false)
  assert.equal(isOpaque(spheres, held), true)
  assert.equal(isBackShell({ ...spheres, backShell: true }), false)
  // Below it, every atom is in the see-through layer, which the back shell is drawn under
  assert.equal(hasSolids({ ...spheres, opacity: 0.9 }), false)
  assert.equal(hasGhosts({ ...spheres, opacity: 0.9 }, held), true)
  assert.equal(isOpaque({ ...spheres, opacity: 0.9 }, held), false)
  assert.equal(isBackShell({ ...spheres, opacity: 0.9, backShell: true }), true)
  assert.equal(isBackShell({ ...spheres, opacity: 0.9 }), false)
  // Atoms that Focus fades are see-through over the solid ones in focus, and one layer, as the back shell isn't
  // drawn among solid spheres
  const faded: Options = { ...spheres, focus: 'ligands', fade: 0.15 }
  assert.equal(hasSolids(faded), true)
  assert.equal(hasGhosts(faded, held), true)
  assert.equal(isOpaque(faded, held), false)
  assert.equal(isBackShell({ ...faded, backShell: true }), false)
  assert.equal(isBackShell({ ...faded, opacity: 0.9, backShell: true }), true)
  // In an entry without ligands their Focus keeps every atom, so nothing is faded and the spheres stay solid alone,
  // while the backbone's Focus fades its side chains as in any entry
  assert.equal(hasGhosts(faded, bare), false)
  assert.equal(isOpaque(faded, bare), true)
  assert.equal(hasGhosts({ ...faded, focus: 'backbone' }, bare), true)
  // Fade at 0 hides them, and at 1 leaves them whole, so the spheres stay solid alone
  assert.equal(hasGhosts({ ...spheres, focus: 'backbone', fade: 0 }, held), false)
  assert.equal(isOpaque({ ...spheres, focus: 'backbone', fade: 0 }, held), true)
  assert.equal(hasGhosts({ ...spheres, focus: 'ligands', fade: 1 }, held), false)
  // A picked Focus counts before any atom is picked
  assert.equal(hasGhosts({ ...spheres, focus: 'residue', fade: 0.5 }, held), true)
  // Every alternate at once is see-through by its occupancy, in an entry that has alternates; in one that has none
  // the setting draws nothing different, and the spheres stay solid
  assert.equal(hasGhosts({ ...spheres, conformations: 'all' }, held), true)
  const everyAlternate: Options = { ...spheres, conformations: 'all', backShell: true }
  assert.equal(isBackShell(everyAlternate), false)
  assert.equal(hasGhosts({ ...spheres, conformations: 'all' }, bare), false)
  assert.equal(isOpaque({ ...spheres, conformations: 'all' }, bare), true)
  // The spheres take no Blend, so they're layered the same whichever one the soft splats were left on
  const leftOnGlow: Options = { ...spheres, blend: 'glow' }
  assert.equal(compositeOf(leftOnGlow), 'layered')
  assert.equal(hasSolids(leftOnGlow), true)
  assert.equal(isOpaque(leftOnGlow, held), true)
  assert.equal(isWeighted(leftOnGlow), false)
  // The soft splats have no layers, and are never opaque
  const soft: Options = { ...spheres, style: 'soft' }
  assert.equal(hasSolids(soft), false)
  assert.equal(hasGhosts({ ...soft, opacity: 0.5 }, held), false)
  assert.equal(isOpaque(soft, held), false)
  assert.equal(isBackShell({ ...soft, opacity: 0.5, backShell: true }), false)
  // The surface is opaque at full Opacity, and takes the back shell below it
  const surface: Options = { ...spheres, style: 'surface' }
  assert.equal(isOpaque(surface, held), true)
  assert.equal(isOpaque({ ...surface, opacity: 0.9 }, held), false)
  assert.equal(isBackShell({ ...surface, opacity: 0.9, backShell: true }), true)
  assert.equal(isBackShell({ ...surface, opacity: 1, backShell: true }), false)
  assert.equal(isBackShell({ ...surface, opacity: 0.9 }), false)
  // The field is neither
  const field: Options = { ...spheres, style: 'field' }
  assert.equal(isOpaque(field, held), false)
  assert.equal(isBackShell({ ...field, opacity: 0.9, backShell: true }), false)
})

void test('the soft splats are summed by weight under the normal Blend, and nothing else is', () => {
  assert.equal(isWeighted({ style: 'soft', blend: 'normal' }), true)
  assert.equal(isWeighted({ style: 'soft', blend: 'glow' }), false)
  assert.equal(isWeighted({ style: 'spheres', blend: 'normal' }), false)
  assert.equal(isWeighted({ style: 'spheres', blend: 'glow' }), false)
  assert.equal(isWeighted({ style: 'surface', blend: 'normal' }), false)
  assert.equal(isWeighted({ style: 'field', blend: 'normal' }), false)
})

void test('styleOf finds each style, and falls back to the first for an unknown id', () => {
  assert.deepEqual(
    styles.map((entry) => entry.id),
    ['soft', 'spheres', 'surface', 'field'],
  )
  for (const entry of styles) assert.equal(styleOf(entry.id), entry)
  assert.equal(styleOf('soft').kind, 'splats')
  assert.equal(styleOf('spheres').kind, 'splats')
  assert.equal(styleOf('surface').kind, 'surface')
  assert.equal(styleOf('field').kind, 'volume')
  // An id the type doesn't allow, as a stale setting might hold, falls back to the first style
  const stale: { style: Style } = { style: 'soft' }
  Object.assign(stale, { style: 'unknown' })
  assert.equal(styleOf(stale.style), styles[0])
})
