import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Group, InterleavedBufferAttribute, StaticDrawUsage, type InterleavedBuffer } from 'three'
import { vdwRadii } from '../src/pdb/elements.ts'
import { mergeLevels } from '../src/pdb/merge.ts'
import { selectAtoms, StructureBuilder, type AtomRecord, type ShownChoice } from '../src/pdb/structure.ts'
import type { TablePaint } from '../src/viewer/atomTable.ts'
import {
  covarianceSize,
  createPool,
  noPiece,
  paintSize,
  pieceBits,
  shapeSize,
  slotPaintSize,
  startScale,
  type Pool,
} from '../src/viewer/ellipsoidGeometry.ts'
import { levels } from '../src/viewer/levels.ts'
import { startDepth } from '../src/viewer/morph.ts'
import { pieceCount as piecesOf, PieceTable, planesSize } from '../src/viewer/pieces.ts'
import { invertCovariance } from '../src/viewer/rayEllipsoids.ts'
import { poolSize, SplatContent } from '../src/viewer/splatContent.ts'
import { drawLevel, paintStepOf, type Frames, type Stage } from '../src/viewer/splatStage.ts'

// A pool of slots for ellipsoids: pieces filled into stretches of slots, taken out again, reclaimed oldest unseen
// first, the slots drawn, and the ranges of each buffer sent to the GPU

// The interleaved buffer behind one of a pool's attributes
function bufferOf(pool: Pool, name: string): InterleavedBuffer {
  const attribute = pool.geometry.getAttribute(name)
  if (!(attribute instanceof InterleavedBufferAttribute)) throw new Error(`${name} is interleaved`)
  return attribute.data
}

// A buffer's update ranges as [start, count] pairs
const rangesOf = (buffer: InterleavedBuffer) => buffer.updateRanges.map(({ start, count }) => [start, count])

// What three does once it has sent a buffer's ranges
const sent = (buffer: InterleavedBuffer) => buffer.clearUpdateRanges()

void test('pieces fill stretches of slots in turn, and the slots drawn reach the end of the last', () => {
  const pool = createPool(10, 5)
  assert.equal(pool.geometry.instanceCount, 0)
  assert.equal(pool.fill(1, 3, 1), 0)
  assert.equal(pool.fill(2, 4, 1), 3)
  assert.equal(pool.extent, 7)
  assert.equal(pool.geometry.instanceCount, 7)
  assert.deepEqual([...pool.pieces], [1, 1, 1, 2, 2, 2, 2, 0, 0, 0])
  assert.equal(pool.slotOf(2), 3)
  assert.equal(pool.heldBy(2), 4)
  assert.equal(pool.slotOf(3), -1)
  // A piece filled again takes a stretch afresh
  assert.equal(pool.fill(1, 2, 2), 0)
  assert.deepEqual([...pool.pieces.subarray(0, 7)], [1, 1, 0, 2, 2, 2, 2])
})

void test("a hidden piece's slots point at no piece and are free for the next fill that fits them", () => {
  const pool = createPool(12, 5)
  pool.fill(1, 3, 1)
  pool.fill(2, 4, 1)
  pool.fill(3, 2, 1)
  pool.hide(2)
  assert.equal(pool.slotOf(2), -1)
  assert.deepEqual([...pool.pieces.subarray(0, 9)], [1, 1, 1, noPiece, noPiece, noPiece, noPiece, 3, 3])
  // Still drawn up to the last piece's end, the hidden slots being no piece's
  assert.equal(pool.extent, 9)
  // The first free stretch that fits is taken, and what's left of it stays free
  assert.equal(pool.fill(4, 3, 2), 3)
  assert.equal(pool.fill(2, 2, 2), 9)
  // Hiding the last piece brings the slots drawn back to the end of the one before, past the free slot between
  pool.hide(2)
  assert.equal(pool.extent, 9)
  pool.hide(3)
  assert.equal(pool.extent, 6)
  assert.equal(pool.geometry.instanceCount, 6)
  pool.clear()
  assert.equal(pool.extent, 0)
  assert.equal(pool.geometry.instanceCount, 0)
  assert.equal(pool.slotOf(1), -1)
  assert.equal(pool.fill(4, 12, 3), 0)
})

