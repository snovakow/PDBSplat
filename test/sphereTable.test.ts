import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FloatType, UnsignedByteType } from 'three'
import { readAtomIndex, tableSize } from '../src/viewer/atomTable.ts'
import { createSphereTables, maxNeighbours, neighbourTableSize } from '../src/viewer/sphereTable.ts'

// The sphere table and the neighbour table: their shapes, and the texels each atom's sphere and neighbours are written to

void test('the neighbour table holds a run of slots per atom within one row, and is nearly square', () => {
  assert.deepEqual(neighbourTableSize(0), { atomsPerRow: 1, width: maxNeighbours, height: 1 })
  assert.deepEqual(neighbourTableSize(1), { atomsPerRow: 1, width: maxNeighbours, height: 1 })
  assert.deepEqual(neighbourTableSize(maxNeighbours), { atomsPerRow: 1, width: maxNeighbours, height: maxNeighbours })
  assert.deepEqual(neighbourTableSize(maxNeighbours + 1), { atomsPerRow: 2, width: 2 * maxNeighbours, height: 17 })
  for (const count of [0, 1, 2, 327, 12956, 1000000]) {
    const { atomsPerRow, width, height } = neighbourTableSize(count)
    assert.equal(width, atomsPerRow * maxNeighbours)
    assert.ok(atomsPerRow * height >= count, `${count} atoms fit`)
    assert.ok(atomsPerRow * (height - 1) < Math.max(count, 1), `${count} atoms leave no spare row`)
    // The longer side is within twice the shorter, give or take a run, so a large entry fills the limit on both at once
    assert.ok(Math.max(width, height) <= 2 * Math.min(width, height) + maxNeighbours, `${count} atoms stay square`)
  }
})

void test("each atom's sphere texel holds its centre and radius, and its neighbour run its neighbours deepest first", () => {
  // Three spheres in a row: the middle overlaps both ends, more deeply the first, and the ends don't overlap each other
  const centers = new Float32Array([0, 0, 0, 1.8, 0.5, -0.5, 4.6, 0, 0])
  const radii = new Float32Array([1, 2, 1.2])
  const tables = createSphereTables(centers, radii)
  const { width, height } = tableSize(3)
  assert.equal(tables.spheres.image.width, width)
  assert.equal(tables.spheres.image.height, height)
  assert.equal(tables.spheres.type, FloatType)
  assert.equal(tables.neighbours.type, UnsignedByteType)
  const floats = tables.spheres.image.data
  assert.ok(floats instanceof Float32Array)
  assert.deepEqual(floats.subarray(0, 12), new Float32Array([0, 0, 0, 1, 1.8, 0.5, -0.5, 2, 4.6, 0, 0, 1.2]))
  assert.equal(floats.length, width * height * 4)
  assert.equal(tables.spheres.version, 1)
  assert.equal(tables.neighbours.version, 1)

  const layout = neighbourTableSize(3)
  assert.equal(tables.atomsPerRow, layout.atomsPerRow)
  assert.equal(tables.neighbours.image.width, layout.width)
  assert.equal(tables.neighbours.image.height, layout.height)
  const bytes = tables.neighbours.image.data
  assert.ok(bytes instanceof Uint8ClampedArray)
  // An atom's neighbours at its run: a neighbour's index with a full fourth byte, and empty slots past the last
  const slot = (atom: number, k: number) => {
    const row = Math.floor(atom / layout.atomsPerRow)
    const column = (atom - row * layout.atomsPerRow) * maxNeighbours + k
    const offset = (row * layout.width + column) * 4
    return { index: readAtomIndex(bytes, offset), flag: bytes[offset + 3] }
  }
  assert.deepEqual(slot(1, 0), { index: 0, flag: 255 })
  assert.deepEqual(slot(1, 1), { index: 2, flag: 255 })
  assert.deepEqual(slot(1, 2), { index: 0, flag: 0 })
  assert.deepEqual(slot(0, 0), { index: 1, flag: 255 })
  assert.deepEqual(slot(0, 1), { index: 0, flag: 0 })
  assert.deepEqual(slot(2, 0), { index: 1, flag: 255 })
  assert.deepEqual(slot(2, 1), { index: 0, flag: 0 })
  assert.equal(tables.overCap, 0)
})

void test('an atom with more neighbours than the cap keeps the deepest, and is counted', () => {
  // A sphere at the origin inside a cloud of smaller ones, all overlapping it, more than the cap
  const count = maxNeighbours + 10
  const centers = new Float32Array(count * 3)
  const radii = new Float32Array(count)
  radii[0] = 5
  for (let i = 1; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    centers[i * 3] = 4 * Math.cos(angle)
    centers[i * 3 + 1] = 4 * Math.sin(angle)
    centers[i * 3 + 2] = i * 0.01
    radii[i] = 0.2
  }
  const tables = createSphereTables(centers, radii)
  assert.equal(tables.overCap, 1)
  const bytes = tables.neighbours.image.data
  assert.ok(bytes instanceof Uint8ClampedArray)
  // The origin's run, the first in the table, is full
  for (let k = 0; k < maxNeighbours; k++) assert.equal(bytes[k * 4 + 3], 255)
})
