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
// A quick count at this spacing estimates the triangles at a finer one, which grow as one over the spacing squared,
// and the pieces the cut adds, which lie along the boundaries and grow as one over the spacing
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

// The density and the owner at every point of the grid, kept whole, in the march's order: x varies fastest, then y,
// then z. Its arrays have their own buffers, so a worker can transfer them
export interface Field {
  density: Float32Array<ArrayBuffer>
  // Per point, the atom (by its index in the input) adding the most density there, or noOwner where none reaches it
  owners: Uint32Array<ArrayBuffer>
  // The grid's lowest corner in ångströms, its points per axis and its spacing
  origin: [number, number, number]
  size: [number, number, number]
  spacing: number
}

// A field packed into the bytes the field's textures take: the density as one byte per point, saturated at the
// isolevel, since beyond it a point is inside the surface and the cloud is at its densest there; and the owner as the
// three bytes of its index, the red the low, the green the middle and the blue the high, with a full fourth, as the
// atom table's shaders read an index. A point no atom reaches has every byte full
export interface PackedField {
  density: Uint8Array<ArrayBuffer>
  owners: Uint8Array<ArrayBuffer>
  origin: [number, number, number]
  size: [number, number, number]
  spacing: number
}

// The most points a field may have: twenty megabytes once packed, and sampled in under a second. A spacing that would
// give more is coarsened to fit
export const maxGridPoints = 4_000_000

// A byte's range, which an index is split into bytes by
const byteRange = 256
const fullByte = byteRange - 1

// Marching cubes over the density, with the tables and conventions of three's MarchingCubes:
// x varies fastest, then y, then z; corners in Paul Bourke's order; a corner's bit is set when it's below the isolevel.
// The triangles are then cut where their owners change, so that each has one owner. With sharpen false, the march's
// triangles stand as they are
export function meshSurface({ centers, radii, spacing }: SurfaceInput, sharpen = true): SurfaceMesh {
  if (radii.length === 0) return emptyMesh()
  const atoms = prepare(centers, radii)
  const probe = Math.max(spacing, probeSpacing)
  const count = march(atoms, probe, null)
  const h = budgetSpacing(spacing, probe, count.triangles, sharpen ? count.pieces : 0)
  const builder = new MeshBuilder()
  const { gridPoints } = march(atoms, h, builder)
  if (sharpen) builder.sharpen(centers, radii)
  return builder.finish(h, gridPoints)
}

// Samples the density and the owner at every point of the grid the spacing lays over the atoms, the march's own, and
// keeps the whole grid. Where that would have more points than maxGridPoints, the spacing is coarsened by the cube
// root of the excess, and again should the grid's border and rounding leave it over
export function sampleField({ centers, radii, spacing }: SurfaceInput): Field {
  if (radii.length === 0) return emptyField()
  const atoms = prepare(centers, radii)
  let h = spacing
  let grid = gridOver(atoms, h)
  for (let points = pointCount(grid); points > maxGridPoints; points = pointCount(grid)) {
    h *= Math.cbrt(points / maxGridPoints)
    grid = gridOver(atoms, h)
  }
  const { lo, nx, ny, nz } = grid
  const nxy = nx * ny
  const density = new Float32Array(nxy * nz)
  const owners = new Uint32Array(nxy * nz)
  const nearest = new Float32Array(nxy)
  const samplePlane = planeSampler(atoms, grid, h)
  for (let z = 0; z < nz; z++) {
    samplePlane(z, density.subarray(z * nxy, (z + 1) * nxy), owners.subarray(z * nxy, (z + 1) * nxy), nearest)
  }
  return { density, owners, origin: [lo[0], lo[1], lo[2]], size: [nx, ny, nz], spacing: h }
}

