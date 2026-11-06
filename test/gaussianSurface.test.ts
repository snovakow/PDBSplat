import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  maxGridPoints,
  meshSurface,
  packField,
  sampleField,
  type Field,
  type SurfaceMesh,
} from '../src/surface/gaussianSurface.ts'
import { readAtomIndex } from '../src/viewer/atomTable.ts'

// The mesher's surface, checked on a lone sphere, a pair of unequal spheres, a pair of equal ones and a ring of heavy
// atoms with hydrogens, all built here; then the field sampled on the same grid, and its packing into bytes

// The density's parameters, as the mesher has them: the surface is where the density is 1, an atom's density falls
// off as the exponential of minus the steepness times its squared distance over its squared radius, less 1, and it's
// left out below a hundredth of the isolevel
const isolevel = 1
const steepness = 1.2
const cutoffRatio = 100

// Van der Waals radii of the atoms the meshes are built from
const carbon = 1.7
const nitrogen = 1.55
const hydrogen = 1.2

// The tolerances, each measured on these inputs: the lone sphere's vertices lie within 0.33% of its radius and their
// normals' dot with the radial direction is above 0.99995; the split keeps the pair's area to 1.2e-10 of itself; where
// a cut edge straddles the boundary, the crossing's two shares agree to 2.2e-8; the two carbons' crossings sit on the
// plane exactly; and every one of the ring's normals points away from its owner
const radiusTolerance = 0.01
const normalTolerance = 0.99
const areaTolerance = 1e-6
const shareTolerance = 1e-3
const planeTolerance = 1e-6
const awayShare = 0.99
// A piece of a cut triangle can be a sliver, three near-collinear points in single precision, whose geometric normal
// is noise: the ring's cut leaves eight whose winding reads reversed, of up to 4.2e-8 Å². Triangles below this area are
// passed over and counted, since the march itself makes proper ones down to 3e-11 Å²
const sliverArea = 1e-7

const lone = { centers: Float32Array.of(0, 0, 0), radii: Float32Array.of(carbon), spacing: 0.25 }
const pair = { centers: Float32Array.of(0, 0, 0, 1.5, 0, 0), radii: Float32Array.of(carbon, nitrogen), spacing: 0.25 }
const carbons = { centers: Float32Array.of(0, 0, 0, 1.5, 0, 0), radii: Float32Array.of(carbon, carbon), spacing: 0.25 }

// A dozen carbons 1.4 Å apart in a ring, each with a hydrogen 1.09 Å outward
function ring() {
  const count = 12
  const ringRadius = 1.4 / (2 * Math.sin(Math.PI / count))
  const centers: number[] = []
  const radii: number[] = []
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count
    centers.push(ringRadius * Math.cos(angle), ringRadius * Math.sin(angle), 0)
    radii.push(carbon)
    centers.push((ringRadius + 1.09) * Math.cos(angle), (ringRadius + 1.09) * Math.sin(angle), 0)
    radii.push(hydrogen)
  }
  return { centers: Float32Array.from(centers), radii: Float32Array.from(radii), spacing: 0.5 }
}

function vertexCount(mesh: SurfaceMesh) {
  return mesh.positions.length / 3
}

function position(mesh: SurfaceMesh, vertex: number) {
  return Array.from(mesh.positions.subarray(vertex * 3, vertex * 3 + 3))
}

function normal(mesh: SurfaceMesh, vertex: number) {
  return Array.from(mesh.normals.subarray(vertex * 3, vertex * 3 + 3))
}

function positionKey(mesh: SurfaceMesh, vertex: number) {
  return position(mesh, vertex).join(',')
}

