import { edgeTable, triTable } from 'three/addons/objects/MarchingCubes.js'

// Each atom adds a density of exp(-k (d²/R² - 1)), which is 1 at its radius R, and the surface is where the total is 1.
// So a lone atom's surface is its sphere, and neighbours blend into a smooth surface over the gaps between them
export interface SurfaceInput {
  // x, y, z per atom, in ångströms
  centers: Float32Array
  radii: Float32Array
  // The grid's spacing in ångströms, which a large entry coarsens to stay within maxTriangles
  spacing: number
}

// Its arrays have their own buffers, so a worker can transfer them
export interface SurfaceMesh {
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  // Per vertex, the atom (by its index in the input) adding the most density there, which colours it
  owners: Uint32Array<ArrayBuffer>
  // The grid's spacing in ångströms, and its number of points
  spacing: number
  gridPoints: number
}

const isolevel = 1
// An atom's density is left out where it's below 1% of the isolevel
const cutoffLog = Math.log(100)
// How sharply an atom's density falls off: this flows over gaps under 1 Å wide between two atoms, and about 1.5 Å
// between rows of them, as a solvent-excluded surface does over gaps narrower than a water molecule, where a larger k
// would keep closer to the van der Waals spheres
const k = 1.2
// The most triangles a surface may have: about what a strong desktop GPU draws smoothly, with an index buffer of
// 120 MB, inside WebGPU's default 256 MB limit. A spacing that would give more is coarsened to fit
const maxTriangles = 10_000_000
// A quick count at this spacing estimates the triangles at a finer one, which grow as one over the spacing squared
const probeSpacing = 1
// Marks a grid point no atom reaches
const noOwner = 0xffffffff
// How many triangles each cube configuration makes
const cubeTriangles = Uint8Array.from({ length: 256 }, (_, cube) => {
  let count = 0
  while (triTable[cube * 16 + count * 3] !== -1) count++
  return count
})

interface Atoms {
  centers: Float32Array
  radii: Float32Array
  // Atom indices sorted by z, so each plane of the grid visits only the atoms within reach of it
  byZ: Uint32Array
  // An atom's reach, as a multiple of its radius squared, and the longest reach of any atom
  reach2: number
  maxReach: number
  lo: number[]
  hi: number[]
}

// Marching cubes over the density, with the tables and conventions of three's MarchingCubes:
// x varies fastest, then y, then z; corners in Paul Bourke's order; a corner's bit is set when it's below the isolevel
export function meshSurface({ centers, radii, spacing }: SurfaceInput): SurfaceMesh {
  if (radii.length === 0) return emptyMesh()
  const atoms = prepare(centers, radii)
  const probe = Math.max(spacing, probeSpacing)
  const estimate = march(atoms, probe, null).triangles
  const h = Math.max(spacing, probe * Math.sqrt(estimate / maxTriangles))
  const builder = new MeshBuilder()
  const { gridPoints } = march(atoms, h, builder)
  return builder.finish(h, gridPoints)
}

function prepare(centers: Float32Array, radii: Float32Array): Atoms {
  const reach2 = 1 + cutoffLog / k
  let maxReach = 0
  for (const radius of radii) maxReach = Math.max(maxReach, radius * Math.sqrt(reach2))
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < radii.length; i++) {
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], centers[i * 3 + axis] - maxReach)
      hi[axis] = Math.max(hi[axis], centers[i * 3 + axis] + maxReach)
    }
  }
  const byZ = Uint32Array.from(radii.keys()).sort((a, b) => centers[a * 3 + 2] - centers[b * 3 + 2])
  return { centers, radii, byZ, reach2, maxReach, lo, hi }
}

