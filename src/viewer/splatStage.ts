// What the splats of an entry are drawn from while it's shown, and the work the frames and the builds do on it: the
// pools each level's instances are written into as their pieces come into view, the piece table the vertex stage reads
// which pieces are shown from, and what each pool was last filled from

import type { Mesh } from 'three'
import type { NodeMaterial } from 'three/webgpu'
import type { MergedLevels } from '../pdb/merge.ts'
import type { Structure } from '../pdb/structure.ts'
import type { TablePaint } from './atomTable.ts'
import { carrierFlag, covarianceSize, createPool, paintSize, shapeSize, slotPaintSize, type Pool } from './ellipsoidGeometry.ts'
import { writeAtomShape } from './ellipsoids.ts'
import { levels, noGroup } from './levels.ts'
import { writeStart } from './morph.ts'
import { grownTexel, hiddenTexel, planesSize, sphereInView, sphereSize, type PieceTable } from './pieces.ts'
import { poolSize, type SplatContent } from './splatContent.ts'

// What the entry is drawn from while it's shown: a pool for each level, made the first time that level is built, what
// each pool was last filled from, and the piece table every pool's meshes read, which grows as an arriving entry's
// chains do
export interface Stage {
  // The entry it's for, as every snapshot of it names it
  entry: object
  pools: (Pool | null)[]
  filledFrom: (SplatContent | null)[]
  table: PieceTable
}

// What the frames keep between them: the level drawn, or -1 before one is, how far its pieces have grown out of the
// level coarser, a count of the frames that tested the pieces, whether they must be tested again whatever the view,
// and the view's planes they were last tested against
export interface Frames {
  level: number
  grown: number
  frame: number
  stale: boolean
  planes: Float64Array
}

// Puts other content in place of what's drawn, or none, and takes the old one's pick away
export function replaceContent(content: { current: SplatContent | null }, next: SplatContent | null) {
  content.current?.unregister()
  content.current = next
}

// With no atoms shown, nothing is drawn: the content goes, and every pool is emptied, to be filled again from the
// content made once atoms are shown again
export function showNothing(stage: Stage, content: { current: SplatContent | null }) {
  replaceContent(content, null)
  for (const pool of stage.pools) pool?.clear()
  stage.filledFrom.fill(null)
}

// Writes a slot's paint, its own and its parent's, from an instance of a level: its parent's where it has one in the
// level built after, and its own again where it carries itself
function writePaints(pool: Pool, slot: number, content: SplatContent, level: number, i: number) {
  const owned = content.levels[level]
  if (!owned) return
  const parentLevel = content.parentOf(level)
  const parent = parentLevel && owned.parents ? owned.parents[i] : noGroup
  const source = parent === noGroup || !parentLevel ? owned.paint : parentLevel.paint
  const from = (parent === noGroup ? i : parent) * paintSize
  const at = slot * slotPaintSize
  for (let k = 0; k < paintSize; k++) {
    pool.paint[at + k] = owned.paint[i * paintSize + k]
    pool.paint[at + paintSize + k] = source[from + k]
  }
}

// Writes a piece's instances at a level into its pool, refusing where they don't fit: each one's shape, what it grows
// from out of its parent in the level built after, and its paints, with the carrier's flag where it carries its
// parent. An instance with no parent there, as a chain's blob has none, and as a hidden atom's is in no blob, carries
// itself, growing from its own shape
function fillPiece(pool: Pool, content: SplatContent, level: number, piece: number, frame: number) {
  const owned = content.levels[level]
  if (!owned) return false
  const { spans, blobs, parents } = owned
  let slot = pool.fill(piece, spans.sizes[piece], frame)
  if (slot < 0) return false
  const { structure, shown, radii, shape } = content
  const { positions } = structure.atoms
  const { shapes, starts, pieces } = pool
  const parentLevel = content.parentOf(level)
  for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
    for (let i = spans.start[s]; i < spans.end[s]; i++, slot++) {
      const at = slot * shapeSize
      if (blobs) {
        for (let k = 0; k < 3; k++) shapes[at + k] = blobs.centers[i * 3 + k]
        for (let k = 0; k < covarianceSize; k++) shapes[at + 3 + k] = blobs.covariances[i * covarianceSize + k]
      } else {
        const atom = shown.rows[i]
        for (let k = 0; k < 3; k++) shapes[at + k] = positions[atom * 3 + k]
        writeAtomShape(shapes, at + 3, structure, atom, radii, shape)
      }
      writePaints(pool, slot, content, level, i)
      const parent = parentLevel?.blobs && parents ? parents[i] : noGroup
      if (parent === noGroup || !parentLevel?.blobs) {
        for (let k = 0; k < shapeSize; k++) starts[at + k] = shapes[at + k]
        pieces[slot] = (piece | carrierFlag) >>> 0
        continue
      }
      const carries = parentLevel.carriers?.[parent] === i
      const { centers, covariances } = parentLevel.blobs
      writeStart(starts, at, shapes, at, shapes, at + 3, centers, parent * 3, covariances, parent * covarianceSize, carries)
      if (carries) pieces[slot] = (piece | carrierFlag) >>> 0
    }
  }
  return true
}