// How many triangles each edge lies in, the edges named by a key of their two ends
function edgeCounts(mesh: SurfaceMesh, key: (vertex: number) => string) {
  const counts = new Map<string, number>()
  for (let t = 0; t < mesh.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(mesh.indices[t + e])
      const b = key(mesh.indices[t + ((e + 1) % 3)])
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`
      counts.set(edge, (counts.get(edge) ?? 0) + 1)
    }
  }
  return counts
}

function assertClosed(mesh: SurfaceMesh, key: (vertex: number) => string) {
  const counts = edgeCounts(mesh, key)
  assert.ok(counts.size > 0)
  for (const [edge, count] of counts) assert.equal(count, 2, `edge ${edge} lies in ${count} triangles`)
}

// A triangle's area vector: its geometric normal, twice its area long
function areaVector(mesh: SurfaceMesh, t: number) {
  const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]].map((v) => position(mesh, v))
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

function meshArea(mesh: SurfaceMesh) {
  let area = 0
  for (let t = 0; t < mesh.indices.length; t += 3) area += Math.hypot(...areaVector(mesh, t)) / 2
  return area
}

// Checks that every triangle's geometric normal agrees with its vertices' normals, and returns how many slivers were
// passed over
function assertWinding(mesh: SurfaceMesh) {
  let slivers = 0
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [gx, gy, gz] = areaVector(mesh, t)
    if (Math.hypot(gx, gy, gz) / 2 < sliverArea) {
      slivers++
      continue
    }
    let nx = 0
    let ny = 0
    let nz = 0
    for (let e = 0; e < 3; e++) {
      const [x, y, z] = normal(mesh, mesh.indices[t + e])
      nx += x
      ny += y
      nz += z
    }
    assert.ok(gx * nx + gy * ny + gz * nz > 0, `triangle ${t / 3} winds against its normals`)
  }
  return slivers
}

function assertOneOwnerPerTriangle(mesh: SurfaceMesh) {
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const owner = mesh.owners[mesh.indices[t]]
    assert.equal(mesh.owners[mesh.indices[t + 1]], owner, `triangle ${t / 3} has two owners`)
    assert.equal(mesh.owners[mesh.indices[t + 2]], owner, `triangle ${t / 3} has two owners`)
  }
}

// An atom's share of a point: its distance over its radius
function share(input: typeof pair, atom: number, [x, y, z]: number[]) {
  const dx = x - input.centers[atom * 3]
  const dy = y - input.centers[atom * 3 + 1]
  const dz = z - input.centers[atom * 3 + 2]
  return Math.hypot(dx, dy, dz) / input.radii[atom]
}

void test('a lone carbon meshes to its sphere', () => {
  const mesh = meshSurface(lone)
  assert.equal(mesh.spacing, lone.spacing)
  assert.ok(vertexCount(mesh) > 100)
  for (let v = 0; v < vertexCount(mesh); v++) {
    const [x, y, z] = position(mesh, v)
    const r = Math.hypot(x, y, z)
    assert.ok(Math.abs(r - carbon) <= radiusTolerance * carbon, `vertex ${v} at radius ${r}`)
    const [nx, ny, nz] = normal(mesh, v)
    assert.ok((nx * x + ny * y + nz * z) / r > normalTolerance, `vertex ${v} normal off the radial direction`)
    assert.equal(mesh.owners[v], 0)
  }
})

void test('the lone sphere is closed', () => {
  assertClosed(meshSurface(lone, false), (v) => String(v))
  const split = meshSurface(lone)
  assertClosed(split, (v) => positionKey(split, v))
})

void test('every triangle winds outward', (t) => {
  const meshes = { lone: meshSurface(lone), pair: meshSurface(pair), carbons: meshSurface(carbons), ring: meshSurface(ring()) }
  for (const [name, mesh] of Object.entries(meshes)) {
    const slivers = assertWinding(mesh)
    t.diagnostic(`${name}: ${slivers} slivers of ${mesh.indices.length / 3} triangles passed over`)
  }
  assert.equal(assertWinding(meshSurface(lone, false)), 0)
  assert.equal(assertWinding(meshSurface(ring(), false)), 0)
})

void test('the split gives every triangle one owner and keeps the area and the march', () => {
  const unsplit = meshSurface(pair, false)
  const split = meshSurface(pair)
  assert.equal(split.spacing, unsplit.spacing)
  assert.ok(vertexCount(split) > vertexCount(unsplit))
  assertOneOwnerPerTriangle(split)
  const area = meshArea(unsplit)
  assert.ok(Math.abs(meshArea(split) - area) <= areaTolerance * area)
  // The march's vertices come first, unchanged
  assert.deepEqual(split.positions.subarray(0, unsplit.positions.length), unsplit.positions)
  assert.deepEqual(split.normals.subarray(0, unsplit.normals.length), unsplit.normals)
  assert.deepEqual(split.owners.subarray(0, unsplit.owners.length), unsplit.owners)
})

void test('each crossing is written twice where the two owners are equally near, or at a midpoint stand-in', (t) => {
  const unsplit = meshSurface(pair, false)
  const split = meshSurface(pair)
  // The midpoints of the march's edges whose ends have different owners, where a crossing stands in when the edge
  // doesn't straddle the boundary, in the single precision the mesh is written in
  const midpoints = new Set<string>()
  for (let i = 0; i < unsplit.indices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = unsplit.indices[i + e]
      const b = unsplit.indices[i + ((e + 1) % 3)]
      if (unsplit.owners[a] === unsplit.owners[b]) continue
      const lo = position(unsplit, Math.min(a, b))
      const hi = position(unsplit, Math.max(a, b))
      midpoints.add(lo.map((value, k) => Math.fround(value + 0.5 * (hi[k] - value))).join(','))
    }
  }
  const first = vertexCount(unsplit)
  const added = vertexCount(split) - first
  assert.ok(added > 0)
  assert.equal(added % 2, 0)
  let standIns = 0
  for (let v = first; v < vertexCount(split); v += 2) {
    assert.deepEqual(position(split, v + 1), position(split, v))
    assert.deepEqual(normal(split, v + 1), normal(split, v))
    assert.notEqual(split.owners[v + 1], split.owners[v])
    const a = share(pair, split.owners[v], position(split, v))
    const b = share(pair, split.owners[v + 1], position(split, v))
    if (Math.abs(a - b) <= shareTolerance * ((a + b) / 2)) continue
    assert.ok(midpoints.has(positionKey(split, v)), `crossing ${v} is neither on the boundary nor a midpoint`)
    standIns++
  }
  t.diagnostic(`${standIns} of ${added / 2} crossings are midpoint stand-ins`)
})

void test('two carbons meet on their bisecting plane', () => {
  const unsplit = meshSurface(carbons, false)
  const split = meshSurface(carbons)
  const plane = (carbons.centers[0] + carbons.centers[3]) / 2
  assert.ok(vertexCount(split) > vertexCount(unsplit))
  for (let v = vertexCount(unsplit); v < vertexCount(split); v++) {
    assert.ok(Math.abs(split.positions[v * 3] - plane) <= planeTolerance, `crossing ${v} off the plane`)
  }
})

void test('a ring of heavy atoms with hydrogens is closed, in pieces of one owner, with normals away from their owners', () => {
  const input = ring()
  const mesh = meshSurface(input)
  assertClosed(mesh, (v) => positionKey(mesh, v))
  assertOneOwnerPerTriangle(mesh)
  let away = 0
  for (let v = 0; v < vertexCount(mesh); v++) {
    const owner = mesh.owners[v]
    const [x, y, z] = position(mesh, v)
    const [nx, ny, nz] = normal(mesh, v)
    const dx = x - input.centers[owner * 3]
    const dy = y - input.centers[owner * 3 + 1]
    const dz = z - input.centers[owner * 3 + 2]
    if (nx * dx + ny * dy + nz * dz > 0) away++
  }
  assert.ok(away >= awayShare * vertexCount(mesh), `${away} of ${vertexCount(mesh)} normals point away`)
})

void test('empty input gives the empty mesh', () => {
  const mesh = meshSurface({ centers: new Float32Array(0), radii: new Float32Array(0), spacing: 0.5 })
  assert.equal(mesh.positions.length, 0)
  assert.equal(mesh.normals.length, 0)
  assert.equal(mesh.indices.length, 0)
  assert.equal(mesh.owners.length, 0)
  assert.equal(mesh.spacing, 0)
  assert.equal(mesh.gridPoints, 0)
})

// The grid point's place in scene units, and the field's value and owner there, for a point by its indices
function gridPoint(field: Field, x: number, y: number, z: number) {
  const [nx, ny] = field.size
  const i = x + nx * (y + ny * z)
  return {
    position: [field.origin[0] + x * field.spacing, field.origin[1] + y * field.spacing, field.origin[2] + z * field.spacing],
    density: field.density[i],
    owner: field.owners[i],
  }
}

// Every grid point, with its place, density and owner
function* gridPoints(field: Field) {
  const [nx, ny, nz] = field.size
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) yield gridPoint(field, x, y, z)
}

// The density one atom of radius R adds at a distance d, as the mesher defines it
const atomDensity = (d: number, R: number) => Math.exp(-steepness * ((d * d) / (R * R) - 1))

// The owners' marker for a point no atom reaches: every bit set
const noOwner = 0xffffffff

void test('a lone carbon samples to its density, falling to nothing past its cutoff, every reached point its own', () => {
  const field = sampleField(lone)
  assert.equal(field.spacing, lone.spacing)
  const [nx, ny, nz] = field.size
  assert.equal(field.density.length, nx * ny * nz)
  assert.equal(field.owners.length, nx * ny * nz)
  // The grid's offset: no point is farther from where it's measured than half a diagonal of a cell
  const offset = (Math.sqrt(3) / 2) * field.spacing
  // The reach: where the density falls to a hundredth of the isolevel
  const reach = carbon * Math.sqrt(1 + Math.log(cutoffRatio) / steepness)
  let nearestCentre = { distance: Infinity, density: 0 }
  let reached = 0
  let onSphere = 0
  for (const point of gridPoints(field)) {
    const d = Math.hypot(...point.position)
    if (d < nearestCentre.distance) nearestCentre = { distance: d, density: point.density }
    if (d >= reach) {
      assert.equal(point.density, 0, `the density at ${d} Å, past the cutoff`)
      assert.equal(point.owner, noOwner, `the owner at ${d} Å, past the cutoff`)
      continue
    }
    reached++
    assert.equal(point.owner, 0, `the owner at ${d} Å, within reach`)
    // The density is the atom's, at the point's own distance
    assert.ok(Math.abs(point.density - atomDensity(d, carbon)) <= 1e-6 * atomDensity(d, carbon), `the density at ${d} Å`)
    // The points nearest the sphere hold a density within what the offset explains of the isolevel
    if (Math.abs(d - carbon) <= offset) {
      onSphere++
      const low = atomDensity(carbon + offset, carbon)
      const high = atomDensity(carbon - offset, carbon)
      assert.ok(point.density >= low && point.density <= high, `the density ${point.density} on the sphere`)
    }
  }
  assert.ok(reached > 1000)
  assert.ok(onSphere > 100)
  // The point nearest the centre holds the peak, within what its offset explains
  assert.ok(nearestCentre.distance <= offset)
  assert.ok(nearestCentre.density <= Math.exp(steepness) && nearestCentre.density >= atomDensity(offset, carbon))
  // The grid holds the whole atom, with a border of a spacing beyond its reach
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(field.origin[axis] <= -reach - field.spacing)
    assert.ok(field.origin[axis] + (field.size[axis] - 1) * field.spacing >= reach + field.spacing)
  }
})

void test('between two atoms each point is owned by the one nearer relative to its radius', () => {
  const field = sampleField(pair)
  let shared = 0
  for (const point of gridPoints(field)) {
    if (point.owner === noOwner) {
      assert.equal(point.density, 0)
      continue
    }
    const a = share(pair, 0, point.position)
    const b = share(pair, 1, point.position)
    // A point within reach of both takes the nearer by share; one within reach of one alone takes that one
    const reachA = Math.sqrt(1 + Math.log(cutoffRatio) / steepness)
    const inA = a < reachA
    const inB = b < reachA
    if (inA && inB) shared++
    const expected = inA && inB ? (a <= b ? 0 : 1) : inA ? 0 : 1
    assert.equal(point.owner, expected, `the owner at ${point.position.join(', ')} with shares ${a} and ${b}`)
  }
  assert.ok(shared > 1000)
})

void test('a grid that would exceed the cap is coarsened by the cube root of the excess', () => {
  // A dozen carbons spread over a line, at a spacing that would take almost twice the cap
  const count = 12
  const centers = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) centers[i * 3] = i * 10
  const radii = new Float32Array(count).fill(carbon)
  const fine = { centers, radii, spacing: 0.1 }
  const field = sampleField(fine)
  const points = field.size[0] * field.size[1] * field.size[2]
  assert.ok(points <= maxGridPoints, `${points} points`)
  assert.ok(field.spacing > fine.spacing)
  // The grid the asked-for spacing would have laid: a spacing of border beyond each atom's reach on every side
  const reach = carbon * Math.sqrt(1 + Math.log(cutoffRatio) / steepness)
  const asked = [110, 0, 0].map((extent) => Math.ceil((extent + 2 * reach + 2 * fine.spacing) / fine.spacing) + 1)
  const askedPoints = asked[0] * asked[1] * asked[2]
  assert.ok(askedPoints > maxGridPoints)
  const coarsened = fine.spacing * Math.cbrt(askedPoints / maxGridPoints)
  // The spacing is the asked-for one coarsened by the cube root, and again while the grid's border and rounding leave
  // it over: here twice more, by 1.4% in all
  assert.ok(field.spacing >= coarsened * (1 - 1e-9), `${field.spacing} against ${coarsened}`)
  assert.ok(field.spacing <= coarsened * 1.02, `${field.spacing} against ${coarsened}`)
  // At most the cap, and near it
  assert.ok(points > maxGridPoints * 0.9, `${points} points`)
})

void test('the packed field holds the density as a byte saturated at the isolevel, and the owner as index bytes', () => {
  const field: Field = {
    density: Float32Array.of(0, 0.5, 1, 3, 0.25),
    owners: Uint32Array.of(0, 1, 255, 16777215, noOwner),
    origin: [1, 2, 3],
    size: [5, 1, 1],
    spacing: 0.5,
  }
  const packed = packField(field)
  assert.deepEqual([...packed.density], [0, 128, 255, 255, 64])
  assert.equal(packed.owners.length, 20)
  assert.deepEqual(packed.origin, field.origin)
  assert.deepEqual(packed.size, field.size)
  assert.equal(packed.spacing, field.spacing)
  const bytes = new Uint8ClampedArray(packed.owners)
  for (const i of [0, 1, 2, 3]) {
    assert.equal(readAtomIndex(bytes, i * 4), field.owners[i])
    assert.equal(packed.owners[i * 4 + 3], 255)
  }
  // The red is the low byte, the green the middle and the blue the high
  assert.deepEqual([...packed.owners.subarray(8, 12)], [255, 0, 0, 255])
  assert.deepEqual([...packed.owners.subarray(12, 16)], [255, 255, 255, 255])
  // A point no atom reaches is every byte full, told apart from the last index by its density alone
  assert.deepEqual([...packed.owners.subarray(16, 20)], [255, 255, 255, 255])
  assert.equal(isolevel, 1)
})

void test('a sampled field packs to bytes of its own density and owners', () => {
  const field = sampleField(pair)
  const packed = packField(field)
  assert.equal(packed.density.length, field.density.length)
  assert.equal(packed.owners.length, field.owners.length * 4)
  const bytes = new Uint8ClampedArray(packed.owners)
  for (let i = 0; i < field.density.length; i++) {
    assert.equal(packed.density[i], Math.round(Math.min(field.density[i], isolevel) * 255))
    if (field.owners[i] === noOwner) assert.deepEqual([...packed.owners.subarray(i * 4, i * 4 + 4)], [255, 255, 255, 255])
    else assert.equal(readAtomIndex(bytes, i * 4), field.owners[i])
  }
})

void test('empty input gives the empty field', () => {
  const field = sampleField({ centers: new Float32Array(0), radii: new Float32Array(0), spacing: 0.5 })
  assert.equal(field.density.length, 0)
  assert.equal(field.owners.length, 0)
  assert.deepEqual(field.size, [0, 0, 0])
  assert.equal(field.spacing, 0)
})
