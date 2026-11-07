import { DataTexture, FloatType, RGBAFormat, UnsignedByteType } from 'three'
import {
  Break,
  cameraViewMatrix,
  cameraWorldMatrix,
  float,
  Fn,
  If,
  ivec2,
  length,
  Loop,
  textureLoad,
  uniform,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { sphereNeighbours } from '../pdb/overlaps.ts'
import { atomIndex, atomIndexOf, atomTexelAt, tableSize, writeAtomIndex } from './atomTable.ts'
import { rayDirection, type SphereCrossing } from './shading.ts'

// The sphere table and the neighbour table: each shown atom's sphere, and the spheres it overlaps, in two textures the
// translucent spheres' shader reads by the atom's index, as it reads the atom table, so that each sphere's surface can
// be cut away where it lies inside a neighbour. Below full Opacity the spheres are sorted and blended, and a pair whose
// order has changed since the last sort is drawn in the stale order until the next; the only surfaces that can show it
// are those inside the overlaps, so with them cut away nothing snaps as the view turns, and the spheres show the
// surface of their union with its creases

// The most neighbours an atom's sphere keeps, its deepest overlaps first. At Size 2 a sphere in a protein's core
// reaches many dozens of others, so a higher cap holds every contact there, for a longer loop per pixel and a larger
// table; a neighbour the cap drops leaves drawn whatever of its overlap no deeper neighbour covers, where the two
// spheres can snap between sorts as they did before the cut
export const maxNeighbours = 32

// Floats per sphere texel: its centre and its radius
const floatsPerSphere = 4
const bytesPerTexel = 4

export interface SphereTables {
  // One float texel per atom: its sphere's centre in scene coordinates and its drawn radius, laid out as the atom
  // table is
  spheres: DataTexture
  // The neighbour table: maxNeighbours texels per atom, each a neighbour's index in the atom table's three bytes with
  // a full fourth, and an empty fourth past its last neighbour. Each atom's run lies within one row, which holds the
  // runs of atomsPerRow atoms, so that the shader steps along it without a division per neighbour
  neighbours: DataTexture
  atomsPerRow: number
  // How many atoms overlap more spheres than the cap holds
  overCap: number
}

// The neighbour table's shape for a count of atoms: as many runs per row as makes it nearly square, so that neither
// side outgrows the texture size limit before the other. An entry that fills the limit squared has no table in any
// shape, and at WebGPU's default limit that's beyond two million atoms
export function neighbourTableSize(count: number) {
  const atomsPerRow = Math.max(1, Math.ceil(Math.sqrt(count / maxNeighbours)))
  return {
    atomsPerRow,
    width: atomsPerRow * maxNeighbours,
    height: Math.max(1, Math.ceil(count / atomsPerRow)),
  }
}

// The tables for spheres at centres, x, y, z triples in scene coordinates, and radii, with the neighbours found
export function createSphereTables(centers: Float32Array, radii: Float32Array): SphereTables {
  const count = radii.length
  const { width, height } = tableSize(count)
  const floats = new Float32Array(width * height * floatsPerSphere)
  for (let i = 0; i < count; i++) {
    floats[i * floatsPerSphere] = centers[i * 3]
    floats[i * floatsPerSphere + 1] = centers[i * 3 + 1]
    floats[i * floatsPerSphere + 2] = centers[i * 3 + 2]
    floats[i * floatsPerSphere + 3] = radii[i]
  }
  const spheres = new DataTexture(floats, width, height, RGBAFormat, FloatType)
  spheres.needsUpdate = true

  const { neighbours: found, overCap } = sphereNeighbours(centers, radii, maxNeighbours)
  const layout = neighbourTableSize(count)
  const bytes = new Uint8ClampedArray(layout.width * layout.height * bytesPerTexel)
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / layout.atomsPerRow)
    const column = (i - row * layout.atomsPerRow) * maxNeighbours
    for (let k = 0; k < maxNeighbours; k++) {
      const neighbour = found[i * maxNeighbours + k]
      if (neighbour >= count) break
      writeAtomIndex(bytes, (row * layout.width + column + k) * bytesPerTexel, neighbour)
    }
  }
  const neighbours = new DataTexture(bytes, layout.width, layout.height, RGBAFormat, UnsignedByteType)
  neighbours.needsUpdate = true
  return { spheres, neighbours, atomsPerRow: layout.atomsPerRow, overCap }
}

export function disposeSphereTables({ spheres, neighbours }: SphereTables) {
  spheres.dispose()
  neighbours.dispose()
}

// Whether the cut leaves the splat's sphere's surface under the pixel: 1 where the pixel's point on the sphere lies
// outside every neighbour and 0 where it lies inside one. The point is where the pixel's ray crosses the sphere the
// table holds, its entry or its exit as the crossing given works it out, taken to scene coordinates. The cut is hard:
// where a ray passes through the overlap of two spheres, its entry into the nearer lies outside the other and its entry
// into the farther inside the nearer, so each pixel of the union's surface comes from one sphere alone, and a stale
// sort order draws the same frame as a fresh one. The exits mirror the entries: the exit from the farther lies outside
// the nearer and the exit from the nearer inside the farther, so the exits left outside every neighbour are the
// union's back surface, each pixel of it from one sphere alone. Drawn in a layer of its own, before the front, the back
// sits under the front by the draw's order rather than the sort's. A fade across the neighbour's surface would smooth
// the crease, but there the two spheres' halves composite in sort order, and that order's flip shows. No derivative is
// taken here, so nothing new sits ahead of the colour node's discard
export function overlapCut({ spheres, neighbours, atomsPerRow }: SphereTables, crossing: SphereCrossing): Node<'float'> {
  const sphereNode = textureLoad(spheres)
  const sphereWidth = uniform(spheres.image.width, 'int')
  const neighbourNode = textureLoad(neighbours)
  const perRow = uniform(atomsPerRow, 'int')
  return Fn(() => {
    const index = atomIndex.toVar()
    const own = atomTexelAt(sphereNode, sphereWidth, index).toVar()
    const viewPoint = rayDirection.mul(crossing(cameraViewMatrix.mul(vec4(own.xyz, 1)).xyz, own.w))
    const point = cameraWorldMatrix.mul(vec4(viewPoint, 1)).xyz.toVar()
    const row = index.div(perRow).toVar()
    const column = index.sub(row.mul(perRow)).mul(maxNeighbours).toVar()
    const left = float(1).toVar()
    Loop(maxNeighbours, ({ i }) => {
      const slot = neighbourNode.load(ivec2(column.add(i), row))
      If(slot.a.lessThan(0.5), () => {
        Break()
      })
      const other = atomTexelAt(sphereNode, sphereWidth, atomIndexOf(slot.rgb))
      // A point inside a neighbour is cut whatever the rest hold
      If(length(point.sub(other.xyz)).lessThan(other.w), () => {
        left.assign(0)
        Break()
      })
    })
    return left
  })()
}
