import { Data3DTexture, LinearFilter, RedFormat, RGBAFormat, UnsignedByteType, Vector3 } from 'three'
import {
  abs,
  Break,
  cameraNear,
  cameraPosition,
  clamp,
  exp,
  float,
  Fn,
  hash,
  If,
  ivec3,
  length,
  Loop,
  max,
  min,
  positionView,
  positionWorld,
  round,
  screenCoordinate,
  smoothstep,
  step,
  texture3D,
  texture3DLoad,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import type { NodeMaterial } from 'three/webgpu'
import type { PackedField } from '../surface/gaussianSurface.ts'
import { atomIndexOf, atomTexelAt, createAtomTable, type AtomTable } from './atomTable.ts'
import { cueFar, cueNear, depthCue, optionUniforms } from './shading.ts'

// The field: the atoms' density, sampled on a grid by the surface's worker and packed into two 3D textures, drawn as
// a cloud by a ray march through the box the grid fills. Each pixel of the box's back face casts a ray from the camera
// and steps along it, and at each step the cloud takes a share of the light by the density there, in the colour of
// the atom that owns the point, read from the atom table. The pixel shows what the ray gathered

// How much of the light a unit of density takes per ångström at Opacity 1, chosen by eye on the crambin and antibody
// examples: a protein's core reads near opaque at the default Opacity, and its edge as haze
const extinction = 0.2
// The step along the ray, as a share of the grid's spacing: half a point, so that no feature of the grid is skipped
const stepShare = 0.5
// The most steps a ray takes, half a point each, so 512 points: more than a grid's diagonal unless the grid is long
// and thin, when a ray along it stops short of its far end
const maxSteps = 1024
// The ray stops once this little of the light would still get through
const minTransmittance = 0.01
// A direction's components are kept at least this far from zero, so that a face parallel to the ray is never a
// division by zero
const leastDirection = 1e-6
// The hash of a pixel's place takes its row as this many pixels, more than a 4K screen is wide
const screenHashRow = 4096

const { opacity } = optionUniforms

export interface FieldMarch {
  // The box's colour: the cloud along the ray through each pixel, as the premultiplied colour it gathered, with how
  // much of what's behind the box it covers as its alpha
  colorNode: NonNullable<NodeMaterial['colorNode']>
  // Draws a field whose points are owned by the atoms of a table: its textures replace the ones the march reads, which
  // are disposed of, and the table's texture is read in place of the one before. The table stays its owner's
  show(field: PackedField, table: AtomTable): void
  // Disposes of the textures the march reads
  dispose(): void
}

// The march, on textures a field swaps in. Until one arrives it reads a point of nothing and an empty table
export function fieldMarch(): FieldMarch {
  let density = densityTexture(new Uint8Array(1), [1, 1, 1])
  let owners = ownerTexture(new Uint8Array(4), [1, 1, 1])
  const empty = createAtomTable(0)
  const densityNode = texture3D(density)
  const ownerNode = texture3DLoad(owners)
  const tableNode = textureLoad(empty.texture)
  const tableWidth = uniform(empty.texture.image.width, 'int')
  // How many atoms the table holds: a point no atom reaches carries an index past them all
  const atomCount = uniform(0, 'int')
  // The grid's lowest corner in scene units, its points per axis and its spacing
  const origin = uniform(new Vector3())
  const points = uniform(new Vector3(1, 1, 1))
  const spacing = uniform(1)

  const colorNode = Fn(() => {
    // The ray from the camera through this fragment of the box's back face, where it ends, in scene units
    const toFragment = positionWorld.sub(cameraPosition).toVar()
    const end = length(toFragment).toVar()
    const direction = toFragment.div(end).toVar()
    // Where the ray enters the box: along each axis the nearer of its two faces' crossings, and the latest of those
    const nudged = step(0, direction).mul(2).sub(1).mul(max(abs(direction), leastDirection))
    const extent = points.sub(1).mul(spacing)
    const toLow = origin.sub(cameraPosition).div(nudged)
    const toHigh = origin.add(extent).sub(cameraPosition).div(nudged)
    const nearer = min(toLow, toHigh)
    const entry = max(max(nearer.x, nearer.y), nearer.z)
    // Where it crosses the near plane, so that Clip cuts the cloud as it cuts the surface: the fragment's view depth
    // is the ray's at its end, and depth grows evenly along it
    const endDepth = positionView.z.negate().toVar()
    const nearCrossing = end.mul(cameraNear).div(endDepth)
    // The march starts at the later of the two, its first step offset by a share of a step from a hash of the pixel's
    // place, which trades the bands that equal steps draw for fine noise
    const stepLength = spacing.mul(stepShare).toVar()
    const offset = hash(screenCoordinate.y.mul(screenHashRow).add(screenCoordinate.x))
    const t = max(entry, nearCrossing).add(stepLength.mul(offset)).toVar()
    const gathered = vec3(0).toVar()
    const transmittance = float(1).toVar()
    // The depth cue's edges, taken once rather than at every step
    const cueStart = cueNear.toVar()
    const cueEnd = cueFar.toVar()

    Loop(maxSteps, () => {
      If(t.greaterThan(end).or(transmittance.lessThan(minTransmittance)), () => {
        Break()
      })
      // The point in grid coordinates, a point apart, and the density there, read between the points. The texture
      // has one level, which is named so that the read needs no screen derivatives, which WGSL allows only where
      // every pixel takes the same path, and a ray that has stopped doesn't
      const g = cameraPosition.add(direction.mul(t)).sub(origin).div(spacing).toVar()
      const d = densityNode.sample(g.add(0.5).div(points)).level(float(0)).r.toVar()
      If(d.greaterThan(0), () => {
        // The owner at the nearest point, whose index lies past the atoms where no atom reaches it
        const index = atomIndexOf(ownerNode.load(ivec3(clamp(round(g), vec3(0), points.sub(1)))).rgb).toVar()
        If(index.lessThan(atomCount), () => {
          const texel = atomTexelAt(tableNode, tableWidth, index)
          // The depth cue's share at the point's view depth, as the splats take it at their centres
          const depth = endDepth.mul(t).div(end)
          const cue = float(1).sub(depthCue.mul(smoothstep(cueStart, cueEnd, depth)))
          // What the step covers of the light still coming through, which the cloud gathers in the owner's colour
          const coverage = exp(d.mul(extinction).mul(opacity).mul(stepLength).negate()).oneMinus()
          gathered.addAssign(texel.rgb.mul(cue).mul(coverage.mul(transmittance)))
          transmittance.mulAssign(coverage.oneMinus())
        })
      })
      t.addAssign(stepLength)
    })
    return vec4(gathered, transmittance.oneMinus())
  })()

  return {
    colorNode,
    show(field, table) {
      const nextDensity = densityTexture(field.density, field.size)
      const nextOwners = ownerTexture(field.owners, field.size)
      density.dispose()
      owners.dispose()
      density = nextDensity
      owners = nextOwners
      densityNode.value = density
      ownerNode.value = owners
      tableNode.value = table.texture
      tableWidth.value = table.texture.image.width
      atomCount.value = table.count
      origin.value.fromArray(field.origin)
      points.value.fromArray(field.size)
      spacing.value = field.spacing
    },
    dispose() {
      density.dispose()
      owners.dispose()
      empty.texture.dispose()
    },
  }
}

// A 3D texture of one byte per point, the density, read between the points
function densityTexture(bytes: Uint8Array, [nx, ny, nz]: readonly [number, number, number]) {
  const texture = new Data3DTexture(bytes, nx, ny, nz)
  texture.format = RedFormat
  texture.type = UnsignedByteType
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}

// A 3D texture of four bytes per point, the owner's index bytes, read point by point
function ownerTexture(bytes: Uint8Array, [nx, ny, nz]: readonly [number, number, number]) {
  const texture = new Data3DTexture(bytes, nx, ny, nz)
  texture.format = RGBAFormat
  texture.type = UnsignedByteType
  texture.needsUpdate = true
  return texture
}