void test('a full pool reclaims the pieces seen longest ago, but none seen in the frame of the fill', () => {
  const pool = createPool(9, 6)
  pool.fill(1, 3, 1)
  pool.fill(2, 3, 2)
  pool.fill(3, 3, 3)
  // Piece 1 is seen again, so piece 2 is now the oldest seen
  pool.see(1, 4)
  assert.equal(pool.fill(4, 3, 5), 3)
  assert.equal(pool.slotOf(2), -1)
  assert.equal(pool.slotOf(1), 0)
  assert.equal(pool.slotOf(3), 6)
  // Five slots can't be found while piece 4, in the middle, is seen in the frame, so nothing is taken
  pool.see(4, 6)
  assert.equal(pool.fill(5, 5, 6), -1)
  assert.deepEqual([pool.slotOf(1), pool.slotOf(3), pool.slotOf(4)], [0, 6, 3])
  // Unseen, every piece gives its slots up in turn, oldest first, until five in a row are free
  pool.see(4, 5)
  assert.equal(pool.fill(5, 5, 6), 0)
  assert.deepEqual([pool.slotOf(1), pool.slotOf(3), pool.slotOf(4)], [-1, -1, -1])
})

void test('a fill that cannot fit is refused whole and takes nothing from any other piece', () => {
  const pool = createPool(8, 4)
  pool.fill(1, 3, 1)
  pool.fill(2, 3, 1)
  pool.send()
  const shapes = bufferOf(pool, 'center')
  const version = shapes.version
  sent(shapes)
  // Both pieces are seen in the frame of the fill, so only the two free slots are there to take
  assert.equal(pool.fill(3, 3, 1), -1)
  assert.equal(pool.slotOf(3), -1)
  assert.equal(pool.slotOf(1), 0)
  assert.equal(pool.slotOf(2), 3)
  assert.equal(pool.extent, 6)
  // Nor is anything written to be sent
  pool.send()
  assert.equal(shapes.version, version)
  assert.deepEqual(rangesOf(shapes), [])
  // More than the whole pool, or nothing, is refused too
  assert.equal(pool.fill(3, 9, 2), -1)
  assert.equal(pool.fill(3, 0, 2), -1)
  assert.equal(pool.slotOf(1), 0)
})

void test('the ranges sent cover exactly the slots written, in each buffer\'s own elements', () => {
  const pool = createPool(20, 6)
  const shapes = bufferOf(pool, 'center')
  const starts = bufferOf(pool, 'startCenter')
  const paint = bufferOf(pool, 'paint')
  const pieces = bufferOf(pool, 'piece')
  pool.fill(1, 3, 1)
  pool.fill(2, 2, 1)
  pool.fill(3, 4, 1)
  pool.hide(2)
  pool.send()
  // The shapes, the starts and the paints of every slot filled, the stretches that touch joined into one, and the
  // pieces of the hidden slots as well, which now point at none
  assert.deepEqual(rangesOf(shapes), [[0, 9 * shapeSize]])
  assert.deepEqual(rangesOf(starts), [[0, 9 * shapeSize]])
  assert.deepEqual(rangesOf(paint), [[0, 9 * slotPaintSize]])
  assert.deepEqual(rangesOf(pieces), [[0, 9]])
  for (const buffer of [shapes, starts, paint, pieces]) sent(buffer)

  // Once sent, only what's written after goes
  const version = shapes.version
  pool.fill(4, 2, 2)
  pool.repainted(1)
  pool.send()
  assert.equal(shapes.version, version + 1)
  assert.deepEqual(rangesOf(shapes), [[3 * shapeSize, 2 * shapeSize]])
  assert.deepEqual(rangesOf(starts), [[3 * shapeSize, 2 * shapeSize]])
  // Piece 1's repaint and piece 4's fill touch, and go as one
  assert.deepEqual(rangesOf(paint), [[0, 5 * slotPaintSize]])
  assert.deepEqual(rangesOf(pieces), [[3, 2]])

  // Ranges not yet sent, as of a buffer not drawn since, are sent with the next ones
  pool.fill(5, 1, 3)
  pool.send()
  assert.deepEqual(rangesOf(pieces), [
    [3, 2],
    [9, 1],
  ])
  // Nothing new written sends nothing more
  const piecesVersion = pieces.version
  pool.send()
  assert.equal(pieces.version, piecesVersion)
})