// Copies a piece's paints at a level into its slots, its own and its parents', where it holds any
function repaintPiece(pool: Pool, content: SplatContent, level: number, piece: number) {
  const owned = content.levels[level]
  let slot = pool.slotOf(piece)
  if (!owned || slot < 0) return
  const { spans } = owned
  for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
    for (let i = spans.start[s]; i < spans.end[s]; i++, slot++) writePaints(pool, slot, content, level, i)
  }
  pool.repainted(piece)
}

// Paints a step of the content from the inputs, and repaints in place each piece it repainted, in every pool filled
// from it
export function paintStepOf(content: SplatContent, stage: Stage, inputs: TablePaint) {
  content.paintOnward(inputs, (piece) => {
    content.levels.forEach((owned, level) => {
      const pool = stage.pools[level]
      if (owned && pool && stage.filledFrom[level] === content) repaintPiece(pool, content, level, piece)
    })
  })
}

// How much larger than an entry's instances at a level its pool may be once the entry has all arrived, and still be
// kept, as one made for what it was expected to hold
const poolSlack = 1.25

// Once an entry has all arrived, makes each pool it outgrew, or that's far larger than it, again at the entry's own
// size, or its blobs', its meshes drawing from the new one, which the frames fill
export function resizePools(
  stage: Stage,
  structure: Structure,
  merged: MergedLevels | null,
  meshes: readonly Mesh<Pool['geometry'], NodeMaterial>[][],
) {
  stage.pools.forEach((pool, index) => {
    if (!pool) return
    const size = poolSize(structure, levels[index], merged)
    if (pool.capacity >= size && pool.capacity <= size * poolSlack) return
    const next = createPool(size, stage.table.capacity)
    for (const mesh of meshes[index] ?? []) mesh.geometry = next.geometry
    pool.dispose()
    stage.pools[index] = next
    stage.filledFrom[index] = null
  })
}

// Tests every piece against the view's planes: each one in view at the level drawn is filled into that level's pool
// where it isn't there yet, and shown in the piece table grown as far as the frames say, and every other piece is
// hidden there
function cull(stage: Stage, current: SplatContent, level: number, state: Frames, planes: Float64Array) {
  state.planes.set(planes)
  state.stale = false
  const pool = stage.pools[level]
  const owned = current.levels[level]
  if (!pool || !owned) return
  const frame = ++state.frame
  const { spheres } = current
  const { table } = stage
  for (let piece = 1; piece < owned.spans.sizes.length; piece++) {
    const at = piece * sphereSize
    let value = hiddenTexel
    if (
      owned.spans.sizes[piece] > 0 &&
      sphereInView(planes, spheres[at], spheres[at + 1], spheres[at + 2], spheres[at + 3])
    ) {
      if (pool.slotOf(piece) >= 0) {
        pool.see(piece, frame)
        value = state.grown
      } else if (fillPiece(pool, current, level, piece, frame)) {
        value = state.grown
      }
    }
    for (let other = 0; other < levels.length; other++) table.set(piece, other, other === level ? value : hiddenTexel)
  }
}

// A frame's work on the level drawn, given the view's planes in the structure's space and how far its pieces have
// grown out of the level coarser, wholly unless given: its pool emptied where it was last filled from other content,
// the pieces tested again where the view, what's drawn or how far it has grown has changed, and whatever was written
// since the last frame, a fill or a repaint, sent
export function drawLevel(
  stage: Stage,
  current: SplatContent,
  level: number,
  state: Frames,
  planes: Float64Array,
  grown = grownTexel,
) {
  const pool = stage.pools[level]
  if (!pool) return
  if (stage.filledFrom[level] !== current) {
    pool.clear()
    stage.filledFrom[level] = current
    state.stale = true
  }
  if (grown !== state.grown) {
    state.grown = grown
    state.stale = true
  }
  let moved = state.stale
  for (let k = 0; k < planesSize; k++) moved ||= planes[k] !== state.planes[k]
  if (moved) cull(stage, current, level, state, planes)
  // A repaint since the last frame goes too, though nothing was culled
  pool.send()
  stage.table.send()
}