// Marches the grid one layer of cells at a time, computing the density a plane at a time, so memory holds only the
// four planes around the current layer. With no builder, it only counts the triangles
function march(atoms: Atoms, h: number, builder: MeshBuilder | null) {
  const { centers, radii, byZ, reach2, maxReach } = atoms
  // A spacing more on every side keeps the grid's border outside the surface, so the mesh closes
  const lo = atoms.lo.map((value) => value - h)
  const [nx, ny, nz] = [0, 1, 2].map((axis) => Math.ceil((atoms.hi[axis] - lo[axis]) / h) + 2)
  const nxy = nx * ny

  // Planes z - 1 to z + 2, in slots by z modulo 4: the density, and per point the atom adding the most density there
  // (the one nearest relative to its radius) with its d²/R²
  const fields = [0, 1, 2, 3].map(() => new Float32Array(nxy))
  const owners = [0, 1, 2, 3].map(() => new Uint32Array(nxy))
  const nearests = [0, 1, 2, 3].map(() => new Float32Array(nxy))
  let windowStart = 0
  const computePlane = (z: number) => {
    const slot = z & 3
    const field = fields[slot].fill(0)
    const owner = owners[slot].fill(noOwner)
    const nearest = nearests[slot].fill(Infinity)
    const pz = lo[2] + z * h
    while (windowStart < byZ.length && centers[byZ[windowStart] * 3 + 2] < pz - maxReach) windowStart++
    for (let s = windowStart; s < byZ.length; s++) {
      const i = byZ[s]
      const cz = centers[i * 3 + 2]
      if (cz > pz + maxReach) break
      const inverse = 1 / (radii[i] * radii[i])
      const qz = (pz - cz) * (pz - cz) * inverse
      if (qz >= reach2) continue
      const cx = centers[i * 3]
      const cy = centers[i * 3 + 1]
      const extent = radii[i] * Math.sqrt(reach2 - qz)
      const x0 = Math.max(0, Math.ceil((cx - extent - lo[0]) / h))
      const x1 = Math.min(nx - 1, Math.floor((cx + extent - lo[0]) / h))
      const y0 = Math.max(0, Math.ceil((cy - extent - lo[1]) / h))
      const y1 = Math.min(ny - 1, Math.floor((cy + extent - lo[1]) / h))
      for (let y = y0; y <= y1; y++) {
        const dy = lo[1] + y * h - cy
        const qyz = qz + dy * dy * inverse
        if (qyz >= reach2) continue
        const row = y * nx
        for (let x = x0; x <= x1; x++) {
          const dx = lo[0] + x * h - cx
          const q = qyz + dx * dx * inverse
          if (q >= reach2) continue
          field[row + x] += Math.exp(-k * (q - 1))
          if (q < nearest[row + x]) {
            nearest[row + x] = q
            owner[row + x] = i
          }
        }
      }
    }
  }

  // The vertex where the surface crosses the edge from grid point (x, y, z) to the next point along the axis
  const gradient = [0, 0, 0]
  const addVertex = (mesh: MeshBuilder, x: number, y: number, z: number, axis: 0 | 1 | 2) => {
    const a = y * nx + x
    const b = axis === 0 ? a + 1 : axis === 1 ? a + nx : a
    const zb = axis === 2 ? z + 1 : z
    const fa = fields[z & 3][a]
    const fb = fields[zb & 3][b]
    const t = (isolevel - fa) / (fb - fa)

    // Density falls outward, so the normal is minus the gradient, taken at both ends and interpolated
    densityGradient(a, x, y, z, gradient)
    const gx = gradient[0]
    const gy = gradient[1]
    const gz = gradient[2]
    densityGradient(b, x + (axis === 0 ? 1 : 0), y + (axis === 1 ? 1 : 0), zb, gradient)
    const normalX = -(gx + t * (gradient[0] - gx))
    const normalY = -(gy + t * (gradient[1] - gy))
    const normalZ = -(gz + t * (gradient[2] - gz))
    const length = Math.hypot(normalX, normalY, normalZ) || 1

    // The owner of the nearer end, or of the other end if no atom reaches the nearer one
    const ownerA = owners[z & 3][a]
    const ownerB = owners[zb & 3][b]
    const near = t < 0.5 ? ownerA : ownerB
    const far = t < 0.5 ? ownerB : ownerA

    return mesh.addVertex(
      lo[0] + (x + (axis === 0 ? t : 0)) * h,
      lo[1] + (y + (axis === 1 ? t : 0)) * h,
      lo[2] + (z + (axis === 2 ? t : 0)) * h,
      normalX / length,
      normalY / length,
      normalZ / length,
      near === noOwner ? far : near,
    )
  }

  // Central differences, one-sided at the grid's border, where the density is near zero anyway
  const densityGradient = (i: number, x: number, y: number, z: number, out: number[]) => {
    const field = fields[z & 3]
    out[0] = field[x < nx - 1 ? i + 1 : i] - field[x > 0 ? i - 1 : i]
    out[1] = field[y < ny - 1 ? i + nx : i] - field[y > 0 ? i - nx : i]
    out[2] = fields[(z < nz - 1 ? z + 1 : z) & 3][i] - fields[(z > 0 ? z - 1 : z) & 3][i]
  }

  // Vertices on x and y edges are cached for the layer of cells below and above, and on z edges for the current one,
  // so neighbouring cells share them
  const xEdges = [new Int32Array(nxy).fill(-1), new Int32Array(nxy).fill(-1)]
  const yEdges = [new Int32Array(nxy).fill(-1), new Int32Array(nxy).fill(-1)]
  const zEdges = new Int32Array(nxy)
  const edgeVertex = (mesh: MeshBuilder, cache: Int32Array, x: number, y: number, z: number, axis: 0 | 1 | 2) => {
    const key = y * nx + x
    if (cache[key] < 0) cache[key] = addVertex(mesh, x, y, z, axis)
    return cache[key]
  }
  const cubeEdges = new Int32Array(12)

  let triangles = 0
  let computed = 0
  for (let z = 0; z < nz - 1; z++) {
    while (computed <= Math.min(z + 2, nz - 1)) computePlane(computed++)
    const below = fields[z & 3]
    const above = fields[(z + 1) & 3]
    const slab = z & 1
    if (builder) {
      xEdges[slab ^ 1].fill(-1)
      yEdges[slab ^ 1].fill(-1)
      zEdges.fill(-1)
    }
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const i = y * nx + x
        let cube = 0
        if (below[i] < isolevel) cube |= 1
        if (below[i + 1] < isolevel) cube |= 2
        if (below[i + 1 + nx] < isolevel) cube |= 4
        if (below[i + nx] < isolevel) cube |= 8
        if (above[i] < isolevel) cube |= 16
        if (above[i + 1] < isolevel) cube |= 32
        if (above[i + 1 + nx] < isolevel) cube |= 64
        if (above[i + nx] < isolevel) cube |= 128
        const edges = edgeTable[cube]
        if (edges === 0) continue
        triangles += cubeTriangles[cube]
        if (!builder) continue

        // Bourke's edges 0 to 11, from the corners they join
        if (edges & 1) cubeEdges[0] = edgeVertex(builder, xEdges[slab], x, y, z, 0)
        if (edges & 2) cubeEdges[1] = edgeVertex(builder, yEdges[slab], x + 1, y, z, 1)
        if (edges & 4) cubeEdges[2] = edgeVertex(builder, xEdges[slab], x, y + 1, z, 0)
        if (edges & 8) cubeEdges[3] = edgeVertex(builder, yEdges[slab], x, y, z, 1)
        if (edges & 16) cubeEdges[4] = edgeVertex(builder, xEdges[slab ^ 1], x, y, z + 1, 0)
        if (edges & 32) cubeEdges[5] = edgeVertex(builder, yEdges[slab ^ 1], x + 1, y, z + 1, 1)
        if (edges & 64) cubeEdges[6] = edgeVertex(builder, xEdges[slab ^ 1], x, y + 1, z + 1, 0)
        if (edges & 128) cubeEdges[7] = edgeVertex(builder, yEdges[slab ^ 1], x, y, z + 1, 1)
        if (edges & 256) cubeEdges[8] = edgeVertex(builder, zEdges, x, y, z, 2)
        if (edges & 512) cubeEdges[9] = edgeVertex(builder, zEdges, x + 1, y, z, 2)
        if (edges & 1024) cubeEdges[10] = edgeVertex(builder, zEdges, x + 1, y + 1, z, 2)
        if (edges & 2048) cubeEdges[11] = edgeVertex(builder, zEdges, x, y + 1, z, 2)

        for (let t = cube * 16; triTable[t] !== -1; t += 3) {
          builder.addTriangle(cubeEdges[triTable[t]], cubeEdges[triTable[t + 1]], cubeEdges[triTable[t + 2]])
        }
      }
    }
  }
  return { triangles, gridPoints: nxy * nz }
}

