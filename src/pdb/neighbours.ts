// A uniform grid over points in space, which finds every point within a fixed radius of a place

export interface NeighbourGrid {
  // Calls visit with the index and squared distance of each point within the radius of (x, y, z), itself included
  forEachWithin(x: number, y: number, z: number, visit: (index: number, distanceSquared: number) => void): void
}

// The most cells a grid holds, so that a sparse entry spread across a large box can't take a huge array. Beyond it the
// cells widen, which keeps the search to the 27 cells around a point and only adds points to test
const maxCells = 1 << 22

// A grid over points given as x, y, z triples, each known by its index among them: those whose indices are listed, or
// every one where no list is given. Cells are at least as wide as the radius, so every point within it of a place lies
// in the 27 cells around that place's
export function neighbourGrid(positions: ArrayLike<number>, radius: number, members?: ArrayLike<number>): NeighbourGrid {
  const count = members ? members.length : Math.floor(positions.length / 3)
  const indexOf = (member: number) => (members ? members[member] : member)
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let member = 0; member < count; member++) {
    const at = indexOf(member) * 3
    minX = Math.min(minX, positions[at])
    minY = Math.min(minY, positions[at + 1])
    minZ = Math.min(minZ, positions[at + 2])
    maxX = Math.max(maxX, positions[at])
    maxY = Math.max(maxY, positions[at + 1])
    maxZ = Math.max(maxZ, positions[at + 2])
  }
  if (count === 0) return { forEachWithin: () => undefined }

  const spanX = maxX - minX
  const spanY = maxY - minY
  const spanZ = maxZ - minZ
  let size = Math.max(radius, Number.EPSILON)
  const cellsFor = (s: number) => (Math.floor(spanX / s) + 1) * (Math.floor(spanY / s) + 1) * (Math.floor(spanZ / s) + 1)
  while (cellsFor(size) > maxCells) size *= 2
  const nx = Math.floor(spanX / size) + 1
  const ny = Math.floor(spanY / size) + 1
  const nz = Math.floor(spanZ / size) + 1
  const cellOf = (x: number, y: number, z: number) =>
    (Math.floor((z - minZ) / size) * ny + Math.floor((y - minY) / size)) * nx + Math.floor((x - minX) / size)

  // Each cell's points' indices, stored contiguously: cell c's run starts at starts[c] and ends at starts[c + 1]
  const starts = new Int32Array(nx * ny * nz + 1)
  const cells = new Int32Array(count)
  for (let member = 0; member < count; member++) {
    const at = indexOf(member) * 3
    cells[member] = cellOf(positions[at], positions[at + 1], positions[at + 2])
    starts[cells[member] + 1]++
  }
  for (let c = 1; c < starts.length; c++) starts[c] += starts[c - 1]
  const filled = starts.slice(0, -1)
  const indices = new Int32Array(count)
  for (let member = 0; member < count; member++) indices[filled[cells[member]]++] = indexOf(member)

  const radiusSquared = radius * radius
  return {
    forEachWithin(x, y, z, visit) {
      const cx = Math.floor((x - minX) / size)
      const cy = Math.floor((y - minY) / size)
      const cz = Math.floor((z - minZ) / size)
      const lowX = Math.max(cx - 1, 0)
      const highX = Math.min(cx + 1, nx - 1)
      if (lowX > highX) return
      for (let k = Math.max(cz - 1, 0); k <= Math.min(cz + 1, nz - 1); k++) {
        for (let j = Math.max(cy - 1, 0); j <= Math.min(cy + 1, ny - 1); j++) {
          const row = (k * ny + j) * nx
          const first = starts[row + lowX]
          const last = starts[row + highX + 1]
          for (let m = first; m < last; m++) {
            const index = indices[m]
            const at = index * 3
            const dx = positions[at] - x
            const dy = positions[at + 1] - y
            const dz = positions[at + 2] - z
            const distanceSquared = dx * dx + dy * dy + dz * dz
            if (distanceSquared <= radiusSquared) visit(index, distanceSquared)
          }
        }
      }
    },
  }
}
