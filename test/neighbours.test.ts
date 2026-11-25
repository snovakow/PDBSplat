import assert from 'node:assert/strict'
import { test } from 'node:test'
import { neighbourGrid } from '../src/pdb/neighbours.ts'

// The neighbour grid against a brute-force search over random points

interface Point {
  x: number
  y: number
  z: number
}

// The points as the grid takes them, x, y, z triples
const flat = (cloud: readonly Point[]) => Float64Array.from(cloud.flatMap(({ x, y, z }) => [x, y, z]))

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

// Every point within the radius of each place, by index, with its squared distance, among those listed where a list is
// given
function bruteForce(cloud: readonly Point[], radius: number, place: Point, members?: readonly number[]) {
  const found = new Map<number, number>()
  cloud.forEach((point, index) => {
    if (members && !members.includes(index)) return
    const dx = point.x - place.x
    const dy = point.y - place.y
    const dz = point.z - place.z
    const distanceSquared = dx * dx + dy * dy + dz * dz
    if (distanceSquared <= radius * radius) found.set(index, distanceSquared)
  })
  return found
}

function assertMatchesBruteForce(cloud: readonly Point[], radius: number, places: readonly Point[], members?: readonly number[]) {
  const grid = neighbourGrid(flat(cloud), radius, members)
  let hits = 0
  for (const place of places) {
    const expected = bruteForce(cloud, radius, place, members)
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

void test('a grid over the points listed finds those alone, each by its own index', (t) => {
  const next = random(3)
  const cloud = points(400, 30, next)
  const members = cloud.map((_, index) => index).filter((index) => index % 3 !== 1)
  const hits = assertMatchesBruteForce(cloud, 5, [...cloud, ...points(50, 30, next)], members)
  assert.ok(hits > members.length)
  t.diagnostic(`${hits} neighbours found over 450 places`)
})

void test('a point at the radius is within it, and nothing is found at an empty place', () => {
  const cloud = [
    { x: 0, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
    { x: 0, y: 4, z: 0 },
  ]
  const grid = neighbourGrid(flat(cloud), 5)
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
  neighbourGrid([1, 2, 3], 5, []).forEachWithin(1, 2, 3, (index) => visited.push(index))
  assert.deepEqual(visited, [])
})
