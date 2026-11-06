import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Blend, Conformations, Models, ViewOptions } from '../src/options.ts'
import {
  depthWriteOpacity,
  isDepthWritten,
  isOpaque,
  isSolid,
  isWeighted,
  isWholeSpheres,
  styleOf,
  styles,
  type Style,
} from '../src/viewer/styles.ts'

// The truth table of the spheres' depth rules and the styles' lookup

type Options = Pick<ViewOptions, 'style' | 'blend' | 'opacity' | 'focus' | 'fade' | 'models' | 'conformations' | 'ellipsoids'>

const styleIds: Style[] = ['soft', 'spheres', 'surface']
const blends: Blend[] = ['normal', 'glow', 'weighted']
const opacities = [0.5, depthWriteOpacity, 0.9, 1]
const focuses: Pick<Options, 'focus' | 'fade'>[] = [
  { focus: 'all', fade: 0.15 },
  { focus: 'ligands', fade: 0.15 },
  { focus: 'ligands', fade: 1 },
  { focus: 'residue', fade: 0 },
]
const models: Models[] = ['first', 'all', 'play']
const conformations: Conformations[] = ['first', 'all']

// Every combination of the options the rules read
function* combinations(): Generator<Options> {
  for (const style of styleIds) {
    for (const blend of blends) {
      for (const opacity of opacities) {
        for (const focus of focuses) {
          for (const shown of models) {
            for (const conformation of conformations) {
              for (const ellipsoids of [false, true]) {
                yield { style, blend, opacity, ...focus, models: shown, conformations: conformation, ellipsoids }
              }
            }
          }
        }
      }
    }
  }
}

// The rules as the README states them: the spheres are whole and round in the spheres style and normal Blend, with
// Focus on all or Fade at full, Models and Alternates on first, and Ellipsoids off; solid at full Opacity; depth-written
// from two thirds up to full; and the view is opaque with solid spheres or the surface at full Opacity
function wholeSpheres(options: Options) {
  const faded = options.focus !== 'all' && options.fade < 1
  return (
    options.style === 'spheres' &&
    options.blend === 'normal' &&
    !faded &&
    options.models === 'first' &&
    options.conformations === 'first' &&
    !options.ellipsoids
  )
}

void test('the depth-write Opacity is two thirds', () => {
  assert.equal(depthWriteOpacity, 2 / 3)
})

void test('the truth table of whole, solid, depth-written and opaque over every combination', () => {
  let rows = 0
  let whole = 0
  for (const options of combinations()) {
    rows++
    const expected = wholeSpheres(options)
    if (expected) whole++
    const label = JSON.stringify(options)
    assert.equal(isWholeSpheres(options), expected, label)
    assert.equal(isSolid(options), expected && options.opacity === 1, label)
    assert.equal(isDepthWritten(options), expected && options.opacity >= 2 / 3 && options.opacity < 1, label)
    assert.equal(isOpaque(options), (expected && options.opacity === 1) || (options.style === 'surface' && options.opacity === 1), label)
    // No combination is both solid and depth-written
    assert.equal(isSolid(options) && isDepthWritten(options), false, label)
  }
  assert.equal(rows, 3 * 3 * 4 * 4 * 3 * 2 * 2)
  // Whole spheres: normal spheres at every Opacity, with two of the four focuses, Models and Alternates first and Ellipsoids off
  assert.equal(whole, 4 * 2)
})

void test('the rows the README names', () => {
  const spheres: Options = {
    style: 'spheres',
    blend: 'normal',
    opacity: 1,
    focus: 'all',
    fade: 0.15,
    models: 'first',
    conformations: 'first',
    ellipsoids: false,
  }
  assert.equal(isSolid(spheres), true)
  assert.equal(isDepthWritten(spheres), false)
  assert.equal(isOpaque(spheres), true)
  assert.equal(isSolid({ ...spheres, opacity: 0.9 }), false)
  assert.equal(isDepthWritten({ ...spheres, opacity: 0.9 }), true)
  assert.equal(isDepthWritten({ ...spheres, opacity: 2 / 3 }), true)
  assert.equal(isDepthWritten({ ...spheres, opacity: 0.5 }), false)
  assert.equal(isOpaque({ ...spheres, opacity: 0.9 }), false)
  assert.equal(isWholeSpheres({ ...spheres, focus: 'ligands', fade: 1 }), true)
  assert.equal(isWholeSpheres({ ...spheres, focus: 'ligands', fade: 0.99 }), false)
  assert.equal(isWholeSpheres({ ...spheres, blend: 'glow' }), false)
  assert.equal(isWholeSpheres({ ...spheres, blend: 'weighted' }), false)
  assert.equal(isWholeSpheres({ ...spheres, models: 'all' }), false)
  assert.equal(isWholeSpheres({ ...spheres, conformations: 'all' }), false)
  assert.equal(isWholeSpheres({ ...spheres, ellipsoids: true }), false)
  assert.equal(isWholeSpheres({ ...spheres, style: 'soft' }), false)
  const surface: Options = { ...spheres, style: 'surface' }
  assert.equal(isOpaque(surface), true)
  assert.equal(isSolid(surface), false)
  assert.equal(isWholeSpheres(surface), false)
  assert.equal(isOpaque({ ...surface, opacity: 0.9 }), false)
  // The surface takes no Blend, so glow or weighted leaves it opaque at full Opacity
  assert.equal(isOpaque({ ...surface, blend: 'weighted' }), true)
})

void test('isWeighted is the weighted Blend in a splat style', () => {
  assert.equal(isWeighted({ style: 'soft', blend: 'weighted' }), true)
  assert.equal(isWeighted({ style: 'spheres', blend: 'weighted' }), true)
  assert.equal(isWeighted({ style: 'surface', blend: 'weighted' }), false)
  assert.equal(isWeighted({ style: 'soft', blend: 'normal' }), false)
  assert.equal(isWeighted({ style: 'spheres', blend: 'glow' }), false)
})

void test('styleOf finds each style, and falls back to the first for an unknown id', () => {
  assert.deepEqual(
    styles.map((entry) => entry.id),
    ['soft', 'spheres', 'surface'],
  )
  for (const entry of styles) assert.equal(styleOf(entry.id), entry)
  assert.equal(styleOf('soft').kind, 'splats')
  assert.equal(styleOf('spheres').kind, 'splats')
  assert.equal(styleOf('surface').kind, 'surface')
  // An id the type doesn't allow, as a stale setting might hold, falls back to the first style
  const stale: { style: Style } = { style: 'soft' }
  Object.assign(stale, { style: 'unknown' })
  assert.equal(styleOf(stale.style), styles[0])
})
