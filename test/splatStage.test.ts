import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Group } from 'three'
import { defaultOptions } from '../src/options.ts'
import { vdwRadii } from '../src/pdb/elements.ts'
import { mergeLevels } from '../src/pdb/merge.ts'
import { StructureBuilder, type AtomRecord, type Structure } from '../src/pdb/structure.ts'
import { shownAtoms, shownChoice } from '../src/store.ts'
import type { TablePaint } from '../src/viewer/atomTable.ts'
import { createPool } from '../src/viewer/ellipsoidGeometry.ts'
import { levels } from '../src/viewer/levels.ts'
import { pieceCount, PieceTable, planesSize } from '../src/viewer/pieces.ts'
import { poolSize, SplatContent } from '../src/viewer/splatContent.ts'
import { drawLevel, showNothing, type Frames, type Stage } from '../src/viewer/splatStage.ts'

// What the splats are drawn from as the shown atoms change: an entry drawn, then shown with no atoms at all, then shown
// again

// An entry of waters alone, which Waters off shows none of
function watersAlone(): Structure {
  const builder = new StructureBuilder()
  for (let water = 0; water < 40; water++) {
    const atom: AtomRecord = {
      x: (water % 8) * 3,
      y: Math.floor(water / 8) * 3,
      z: water % 3,
      element: 'O',
      atomName: 'O',
      altLoc: '',
      occupancy: 1,
      bFactor: 20,
      model: 1,
      chain: water < 20 ? 'A' : 'B',
      labelChain: water < 20 ? 'C' : 'D',
      residueName: 'HOH',
      residueNumber: 100 + water,
      insertion: '',
      hydrogen: false,
      water: true,
      firstConformation: true,
      polymer: false,
    }
    builder.add(atom)
  }
  return builder.finish('waters')
}

// The splats' content of the atoms shown with Waters on or off, painted through
function contentOf(structure: Structure, waters: boolean) {
  const options = { ...defaultOptions, waters }
  const model = structure.models[0] ?? 1
  const state = { structure, options, models: structure.models, model }
  const shown = shownAtoms(state)
  const choice = shownChoice(state)
  const shape = { scale: options.scale, thermal: options.thermal, ellipsoids: false }
  const content = new SplatContent(structure, shown, choice, 'auto', shape, vdwRadii(structure.elements), new Group(), () => () => undefined)
  const merged = mergeLevels(structure, choice)
  assert.ok(content.grow(structure, shown, merged, [0, 0, 0], () => Infinity))
  const paint: TablePaint = {
    shown,
    structure,
    colorBy: 'chain',
    burial: 0,
    buried: null,
    focus: 'all',
    picked: null,
    fade: options.fade,
    model,
    modelCount: structure.models.length,
    conformations: options.conformations,
    layered: true,
  }
  while (!content.paintedFrom(paint)) content.paintOnward(paint, () => undefined)
  return { shown, content }
}

// What a frame draws of every level, with the whole entry in view: each pool's instances
function drawn(stage: Stage, content: SplatContent | null, state: Frames) {
  // Planes of nought hold every sphere within them
  const planes = new Float64Array(planesSize)
  return levels.map((_, level) => {
    // The frames draw nothing while there's no content, as they do while no atoms are shown
    if (content) drawLevel(stage, content, level, state, planes)
    return stage.pools[level]?.geometry.instanceCount ?? 0
  })
}

void test('an entry whose shown atoms fall to none draws nothing, until atoms are shown again', () => {
  const structure = watersAlone()
  const table = new PieceTable(pieceCount(structure))
  const stage: Stage = {
    entry: structure,
    pools: levels.map((level) => createPool(poolSize(structure, level), table.capacity)),
    filledFrom: levels.map(() => null),
    table,
  }
  const state: Frames = { level: 0, frame: 0, stale: true, planes: new Float64Array(planesSize) }

  // With Waters on, the atoms level draws every water
  const shownWaters = contentOf(structure, true)
  assert.equal(shownWaters.shown.count, 40)
  const content: { current: SplatContent | null } = { current: shownWaters.content }
  assert.equal(drawn(stage, content.current, state)[0], 40)

  // With Waters off none are shown, and nothing is drawn at any level, the next frame included
  assert.equal(contentOf(structure, false).shown.count, 0)
  showNothing(stage, content)
  assert.equal(content.current, null)
  assert.deepEqual(stage.filledFrom, levels.map(() => null))
  assert.deepEqual(drawn(stage, content.current, state), levels.map(() => 0))

  // With Waters on again, the waters are drawn again from content of their own
  content.current = contentOf(structure, true).content
  assert.equal(drawn(stage, content.current, state)[0], 40)
})