// Collects the mesh in typed arrays that double as they fill, since a fine surface can have millions of vertices
class MeshBuilder {
  private positions = new Float32Array(3 << 12)
  private normals = new Float32Array(3 << 12)
  private owners = new Uint32Array(1 << 12)
  private indices = new Uint32Array(3 << 13)
  private vertexCount = 0
  private indexCount = 0

  addVertex(x: number, y: number, z: number, normalX: number, normalY: number, normalZ: number, owner: number) {
    if (this.vertexCount === this.owners.length) {
      this.positions = growFloats(this.positions)
      this.normals = growFloats(this.normals)
      this.owners = growIndices(this.owners)
    }
    const v = this.vertexCount * 3
    this.positions[v] = x
    this.positions[v + 1] = y
    this.positions[v + 2] = z
    this.normals[v] = normalX
    this.normals[v + 1] = normalY
    this.normals[v + 2] = normalZ
    this.owners[this.vertexCount] = owner
    return this.vertexCount++
  }

  addTriangle(a: number, b: number, c: number) {
    if (this.indexCount + 3 > this.indices.length) this.indices = growIndices(this.indices)
    this.indices[this.indexCount++] = a
    this.indices[this.indexCount++] = b
    this.indices[this.indexCount++] = c
  }

  finish(spacing: number, gridPoints: number): SurfaceMesh {
    return {
      positions: this.positions.slice(0, this.vertexCount * 3),
      normals: this.normals.slice(0, this.vertexCount * 3),
      indices: this.indices.slice(0, this.indexCount),
      owners: this.owners.slice(0, this.vertexCount),
      spacing,
      gridPoints,
    }
  }
}

function growFloats(array: Float32Array<ArrayBuffer>) {
  const larger = new Float32Array(array.length * 2)
  larger.set(array)
  return larger
}

function growIndices(array: Uint32Array<ArrayBuffer>) {
  const larger = new Uint32Array(array.length * 2)
  larger.set(array)
  return larger
}

function emptyMesh(): SurfaceMesh {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    owners: new Uint32Array(0),
    spacing: 0,
    gridPoints: 0,
  }
}
