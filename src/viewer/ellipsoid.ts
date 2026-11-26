import { Vector4, type Object3D } from 'three'
import {
  attribute,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  dot,
  float,
  Fn,
  If,
  int,
  ivec2,
  length,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  positionView,
  screenSize,
  select,
  sqrt,
  textureLoad,
  uniform,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { ellipsoidAttributes, surfaceDeviations } from './ellipsoidGeometry.ts'
import { PieceTable, tableSide, texelsPerLayer } from './pieces.ts'

// The one thing the splat styles draw: an ellipsoid, given by its centre and its covariance. An atom is a round one, a
// thermal ellipsoid or a merged blob a stretched one, and each is a Gaussian as much as a solid: the soft style draws
// its density, and the spheres style its surface, two standard deviations out. Each is drawn as one flat rectangle
// that covers it on screen, an instance of a quad, and every pixel of the rectangle crosses its own ray with the
// ellipsoid itself, so that the outline, the depth and the facing are the ellipsoid's own, and nothing is approximated
// by a flat disc. The instances' centres and shapes are in the structure's own coordinates, and its object places them
// in the scene: the vertex stage moves each centre by the object's matrix and turns each shape by its rotation, so
// that a pixel is handed its ellipsoid in scene coordinates, wherever the object is placed. Each instance belongs to a
// piece, whose texel in the piece table says whether it's drawn at the level its mesh draws, and one that isn't is
// collapsed out of sight

// An ellipsoid's surface lies where its own measure of distance from its centre, squared, is this
const surfaceDistanceSquared = surfaceDeviations * surfaceDeviations

// The variance every ellipsoid is widened by, in square pixels at its own depth, so that none is drawn thinner than a
// pixel or so: an atom smaller than a pixel would otherwise blink as it moved across the pixels' centres
const pixelVariance = 0.3

// Where a rectangle is drawn when its ellipsoid's centre is nearer than the near plane, as a multiple of the near
// plane's distance, so that the near plane doesn't clip the rectangle away
const nearMargin = 1.01

// The least length of the shape's gradient to divide by, where a ray passes outside the outline and meets no surface
const leastGradient = 1e-12

// The instances' attributes: the centre, the covariance in two halves, the paint and the piece
const centre = attribute(ellipsoidAttributes.centre, 'vec3')
const shapeA = attribute(ellipsoidAttributes.shapeA, 'vec3')
const shapeB = attribute(ellipsoidAttributes.shapeB, 'vec3')
const paint = attribute(ellipsoidAttributes.paint, 'vec4')
const piece = attribute(ellipsoidAttributes.piece, 'uint')

// The piece table the instances are read against, which the splats swap in for each entry: it starts as an empty one
// with every piece hidden
const pieceTable = textureLoad(new PieceTable(1).texture)

// Draws from a piece table, for every mesh the vertex stage serves
export function readPieceTable(table: PieceTable) {
  pieceTable.value = table.texture
}

// Which channel of its piece's texel each mesh reads, as the one place set to 1: its level's. A mesh given none reads
// the fourth, which no level takes and every piece holds hidden
const levelChannels = new WeakMap<Object3D, Vector4>()
const noLevel = new Vector4(0, 0, 0, 1)

// Has a mesh draw its instances where their pieces are drawn at a level, by its place among the levels
export function drawsLevel(mesh: Object3D, level: number) {
  levelChannels.set(mesh, new Vector4(0, 0, 0, 0).setComponent(level, 1))
}

const levelChannel = uniform(new Vector4(0, 0, 0, 1)).onObjectUpdate(({ object }) =>
  object ? (levelChannels.get(object) ?? noLevel) : noLevel,
)

// Whether the instance's piece is drawn at its mesh's level, from the piece's texel: the table's layers are square,
// and a piece's index runs along a layer's rows and then from layer to layer
function pieceShown() {
  const side = int(tableSide)
  const perLayer = int(texelsPerLayer)
  const index = int(piece).toVar()
  const layer = index.div(perLayer).toVar()
  const within = index.sub(layer.mul(perLayer)).toVar()
  const row = within.div(side).toVar()
  const texel = textureLoad(pieceTable, ivec2(within.sub(row.mul(side)), row)).depth(layer)
  return dot(texel, levelChannel).greaterThanEqual(0)
}

// What a pixel is given of its ellipsoid: the centre, the inverse of the widened covariance, laid out as the covariance
// is, the paint, and how far the widening dims a Gaussian. All four corners of a rectangle carry the same values
const centreOf = varyingProperty('vec3', 'vEllipsoidCentre')
const inverseA = varyingProperty('vec3', 'vEllipsoidInverseA')
const inverseB = varyingProperty('vec3', 'vEllipsoidInverseB')
const paintOf = varyingProperty('vec4', 'vEllipsoidPaint')
const dimmingOf = varyingProperty('float', 'vEllipsoidDimming')

// A symmetric matrix, given as its xx, xy, xz and its yy, yz, zz, times a vector
function times(a: Node<'vec3'>, b: Node<'vec3'>, v: Node<'vec3'>) {
  return vec3(dot(a, v), dot(vec3(a.y, b.x, b.y), v), dot(vec3(a.z, b.y, b.z), v))
}

// A symmetric matrix, given as above, turned by a rotation whose columns are u, v and w: R S Rᵀ, in the same layout.
// Each of its columns is R times S times the matching row of R
function turned(a: Node<'vec3'>, b: Node<'vec3'>, u: Node<'vec3'>, v: Node<'vec3'>, w: Node<'vec3'>) {
  const rotate = (x: Node<'vec3'>) => u.mul(x.x).add(v.mul(x.y)).add(w.mul(x.z))
  const columnX = rotate(times(a, b, vec3(u.x, v.x, w.x))).toVar()
  const columnY = rotate(times(a, b, vec3(u.y, v.y, w.y))).toVar()
  const columnZ = rotate(times(a, b, vec3(u.z, v.z, w.z)))
  return { a: columnX, b: vec3(columnY.y, columnY.z, columnZ.z).toVar() }
}

// A symmetric matrix's cofactors, which are its inverse times its determinant, in the same layout
function cofactorsA(a: Node<'vec3'>, b: Node<'vec3'>) {
  return vec3(b.x.mul(b.z).sub(b.y.mul(b.y)), a.z.mul(b.y).sub(a.y.mul(b.z)), a.y.mul(b.y).sub(a.z.mul(b.x)))
}
function cofactorsB(a: Node<'vec3'>, b: Node<'vec3'>) {
  return vec3(a.x.mul(b.z).sub(a.z.mul(a.z)), a.y.mul(a.z).sub(a.x.mul(b.y)), a.x.mul(b.x).sub(a.y.mul(a.y)))
}

// The vertex stage: the corner of the instance's rectangle, in clip space. The rectangle is the one that holds the
// ellipsoid's box in the view's axes, each side taken at whichever of the box's nearest and farthest depths carries it
// further out, so it covers the ellipsoid from any view, and a little more of the screen than it needs. The camera's
// projection is taken as centred, as a perspective camera's is without a view offset
export const ellipsoidVertex = Fn(() => {
  // The ellipsoid in scene coordinates: its centre placed by the structure's object, and its shape turned by the
  // object's rotation, whose columns are where the object takes its own axes
  const placed = modelWorldMatrix.mul(vec4(centre, 1)).xyz.toVar()
  const { a: placedA, b: placedB } = turned(
    shapeA,
    shapeB,
    modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz,
    modelWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz,
    modelWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz,
  )
  const viewCentre = cameraViewMatrix.mul(vec4(placed, 1)).xyz.toVar()
  const depth = viewCentre.z.negate().toVar()

  // A pixel's width at the centre's depth, from the projection's vertical scale and the height drawn to. The widening
  // is the same along every axis, so it adds to the covariance's diagonal, whichever way the view faces
  const focal = cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y
  const pixel = max(depth, cameraNear).mul(2).div(focal.mul(screenSize.y))
  const widening = pixel.mul(pixel).mul(pixelVariance).toVar()
  const a = placedA.add(vec3(widening, 0, 0)).toVar()
  const b = placedB.add(vec3(widening, 0, widening)).toVar()
  const widenedA = cofactorsA(a, b).toVar()
  const widenedB = cofactorsB(a, b).toVar()
  const determinant = dot(a, widenedA)
  centreOf.assign(placed)
  inverseA.assign(widenedA.div(determinant))
  inverseB.assign(widenedB.div(determinant))
  paintOf.assign(paint)

  // A widened Gaussian is dimmed so that it gives off the light it did: by the ratio of the areas the two cover as
  // seen from the camera. Seen along a direction, a Gaussian's area goes as the root of its cofactors' form on it
  const towards = normalize(placed.sub(cameraPosition)).toVar()
  const narrow = dot(towards, times(cofactorsA(placedA, placedB), cofactorsB(placedA, placedB), towards))
  const wide = dot(towards, times(widenedA, widenedB, towards))
  dimmingOf.assign(sqrt(max(narrow.div(wide), 0)))

  // How far the ellipsoid reaches from its centre along the view's right, up and back, which are the camera's axes in
  // scene coordinates
  const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz
  const up = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz
  const back = cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz
  const reach = sqrt(vec3(dot(right, times(a, b, right)), dot(up, times(a, b, up)), dot(back, times(a, b, back))))
    .mul(surfaceDeviations)
    .toVar()
  const nearest = max(depth.sub(reach.z), cameraNear).toVar()
  const farthest = depth.add(reach.z).toVar()
  const low = viewCentre.xy.sub(reach.xy).toVar()
  const high = viewCentre.xy.add(reach.xy).toVar()
  // Each side as its slope from the view's axis. A side on its own side of the axis is carried furthest out at the
  // nearest depth, and one that has crossed over to the other side at the farthest
  const lowest = vec2(
    low.x.div(select(low.x.lessThan(0), nearest, farthest)),
    low.y.div(select(low.y.lessThan(0), nearest, farthest)),
  )
  const highest = vec2(
    high.x.div(select(high.x.greaterThan(0), nearest, farthest)),
    high.y.div(select(high.y.greaterThan(0), nearest, farthest)),
  )
  // The rectangle is drawn at the centre's depth, which is the depth a Gaussian is tested and weighed at
  const drawn = max(depth, cameraNear.mul(nearMargin)).toVar()
  const across = mix(lowest, highest, positionGeometry.xy.mul(0.5).add(0.5)).mul(drawn)
  const clip = cameraProjectionMatrix.mul(vec4(across, drawn.negate(), 1)).toVar()
  // Wholly nearer than the near plane, or of a piece not drawn at its mesh's level, it's drawn nowhere
  If(farthest.lessThan(cameraNear).or(pieceShown().not()), () => {
    clip.assign(vec4(2, 2, 2, 1))
  })
  return clip
})()

// The direction of the pixel's ray from the camera, in view space. With a vertex stage of its own, a material's view
// position is rebuilt from the pixel's clip position, so it lies on the pixel's ray
export const rayDirection = normalize(positionView)

// The paint of the pixel's ellipsoid: its atom's colour, and the alpha that Fade, the models' share and an alternate's
// occupancy leave it
export const ellipsoidPaint = paintOf
// What the widening leaves of a Gaussian's alpha
export const ellipsoidDimming = dimmingOf
// The view depth of the pixel's ellipsoid's centre
export const ellipsoidDepth = cameraViewMatrix.mul(vec4(centreOf, 1)).z.negate()

// How the pixel's ray passes its ellipsoid, each as a variable of the shader being built: the ray's direction in
// scene coordinates, how steeply the shape's measure climbs along it, how far along it passes the centre nearest, by
// that measure, where it is then from the centre, and how far out that is, from 0 through the centre to 1 at the
// outline and more outside it. The ray runs from the camera, and everything is measured from the nearest point, which
// keeps the arithmetic's precision at the structure's distance
function passing() {
  const direction = cameraWorldMatrix.mul(vec4(rayDirection, 0)).xyz.toVar()
  const fromCentre = cameraPosition.sub(centreOf).toVar()
  const shapedDirection = times(inverseA, inverseB, direction).toVar()
  const steepness = dot(direction, shapedDirection).toVar()
  const nearest = dot(fromCentre, shapedDirection).div(steepness).negate().toVar()
  const miss = fromCentre.add(direction.mul(nearest)).toVar()
  const out = dot(miss, times(inverseA, inverseB, miss)).div(surfaceDistanceSquared).toVar()
  return { direction, steepness, nearest, miss, out }
}

// How far out the pixel's ray passes its ellipsoid: 0 through the centre, 1 at the outline, and more outside it. A
// Gaussian's density along the ray falls off with this alone
export const ellipsoidReach = Fn(() => passing().out)()

// Where the pixel's ray passes its ellipsoid's surface: how far along the ray it enters, how far along it leaves, how
// far out it passes, as above, and how directly the surface it meets faces the viewer, from 1 to 0 at the outline.
// Outside the outline the ray enters and leaves where it passes nearest
export type Passage = Node<'vec4'>

// The passage where the ray meets the near side, which a front layer draws, or the far side, which the back shell does
export function ellipsoidPassage(side: 'near' | 'far'): Passage {
  return Fn(() => {
    const { direction, steepness, nearest, miss, out } = passing()
    const half = sqrt(max(float(1).sub(out), 0).mul(surfaceDistanceSquared).div(steepness)).toVar()
    // The surface's normal runs along the shape's gradient where the ray meets it, and the ray's own share of that
    // gradient is the half-chord times the steepness, on either side
    const met = side === 'near' ? miss.sub(direction.mul(half)) : miss.add(direction.mul(half))
    const gradient = length(times(inverseA, inverseB, met))
    const facing = half.mul(steepness).div(max(gradient, leastGradient))
    return vec4(nearest.sub(half), nearest.add(half), out, facing)
  })()
}