void test('random fills, hides and reclaims keep each piece in slots of its own, and the ranges sent cover exactly the slots written', () => {
  // A fixed sequence, so that a failure repeats
  let seed = 20261125
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const capacity = 60
  const pieceCount = 12
  const pool = createPool(capacity, pieceCount)
  // Each buffer, its elements in a slot, and the slots written to it since three last sent its ranges
  const kinds = [
    { buffer: bufferOf(pool, 'center'), stride: shapeSize, written: new Set<number>() },
    { buffer: bufferOf(pool, 'startCenter'), stride: shapeSize, written: new Set<number>() },
    { buffer: bufferOf(pool, 'paint'), stride: slotPaintSize, written: new Set<number>() },
    { buffer: bufferOf(pool, 'piece'), stride: 1, written: new Set<number>() },
  ]
  const [, , paint, pieces] = kinds
  const mark = (written: Set<number>, slot: number, count: number) => {
    for (let s = slot; s < slot + count; s++) written.add(s)
  }
  // The slots a buffer's ranges cover, in order, each range whole slots and none overlapping another
  const slotsOf = (buffer: InterleavedBuffer, stride: number) => {
    const slots: number[] = []
    for (const { start, count } of buffer.updateRanges) {
      assert.equal(start % stride, 0)
      assert.equal(count % stride, 0)
      for (let s = start / stride; s < (start + count) / stride; s++) slots.push(s)
    }
    return slots
  }
  // Each piece's stretch as the pool should hold it, and the last frame each was seen in
  const held = new Map<number, { slot: number; count: number }>()
  const seen = new Map<number, number>()
  const free = (piece: number) => {
    const stretch = held.get(piece)
    if (!stretch) return
    mark(pieces.written, stretch.slot, stretch.count)
    held.delete(piece)
  }
  let refused = 0
  let reclaimed = 0
  for (let step = 0; step < 4000; step++) {
    const frame = 1 + Math.floor(step / 12)
    const piece = 1 + Math.floor(random() * (pieceCount - 1))
    const roll = random()
    if (roll < 0.45) {
      const count = 1 + Math.floor(random() * 20)
      // A piece filled again gives up its old stretch first
      free(piece)
      const others = [...held.entries()]
      const slot = pool.fill(piece, count, frame)
      for (const [other, stretch] of others) {
        if (pool.slotOf(other) === stretch.slot) continue
        // Only a piece not seen in the frame gives its slots up, and only to a fill that then fits
        assert.equal(pool.slotOf(other), -1)
        assert.ok(slot >= 0, 'a refused fill takes nothing')
        assert.ok((seen.get(other) ?? 0) < frame, 'a piece seen in the frame keeps its slots')
        free(other)
        reclaimed++
      }
      if (slot < 0) {
        refused++
      } else {
        assert.ok(slot + count <= capacity)
        held.set(piece, { slot, count })
        seen.set(piece, frame)
        for (const { written } of kinds) mark(written, slot, count)
      }
    } else if (roll < 0.6) {
      pool.hide(piece)
      free(piece)
    } else if (roll < 0.7) {
      if (held.has(piece)) {
        pool.see(piece, frame)
        seen.set(piece, frame)
      }
    } else if (roll < 0.78) {
      pool.repainted(piece)
      const stretch = held.get(piece)
      if (stretch) mark(paint.written, stretch.slot, stretch.count)
    } else if (roll < 0.8) {
      // Emptied, the pool writes nothing, and what was written before is still to be sent
      pool.clear()
      held.clear()
    } else {
      pool.send()
      for (const { buffer, stride, written } of kinds) {
        assert.deepEqual(
          slotsOf(buffer, stride),
          [...written].sort((a, b) => a - b),
        )
      }
      // Half the time the buffers are drawn, and three sends their ranges and clears them
      if (random() < 0.5) {
        for (const { buffer, written } of kinds) {
          buffer.clearUpdateRanges()
          written.clear()
        }
      }
    }
    // Every piece held where it was put, no slot held twice, the slots between pointing at no piece, and the slots
    // drawn reaching the end of the last stretch held
    const owner = new Int32Array(capacity).fill(noPiece)
    let extent = 0
    for (const [holder, { slot, count }] of held) {
      assert.equal(pool.slotOf(holder), slot)
      assert.equal(pool.heldBy(holder), count)
      for (let s = slot; s < slot + count; s++) {
        assert.equal(owner[s], noPiece)
        owner[s] = holder
      }
      extent = Math.max(extent, slot + count)
    }
    assert.equal(pool.extent, extent)
    assert.equal(pool.geometry.instanceCount, extent)
    assert.deepEqual([...pool.pieces.subarray(0, extent)], [...owner.subarray(0, extent)])
  }
  // The sequence reaches the refusals and the reclaims it's meant to test
  assert.ok(refused > 50, `${refused} refused`)
  assert.ok(reclaimed > 200, `${reclaimed} reclaimed`)
})

