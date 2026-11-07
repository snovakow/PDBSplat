import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noSphere, sphereNeighbours } from '../src/pdb/overlaps.ts'

// The neighbours of each sphere: which spheres overlap it, deepest first, within the cap

// A deterministic generator, so a failure repeats
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

// Spheres from centres and radii, as the search takes them
function spheres(list: { x: number; y: number; z: number; r: number }[]) {
  const centers = new Float32Array(list.flatMap(({ x, y, z }) => [x, y, z]))
  const radii = new Float32Array(list.map(({ r }) => r))
  return { centers, radii }
}

// One sphere's neighbours, as listed before the first empty slot
function listOf(neighbours: Uint32Array, cap: number, index: number) {
  const slots = [...neighbours.subarray(index * cap, (index + 1) * cap)]
  const end = slots.indexOf(noSphere)
  return end < 0 ? slots : slots.slice(0, end)
}

// Every sphere's neighbours by brute force, deepest first and equal depths by index
function bruteForce(centers: Float32Array, radii: Float32Array, cap: number) {
  const count = radii.length
  const lists: number[][] = []
  let overCap = 0
  for (let i = 0; i < count; i++) {
    const found: { index: number; depth: number }[] = []
    for (let j = 0; j < count; j++) {
      if (j === i) continue
      const dx = centers[j * 3] - centers[i * 3]
      const dy = centers[j * 3 + 1] - centers[i * 3 + 1]
      const dz = centers[j * 3 + 2] - centers[i * 3 + 2]
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const sum = radii[i] + radii[j]
      if (distance < sum) found.push({ index: j, depth: sum - distance })
    }
    if (found.length > cap) overCap++
    found.sort((a, b) => b.depth - a.depth || a.index - b.index)
    lists.push(found.slice(0, cap).map(({ index }) => index))
  }
  return { lists, overCap }
}

void test('two spheres nearer than the sum of their radii are each other\'s neighbours, and two farther apart are not', () => {
  const near = spheres([
    { x: 0, y: 0, z: 0, r: 1.7 },
    { x: 1.54, y: 0, z: 0, r: 1.7 },
  ])
  const { neighbours, overCap } = sphereNeighbours(near.centers, near.radii, 4)
  assert.deepEqual(listOf(neighbours, 4, 0), [1])
  assert.deepEqual(listOf(neighbours, 4, 1), [0])
  assert.equal(overCap, 0)
  // The slots past the last neighbour hold the sentinel
  assert.deepEqual([...neighbours], [1, noSphere, noSphere, noSphere, 0, noSphere, noSphere, noSphere])

  const apart = spheres([
    { x: 0, y: 0, z: 0, r: 1.7 },
    { x: 3.5, y: 0, z: 0, r: 1.7 },
  ])
  const far = sphereNeighbours(apart.centers, apart.radii, 4)
  assert.deepEqual(listOf(far.neighbours, 4, 0), [])
  assert.deepEqual(listOf(far.neighbours, 4, 1), [])
  // Spheres that just touch don't overlap
  const touching = spheres([
    { x: 0, y: 0, z: 0, r: 1 },
    { x: 2, y: 0, z: 0, r: 1 },
  ])
  assert.deepEqual(listOf(sphereNeighbours(touching.centers, touching.radii, 4).neighbours, 4, 0), [])
})

void test('a sphere between two others lists the deeper overlap first', () => {
  // The middle sphere overlaps the first by 1.2 and the last by 0.4
  const row = spheres([
    { x: 0, y: 0, z: 0, r: 1 },
    { x: 1.8, y: 0, z: 0, r: 2 },
    { x: 4.6, y: 0, z: 0, r: 1.2 },
  ])
  const { neighbours } = sphereNeighbours(row.centers, row.radii, 4)
  assert.deepEqual(listOf(neighbours, 4, 1), [0, 2])
  assert.deepEqual(listOf(neighbours, 4, 0), [1])
  assert.deepEqual(listOf(neighbours, 4, 2), [1])
  // The same spheres the other way round list the deeper overlap first still
  const reversed = spheres([
    { x: 4.6, y: 0, z: 0, r: 1.2 },
    { x: 1.8, y: 0, z: 0, r: 2 },
    { x: 0, y: 0, z: 0, r: 1 },
  ])
  assert.deepEqual(listOf(sphereNeighbours(reversed.centers, reversed.radii, 4).neighbours, 4, 1), [2, 0])
})

void test('the cap keeps the deepest overlaps and counts the sphere that exceeded it', () => {
  // A sphere at the origin with four small ones inside it, at depths 1.7, 1.2, 0.7 and 0.45, too small to overlap
  // one another
  const star = spheres([
    { x: 0, y: 0, z: 0, r: 2 },
    { x: 0.5, y: 0, z: 0, r: 0.2 },
    { x: 0, y: 1, z: 0, r: 0.2 },
    { x: 0, y: 0, z: 1.5, r: 0.2 },
    { x: -1.75, y: 0, z: 0, r: 0.2 },
  ])
  const capped = sphereNeighbours(star.centers, star.radii, 2)
  assert.deepEqual(listOf(capped.neighbours, 2, 0), [1, 2])
  assert.equal(capped.overCap, 1)
  // The small spheres each overlap the centre alone
  for (let i = 1; i < 5; i++) assert.deepEqual(listOf(capped.neighbours, 2, i), [0], `sphere ${i} lists the centre`)
  const uncapped = sphereNeighbours(star.centers, star.radii, 8)
  assert.deepEqual(listOf(uncapped.neighbours, 8, 0), [1, 2, 3, 4])
  assert.equal(uncapped.overCap, 0)
  assert.equal(uncapped.neighbours.length, 5 * 8)
})

void test('a lone sphere has no neighbours, and no spheres make an empty table', () => {
  const lone = spheres([{ x: 3, y: 4, z: 5, r: 2 }])
  const { neighbours, overCap } = sphereNeighbours(lone.centers, lone.radii, 3)
  assert.deepEqual([...neighbours], [noSphere, noSphere, noSphere])
  assert.equal(overCap, 0)
  const none = sphereNeighbours(new Float32Array(0), new Float32Array(0), 3)
  assert.equal(none.neighbours.length, 0)
  assert.equal(none.overCap, 0)
})

void test('against brute force on random spheres the lists agree, capped and uncapped', (t) => {
  const next = random(3)
  const count = 400
  const centers = new Float32Array(count * 3)
  const radii = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    centers[i * 3] = next() * 20
    centers[i * 3 + 1] = next() * 20
    centers[i * 3 + 2] = next() * 20
    radii[i] = 1 + next() * 2
  }
  let listed = 0
  for (const cap of [4, 64]) {
    const expected = bruteForce(centers, radii, cap)
    const { neighbours, overCap } = sphereNeighbours(centers, radii, cap)
    assert.equal(neighbours.length, count * cap)
    for (let i = 0; i < count; i++) {
      assert.deepEqual(listOf(neighbours, cap, i), expected.lists[i], `sphere ${i} at cap ${cap}`)
      listed += expected.lists[i].length
    }
    assert.equal(overCap, expected.overCap, `over the cap of ${cap}`)
    if (cap === 4) assert.ok(overCap > 0)
    else assert.equal(overCap, 0)
  }
  t.diagnostic(`${listed} neighbours listed over ${count} spheres at two caps`)
})
