import assert from 'node:assert/strict'
import { test } from 'node:test'
import { neighbourGrid, type Point } from '../src/pdb/neighbours.ts'

// The neighbour grid against a brute-force search over random points

// A deterministic generator, so a failure repeats
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function points(count: number, span: number, next: () => number): Point[] {
  return Array.from({ length: count }, () => ({ x: next() * span, y: next() * span, z: next() * span }))
}

// Every point within the radius of each place, by index, with its squared distance
function bruteForce(cloud: readonly Point[], radius: number, place: Point) {
  const found = new Map<number, number>()
  cloud.forEach((point, index) => {
    const dx = point.x - place.x
    const dy = point.y - place.y
    const dz = point.z - place.z
    const distanceSquared = dx * dx + dy * dy + dz * dz
    if (distanceSquared <= radius * radius) found.set(index, distanceSquared)
  })
  return found
}

function assertMatchesBruteForce(cloud: readonly Point[], radius: number, places: readonly Point[]) {
  const grid = neighbourGrid(cloud, radius)
  let hits = 0
  for (const place of places) {
    const expected = bruteForce(cloud, radius, place)
    const found = new Map<number, number>()
    grid.forEachWithin(place.x, place.y, place.z, (index, distanceSquared) => {
      assert.equal(found.has(index), false, `point ${index} visited twice`)
      found.set(index, distanceSquared)
    })
    assert.deepEqual(found, expected)
    hits += found.size
  }
  return hits
}

void test('finds every point within the radius once, with its squared distance, and none outside', (t) => {
  const next = random(1)
  const cloud = points(500, 30, next)
  const hits = assertMatchesBruteForce(cloud, 5, [...cloud, ...points(100, 30, next)])
  assert.ok(hits > cloud.length)
  t.diagnostic(`${hits} neighbours found over 600 places`)
})

void test('a span too wide for cells at the radius widens them and finds the same neighbours', (t) => {
  const next = random(2)
  // A cluster, and one far point that widens the span to 1,000 Å: cells at the radius of 5 Å would number 200³,
  // over the grid's limit, so they double
  const cloud = [...points(300, 20, next), { x: 1000, y: 1000, z: 1000 }]
  const hits = assertMatchesBruteForce(cloud, 5, [...cloud, { x: 999, y: 1000, z: 1000 }, { x: 1010, y: 1000, z: 1000 }])
  assert.ok(hits > cloud.length)
  t.diagnostic(`${hits} neighbours found over 303 places`)
})

void test('a point at the radius is within it, and nothing is found at an empty place', () => {
  const cloud = [
    { x: 0, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
    { x: 0, y: 4, z: 0 },
  ]
  const grid = neighbourGrid(cloud, 5)
  const found: number[] = []
  grid.forEachWithin(3, 4, 0, (index) => found.push(index))
  assert.deepEqual(found.sort((a, b) => a - b), [0, 1, 2])
  const empty: number[] = []
  grid.forEachWithin(100, 100, 100, (index) => empty.push(index))
  assert.deepEqual(empty, [])
})

void test('a grid of no points finds nothing', () => {
  const visited: number[] = []
  neighbourGrid([], 5).forEachWithin(0, 0, 0, (index) => visited.push(index))
  assert.deepEqual(visited, [])
})