void test('the buffers are interleaved, sent by ranges, and never re-sent whole each render', () => {
  const pool = createPool(4, 2)
  for (const name of ['center', 'covarianceA', 'covarianceB', 'startCenter', 'startCovarianceA', 'startCovarianceB', 'paint', 'parentPaint', 'piece']) {
    const buffer = bufferOf(pool, name)
    assert.equal(buffer.usage, StaticDrawUsage, `${name} keeps three's static usage`)
  }
  // The piece is one whole number of 32 bits
  const piece = pool.geometry.getAttribute('piece')
  assert.equal(piece.itemSize, 1)
  assert.ok(bufferOf(pool, 'piece').array instanceof Uint32Array)
})

// Two chains of three residues of four atoms each, of carbon, nitrogen and oxygen
function smallEntry() {
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
  const builder = new StructureBuilder()
  for (const [c, chain] of ['A', 'B'].entries()) {
    for (let residue = 1; residue <= 3; residue++) {
      for (const [k, element] of ['N', 'C', 'C', 'O'].entries()) {
        builder.add({ ...base, chain, labelChain: chain, residueNumber: residue, element, atomName: `${element}${k}`, x: residue * 3.8 + k, y: c * 12 + k * k * 0.3, z: k % 2 })
      }
    }
  }
  return builder.finish()
}

