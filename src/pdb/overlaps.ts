// Which spheres each sphere of a set overlaps: those whose centres lie nearer than the sum of the two radii

import { neighbourGrid, type Point } from './neighbours.ts'

// Fills a sphere's slots past its last neighbour
export const noSphere = 0xffffffff

export interface SphereNeighbours {
  // Each sphere's neighbours, cap slots per sphere in the spheres' order: the indices of the spheres it overlaps,
  // deepest overlap first, with noSphere in the slots past its last
  neighbours: Uint32Array
  // How many spheres overlap more than cap others, and so lost their shallowest overlaps
  overCap: number
}

// The neighbours of every sphere, itself excluded, ordered by how deeply the two overlap, the sum of the radii less
// the distance between the centres, and cut off at cap. The centres are x, y, z triples, with a radius per sphere.
// The grid is searched at twice the largest radius, the farthest apart any two centres can be and still overlap, and
// each pair keeps what its own sum admits
export function sphereNeighbours(centers: ArrayLike<number>, radii: ArrayLike<number>, cap: number): SphereNeighbours {
  const count = radii.length
  const points: Point[] = []
  let largest = 0
  for (let i = 0; i < count; i++) {
    points.push({ x: centers[i * 3], y: centers[i * 3 + 1], z: centers[i * 3 + 2] })
    largest = Math.max(largest, radii[i])
  }
  const grid = neighbourGrid(points, 2 * largest)
  const neighbours = new Uint32Array(count * cap).fill(noSphere)

  // One visitor serves every sphere, so the search allocates nothing per sphere but its lists
  let self = 0
  let selfRadius = 0
  const indices: number[] = []
  const depths: number[] = []
  const visit = (index: number, distanceSquared: number) => {
    // The grid visits the sphere itself, which doesn't overlap itself
    if (index === self) return
    const sum = selfRadius + radii[index]
    if (distanceSquared >= sum * sum) return
    indices.push(index)
    depths.push(sum - Math.sqrt(distanceSquared))
  }

  let overCap = 0
  for (let i = 0; i < count; i++) {
    self = i
    selfRadius = radii[i]
    indices.length = 0
    depths.length = 0
    grid.forEachWithin(points[i].x, points[i].y, points[i].z, visit)
    if (indices.length > cap) overCap++
    // Deepest first, and equal depths by index, so that the order never depends on the grid's
    const order = indices.map((_, k) => k).sort((a, b) => depths[b] - depths[a] || indices[a] - indices[b])
    const kept = Math.min(order.length, cap)
    for (let k = 0; k < kept; k++) neighbours[i * cap + k] = indices[order[k]]
  }
  return { neighbours, overCap }
}