// Packs a field into the bytes its textures take
export function packField({ density, owners, origin, size, spacing }: Field): PackedField {
  const points = density.length
  const densityBytes = new Uint8Array(points)
  const ownerBytes = new Uint8Array(points * 4)
  for (let i = 0; i < points; i++) {
    densityBytes[i] = Math.round((Math.min(density[i], isolevel) / isolevel) * fullByte)
    const owner = owners[i]
    const o = i * 4
    if (owner === noOwner) {
      ownerBytes.fill(fullByte, o, o + 4)
      continue
    }
    ownerBytes[o] = owner % byteRange
    ownerBytes[o + 1] = Math.floor(owner / byteRange) % byteRange
    ownerBytes[o + 2] = Math.floor(owner / (byteRange * byteRange))
    ownerBytes[o + 3] = fullByte
  }
  return { density: densityBytes, owners: ownerBytes, origin, size, spacing }
}

// The finest spacing, no finer than the one asked for, at which the triangles counted at the probe's spacing, grown as
// one over the spacing squared, and the cut's pieces, grown as one over the spacing, together stay within the budget
function budgetSpacing(spacing: number, probe: number, triangles: number, pieces: number) {
  if (triangles === 0) return spacing
  const finer = (Math.sqrt(pieces * pieces + 4 * triangles * maxTriangles) - pieces) / (2 * triangles)
  return Math.max(spacing, probe / finer)
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

// The grid a spacing lays over the atoms: its lowest corner and its points per axis
interface Grid {
  lo: number[]
  nx: number
  ny: number
  nz: number
}

function gridOver(atoms: Atoms, h: number): Grid {
  // A spacing more on every side keeps the grid's border outside the surface, so the mesh closes
  const lo = atoms.lo.map((value) => value - h)
  const [nx, ny, nz] = [0, 1, 2].map((axis) => Math.ceil((atoms.hi[axis] - lo[axis]) / h) + 2)
  return { lo, nx, ny, nz }
}

function pointCount({ nx, ny, nz }: Grid) {
  return nx * ny * nz
}

// Computes the density on the grid's planes, each into the arrays given, in order of z: per point the total density,
// the atom adding the most density there (the one nearest relative to its radius) and that atom's d²/R². A plane
// visits only the atoms within reach of it, through the atoms sorted by z
function planeSampler(atoms: Atoms, { lo, nx, ny }: Grid, h: number) {
  const { centers, radii, byZ, reach2, maxReach } = atoms
  let windowStart = 0
  return (z: number, field: Float32Array, owner: Uint32Array, nearest: Float32Array) => {
    field.fill(0)
    owner.fill(noOwner)
    nearest.fill(Infinity)
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
}

// Marches the grid one layer of cells at a time, computing the density a plane at a time, so memory holds only the
// four planes around the current layer. With no builder, it only counts the triangles, and the pieces the cut would
// add to them
function march(atoms: Atoms, h: number, builder: MeshBuilder | null) {
  const grid = gridOver(atoms, h)
  const { lo, nx, ny, nz } = grid
  const nxy = nx * ny

  // Planes z - 1 to z + 2, in slots by z modulo 4: the density, and per point the atom adding the most density there
  // with its d²/R²
  const fields = [0, 1, 2, 3].map(() => new Float32Array(nxy))
  const owners = [0, 1, 2, 3].map(() => new Uint32Array(nxy))
  const nearests = [0, 1, 2, 3].map(() => new Float32Array(nxy))
  const samplePlane = planeSampler(atoms, grid, h)
  const computePlane = (z: number) => {
    const slot = z & 3
    samplePlane(z, fields[slot], owners[slot], nearests[slot])
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

    return mesh.addVertex(
      lo[0] + (x + (axis === 0 ? t : 0)) * h,
      lo[1] + (y + (axis === 1 ? t : 0)) * h,
      lo[2] + (z + (axis === 2 ? t : 0)) * h,
      normalX / length,
      normalY / length,
      normalZ / length,
      edgeOwner(a, b, z, zb, t),
    )
  }

  // The owner of a vertex t of the way along the edge from grid point a on plane z to grid point b on plane zb: the
  // nearer end's, or the other end's if no atom reaches the nearer one
  const edgeOwner = (a: number, b: number, z: number, zb: number, t: number) => {
    const ownerA = owners[z & 3][a]
    const ownerB = owners[zb & 3][b]
    const near = t < 0.5 ? ownerA : ownerB
    const far = t < 0.5 ? ownerB : ownerA
    return near === noOwner ? far : near
  }

  // The owner of the vertex on the edge from grid point (x, y, z) along the axis, for the count of the cut's pieces
  const vertexOwner = (x: number, y: number, z: number, axis: 0 | 1 | 2) => {
    const a = y * nx + x
    const b = axis === 0 ? a + 1 : axis === 1 ? a + nx : a
    const zb = axis === 2 ? z + 1 : z
    const fa = fields[z & 3][a]
    const fb = fields[zb & 3][b]
    return edgeOwner(a, b, z, zb, (isolevel - fa) / (fb - fa))
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
  // Per edge of the current cube, its vertex when building, or its vertex's owner when counting
  const cubeEdges = new Int32Array(12)
  const cubeEdge = (e: number, cache: Int32Array, x: number, y: number, z: number, axis: 0 | 1 | 2) => {
    cubeEdges[e] = builder ? edgeVertex(builder, cache, x, y, z, axis) : vertexOwner(x, y, z, axis)
  }

  let triangles = 0
  // The triangles the cut adds: two for a triangle with two owners, five for one with three
  let pieces = 0
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

        // Bourke's edges 0 to 11, from the corners they join
        if (edges & 1) cubeEdge(0, xEdges[slab], x, y, z, 0)
        if (edges & 2) cubeEdge(1, yEdges[slab], x + 1, y, z, 1)
        if (edges & 4) cubeEdge(2, xEdges[slab], x, y + 1, z, 0)
        if (edges & 8) cubeEdge(3, yEdges[slab], x, y, z, 1)
        if (edges & 16) cubeEdge(4, xEdges[slab ^ 1], x, y, z + 1, 0)
        if (edges & 32) cubeEdge(5, yEdges[slab ^ 1], x + 1, y, z + 1, 1)
        if (edges & 64) cubeEdge(6, xEdges[slab ^ 1], x, y + 1, z + 1, 0)
        if (edges & 128) cubeEdge(7, yEdges[slab ^ 1], x, y, z + 1, 1)
        if (edges & 256) cubeEdge(8, zEdges, x, y, z, 2)
        if (edges & 512) cubeEdge(9, zEdges, x + 1, y, z, 2)
        if (edges & 1024) cubeEdge(10, zEdges, x + 1, y + 1, z, 2)
        if (edges & 2048) cubeEdge(11, zEdges, x, y + 1, z, 2)

        for (let t = cube * 16; triTable[t] !== -1; t += 3) {
          const a = cubeEdges[triTable[t]]
          const b = cubeEdges[triTable[t + 1]]
          const c = cubeEdges[triTable[t + 2]]
          if (builder) builder.addTriangle(a, b, c)
          else if (a !== b || b !== c) pieces += a !== b && b !== c && c !== a ? 5 : 2
        }
      }
    }
  }
  return { triangles, pieces, gridPoints: nxy * nz }
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

  // Cuts every triangle whose corners have different owners at the points on its edges where the owner changes, so
  // that each piece has one owner and two atoms' colours meet along a line instead of blending across the triangle.
  // A crossing is one point written as a vertex per owner, so the pieces on either side share no vertex but meet by
  // position, and the surface keeps its shape
  sharpen(centers: Float32Array, radii: Float32Array) {
    const triangles = this.indices
    const indexCount = this.indexCount
    this.indices = new Uint32Array(triangles.length)
    this.indexCount = 0

    // Each edge's crossing, keyed by the edge's two ends, as the first of its two vertices: the one with the lower end's
    // owner, then the higher end's. Made once per edge, so the triangles on either side cut it at the same point
    const stride = this.vertexCount
    const crossings = new Map<number, number>()
    // The vertex at the crossing of the edge from v to w that has v's owner
    const crossing = (v: number, w: number) => {
      const lo = Math.min(v, w)
      const hi = Math.max(v, w)
      const key = lo * stride + hi
      let first = crossings.get(key)
      if (first === undefined) {
        first = this.addCrossing(lo, hi, centers, radii)
        crossings.set(key, first)
      }
      return v === lo ? first : first + 1
    }

    for (let t = 0; t < indexCount; t += 3) {
      let a = triangles[t]
      let b = triangles[t + 1]
      let c = triangles[t + 2]
      const ownerA = this.owners[a]
      const ownerB = this.owners[b]
      const ownerC = this.owners[c]
      if (ownerA === ownerB && ownerB === ownerC) {
        this.addTriangle(a, b, c)
        continue
      }
      if (ownerA !== ownerB && ownerB !== ownerC && ownerC !== ownerA) {
        // Three owners: a quad per corner, from the corner along its two edges to their crossings and the centroid,
        // which is written per owner like a crossing
        const g = this.addCentroid(a, b, c)
        this.addPiece(a, crossing(a, b), g)
        this.addPiece(a, g, crossing(a, c))
        this.addPiece(b, crossing(b, c), g + 1)
        this.addPiece(b, g + 1, crossing(b, a))
        this.addPiece(c, crossing(c, a), g + 2)
        this.addPiece(c, g + 2, crossing(c, b))
        continue
      }
      // Two owners: the corners turned, keeping their winding, so that the lone one is c
      if (ownerB === ownerC) {
        const lone = a
        a = b
        b = c
        c = lone
      } else if (ownerA === ownerC) {
        const lone = b
        b = a
        a = c
        c = lone
      }
      // The lone corner's piece, then the two of the quad that's left
      this.addPiece(crossing(c, b), c, crossing(c, a))
      this.addPiece(a, b, crossing(b, c))
      this.addPiece(a, crossing(b, c), crossing(a, c))
    }
  }

  // Adds a piece of a cut triangle, unless two of its corners sit at one point: the march's single-precision positions
  // can put two vertices a hair apart, and the crossings on the edges to them then round to the same point
  private addPiece(a: number, b: number, c: number) {
    if (this.samePosition(a, b) || this.samePosition(b, c) || this.samePosition(c, a)) return
    this.addTriangle(a, b, c)
  }

  private samePosition(v: number, w: number) {
    const { positions } = this
    const p = v * 3
    const q = w * 3
    return positions[p] === positions[q] && positions[p + 1] === positions[q + 1] && positions[p + 2] === positions[q + 2]
  }

  // Writes the point on the edge from vertex lo to vertex hi where their owners are equally near, as two vertices with
  // lo's owner and then hi's, and returns the first
  private addCrossing(lo: number, hi: number, centers: Float32Array, radii: Float32Array) {
    const { positions, normals } = this
    const ownerLo = this.owners[lo]
    const ownerHi = this.owners[hi]
    const t = crossingAlong(positions, lo, hi, ownerLo, ownerHi, centers, radii)
    const p = lo * 3
    const q = hi * 3
    const x = positions[p] + t * (positions[q] - positions[p])
    const y = positions[p + 1] + t * (positions[q + 1] - positions[p + 1])
    const z = positions[p + 2] + t * (positions[q + 2] - positions[p + 2])
    const normalX = normals[p] + t * (normals[q] - normals[p])
    const normalY = normals[p + 1] + t * (normals[q + 1] - normals[p + 1])
    const normalZ = normals[p + 2] + t * (normals[q + 2] - normals[p + 2])
    const length = Math.hypot(normalX, normalY, normalZ) || 1
    const first = this.addVertex(x, y, z, normalX / length, normalY / length, normalZ / length, ownerLo)
    this.addVertex(x, y, z, normalX / length, normalY / length, normalZ / length, ownerHi)
    return first
  }

  // Writes a triangle's centroid as three vertices, with the owners of a, b and c in turn, and returns the first
  private addCentroid(a: number, b: number, c: number) {
    const { positions, normals } = this
    const ownerA = this.owners[a]
    const ownerB = this.owners[b]
    const ownerC = this.owners[c]
    const p = a * 3
    const q = b * 3
    const r = c * 3
    const x = (positions[p] + positions[q] + positions[r]) / 3
    const y = (positions[p + 1] + positions[q + 1] + positions[r + 1]) / 3
    const z = (positions[p + 2] + positions[q + 2] + positions[r + 2]) / 3
    const normalX = normals[p] + normals[q] + normals[r]
    const normalY = normals[p + 1] + normals[q + 1] + normals[r + 1]
    const normalZ = normals[p + 2] + normals[q + 2] + normals[r + 2]
    const length = Math.hypot(normalX, normalY, normalZ) || 1
    const first = this.addVertex(x, y, z, normalX / length, normalY / length, normalZ / length, ownerA)
    this.addVertex(x, y, z, normalX / length, normalY / length, normalZ / length, ownerB)
    this.addVertex(x, y, z, normalX / length, normalY / length, normalZ / length, ownerC)
    return first
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

// How far along the edge from vertex lo to vertex hi their two owners are equally near, each distance taken as a share
// of the atom's radius: the root between 0 and 1 of the difference of the two squared shares, which is quadratic along
// the edge. Where there are two, the one where the first owner gives way to the second; where there is none, the midpoint
function crossingAlong(
  positions: Float32Array,
  lo: number,
  hi: number,
  ownerLo: number,
  ownerHi: number,
  centers: Float32Array,
  radii: Float32Array,
) {
  const p = lo * 3
  const q = hi * 3
  const i = ownerLo * 3
  const j = ownerHi * 3
  const ex = positions[q] - positions[p]
  const ey = positions[q + 1] - positions[p + 1]
  const ez = positions[q + 2] - positions[p + 2]
  const ux = positions[p] - centers[i]
  const uy = positions[p + 1] - centers[i + 1]
  const uz = positions[p + 2] - centers[i + 2]
  const vx = positions[p] - centers[j]
  const vy = positions[p + 1] - centers[j + 1]
  const vz = positions[p + 2] - centers[j + 2]
  const weightLo = 1 / (radii[ownerLo] * radii[ownerLo])
  const weightHi = 1 / (radii[ownerHi] * radii[ownerHi])
  const a = (ex * ex + ey * ey + ez * ez) * (weightLo - weightHi)
  const b = 2 * ((ux * ex + uy * ey + uz * ez) * weightLo - (vx * ex + vy * ey + vz * ez) * weightHi)
  const c = (ux * ux + uy * uy + uz * uz) * weightLo - (vx * vx + vy * vy + vz * vz) * weightHi
  if (a === 0) {
    // Equal radii, so the shares are equal on a plane, which the edge meets once
    const t = -c / b
    return t >= 0 && t <= 1 ? t : 0.5
  }
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0) return 0.5
  // The two roots, written so that neither loses precision to cancellation
  const half = -(b + Math.sign(b || 1) * Math.sqrt(discriminant)) / 2
  const first = half / a
  const second = half === 0 ? first : c / half
  // The difference rises through the root where the first owner gives way to the second
  const rising = a > 0 ? Math.max(first, second) : Math.min(first, second)
  const other = rising === first ? second : first
  if (rising >= 0 && rising <= 1) return rising
  if (other >= 0 && other <= 1) return other
  return 0.5
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

function emptyField(): Field {
  return { density: new Float32Array(0), owners: new Uint32Array(0), origin: [0, 0, 0], size: [0, 0, 0], spacing: 0 }
}