void test("a slot holds its instance, what it grows from out of its parent, and its parent's paint, which a repaint reaches", () => {
  const structure = smallEntry()
  const shown = selectAtoms(structure, () => true)
  const choice: ShownChoice = { hydrogens: false, waters: false, conformations: 'first', model: 1 }
  const shape = { scale: 1, thermal: 0, ellipsoids: false }
  const content = new SplatContent(structure, shown, choice, 'auto', shape, vdwRadii(structure.elements), new Group(), () => () => undefined)
  assert.ok(content.grow(structure, shown, mergeLevels(structure, choice), [0, 0, 0], () => Infinity))
  const paintBy = (colorBy: TablePaint['colorBy']): TablePaint => ({
    shown,
    structure,
    colorBy,
    burial: 0,
    buried: null,
    focus: 'all',
    picked: null,
    fade: 0.3,
    model: 1,
    modelCount: 1,
    conformations: 'first',
    layered: true,
  })
  const byChain = paintBy('chain')
  while (!content.paintedFrom(byChain)) content.paintOnward(byChain, () => undefined)
  const table = new PieceTable(piecesOf(structure))
  const stage: Stage = {
    entry: structure,
    pools: levels.map((level) => createPool(poolSize(structure, level), table.capacity)),
    filledFrom: levels.map(() => null),
    table,
  }
  const planes = new Float64Array(planesSize)
  // Each slot a level's pool holds, with its instance and its parent's in the level after
  const slotsOf = (level: number) => {
    const owned = content.levels[level]
    const pool = stage.pools[level]
    assert.ok(owned && pool)
    const slots: { slot: number; piece: number; i: number; parent: number }[] = []
    for (let piece = 1; piece < owned.spans.sizes.length; piece++) {
      let slot = pool.slotOf(piece)
      for (let s = owned.spans.first[piece]; s < owned.spans.first[piece + 1]; s++) {
        for (let i = owned.spans.start[s]; i < owned.spans.end[s]; i++, slot++) slots.push({ slot, piece, i, parent: owned.parents?.[i] ?? -1 })
      }
    }
    return { pool, slots }
  }
  for (const level of [0, 1, 2]) {
    const state: Frames = { level, grown: 0.5, frame: 0, stale: true, planes: new Float64Array(planesSize) }
    drawLevel(stage, content, level, state, planes, 0.5)
    const { pool, slots } = slotsOf(level)
    assert.equal(slots.length, level === 0 ? 24 : level === 1 ? 6 : 2)
    const parentLevel = content.parentOf(level)
    const owned = content.levels[level]
    assert.ok(owned)
    const carried = new Map<number, number>()
    for (const { slot, piece, i, parent } of slots) {
      const at = slot * shapeSize
      // The piece's index, with the carrier's flag above it
      const carries = pool.pieces[slot] >>> 31 === 1
      assert.equal(pool.pieces[slot] & pieceBits, piece)
      // Its own paint, and its parent's after it, or its own again where it carries itself
      const paintAt = slot * slotPaintSize
      const parentPaint: Uint8ClampedArray = parentLevel ? parentLevel.paint.subarray(parent * paintSize, parent * paintSize + paintSize) : owned.paint.subarray(i * paintSize, i * paintSize + paintSize)
      assert.deepEqual([...pool.paint.subarray(paintAt, paintAt + paintSize)], [...owned.paint.subarray(i * paintSize, i * paintSize + paintSize)])
      assert.deepEqual([...pool.paint.subarray(paintAt + paintSize, paintAt + slotPaintSize)], [...parentPaint])
      if (!parentLevel?.blobs) {
        // A chain's blob is its own parent, and grows from itself
        assert.ok(carries)
        assert.deepEqual([...pool.starts.subarray(at, at + shapeSize)], [...pool.shapes.subarray(at, at + shapeSize)])
        continue
      }
      const centre = parentLevel.blobs.centers.subarray(parent * 3, parent * 3 + 3)
      const covariance = parentLevel.blobs.covariances.subarray(parent * covarianceSize, parent * covarianceSize + covarianceSize)
      if (carries) {
        // One child of each parent carries it, growing from the parent's own shape
        assert.ok(!carried.has(parent))
        carried.set(parent, i)
        assert.deepEqual([...pool.starts.subarray(at, at + 3)], [...centre])
        assert.deepEqual([...pool.starts.subarray(at + 3, at + shapeSize)], [...covariance])
      } else {
        // Every other child starts within the parent's ellipsoid at half its size, its own covariance shrunk
        const inverse = new Float64Array(covarianceSize)
        invertCovariance(covariance, 0, inverse, 0)
        const d = [0, 1, 2].map((k) => pool.starts[at + k] - centre[k])
        const [xx, xy, xz, yy, yz, zz] = inverse
        const depth = Math.sqrt(d[0] * (xx * d[0] + xy * d[1] + xz * d[2]) + d[1] * (xy * d[0] + yy * d[1] + yz * d[2]) + d[2] * (xz * d[0] + yz * d[1] + zz * d[2]))
        assert.ok(depth <= startDepth + 1e-4, `level ${level} instance ${i}: ${depth}`)
        for (let k = 0; k < covarianceSize; k++) assert.equal(pool.starts[at + 3 + k], Math.fround(pool.shapes[at + 3 + k] * startScale))
      }
    }
    if (parentLevel?.blobs) assert.equal(carried.size, parentLevel.blobs.grouping.count)
    // The piece table holds how far the pieces have grown
    assert.equal(table.values[4 + level], 0.5)
  }

  // Repainted by element, every slot's own paint and its parent's follow
  const before = [...stage.pools[0]?.paint ?? []]
  const byElement = paintBy('element')
  while (!content.paintedFrom(byElement)) paintStepOf(content, stage, byElement)
  const { pool, slots } = slotsOf(0)
  const residues = content.levels[1]
  assert.ok(residues)
  for (const { slot, parent } of slots) {
    const at = slot * slotPaintSize + paintSize
    assert.deepEqual([...pool.paint.subarray(at, at + paintSize)], [...residues.paint.subarray(parent * paintSize, parent * paintSize + paintSize)])
  }
  assert.notDeepEqual([...pool.paint], before)
})
