import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraViewMatrix,
  clamp,
  context,
  Discard,
  dot,
  exp,
  float,
  Fn,
  fwidth,
  If,
  max,
  mix,
  normalize,
  normalView,
  positionView,
  pow,
  renderGroup,
  select,
  smoothstep,
  sqrt,
  uniform,
  vec4,
  viewZToPerspectiveDepth,
} from 'three/tsl'
import type { Node, NodeMaterial } from 'three/webgpu'
import { defaultOptions, type ViewOptions } from '../options.ts'
import {
  ellipsoidDepth,
  ellipsoidDimming,
  ellipsoidPaint,
  ellipsoidPassage,
  ellipsoidReach,
  ellipsoidShare,
  rayDirection,
  type Passage,
} from './ellipsoid.ts'

// How everything is shaded: the soft style's density, the lit surface of the spheres style's ellipsoids, in its
// layers, and of the surface style's mesh, and the depth cue and Clip's cut, which every style shares. An ellipsoid's
// shading reads the pixel's ellipsoid: its paint, whose rgb is the atom's colour and whose alpha carries Fade, the
// models' share and an alternate's occupancy, and where the pixel's ray passes it

// A material's colour node
type ColorNode = NonNullable<NodeMaterial['colorNode']>

// A uniform three refreshes on every render for every material. One in an object's own group refreshes only when
// that object's material or transform changes, and would miss a slider's new value
const sharedUniform = (value: number) => uniform(value).setGroup(renderGroup)

// The panel's shading options, by their names in the view options, which the scene copies in as they change,
// so a slider never rebuilds what's drawn
export const optionUniforms = {
  opacity: sharedUniform(defaultOptions.opacity),
  hardness: sharedUniform(defaultOptions.hardness),
  shading: sharedUniform(defaultOptions.shading),
  highlight: sharedUniform(defaultOptions.highlight),
  shininess: sharedUniform(defaultOptions.shininess),
  outline: sharedUniform(defaultOptions.outline),
  depthCue: sharedUniform(defaultOptions.depthCue),
} satisfies Partial<Record<keyof ViewOptions, unknown>>
const { opacity, hardness, shading, highlight, shininess, outline } = optionUniforms
export const { depthCue } = optionUniforms
// The loaded entry's radius around its centre, in ångströms
export const structureRadius = sharedUniform(0)

// How far Hardness 1 sharpens the soft falloff: its exponent runs from 1, a Gaussian, to this
const hardestExponent = 16
// The width of the ink rim's inner fade, as a fraction of a sphere's radius
const inkFade = 0.02
// smoothstep is undefined when its edges meet, so the depth cue spans at least this, in ångströms, before an entry loads
const minimumSpan = 0.001

// The structure sits at the origin, so its centre's view depth follows the camera as it orbits, zooms or pans
const centreDepth = cameraViewMatrix.mul(vec4(0, 0, 0, 1)).z.negate()
const span = max(structureRadius, minimumSpan)
// The view depths of the structure's nearest and farthest points, which the depth cue darkens between
export const cueNear = centreDepth.sub(span)
export const cueFar = centreDepth.add(span)

// What the depth cue leaves of a colour at a view depth, from all of it at the structure's nearest point to 1 − Depth
// cue at its farthest
export function depthShade(depth: Node<'float'>) {
  return float(1).sub(depthCue.mul(smoothstep(cueNear, cueFar, depth)))
}

// The view depth of Clip's cut, which the scene copies in, or 0 while nothing is cut. Every style takes the cut pixel
// by pixel, in its own shader, and the camera's near plane stays in front of everything drawn
export const clipDepth = sharedUniform(0)
// The view depth nothing is drawn nearer than: the cut, or the camera's near plane where that's farther
export const cutDepth = max(clipDepth, cameraNear)
// How far along the pixel's ray that is
const cutAlong = cutDepth.div(rayDirection.z.negate())
// Whether a mesh's pixel lies beyond the cut, which its material takes as its mask, so that the mesh opens where
// it's cut
export const cutMask = positionView.z.negate().greaterThanEqual(clipDepth)

// A mesh drawn more than once, as depth alone and then as colour, must land on the same depth each time, or the colour
// fails its test against its own depth in specks that change with every move of the view. A material given this
// context has its vertices placed alike by every shader, which the compiler is otherwise free not to do
export const samePlacement = context({ invariant: true })
// How far either side of the cut a Gaussian fades across, in ångströms, about an atom's radius: it has no surface to
// cut along, so it fades out as its centre comes through the cut instead
const cutBand = 1.5
// What the cut leaves of a Gaussian: all of it behind the band, and none in front
const cutFade = smoothstep(clipDepth.sub(cutBand), clipDepth.add(cutBand), ellipsoidDepth)

// The least width of a pixel to divide by, as a share of an ellipsoid's radius
const leastPixel = 1e-6

// How much of the pixel an ellipsoid's edge covers, by how far out the pixel's ray passes: all of it a pixel inside
// the outline, and none at the outline, so that the edge is a pixel's fade at any size. It reads how fast its input
// changes across the screen, which a shader may ask only before it discards anything
function coverage(out: Node<'float'>) {
  const radius = sqrt(out).toVar()
  return clamp(float(1).sub(radius).div(max(fwidth(radius), leastPixel)), 0, 1)
}

// The soft style: a Gaussian's density along the pixel's ray, which Hardness sharpens into a flat disc. It's dimmed
// by what its widening took, and by its share as it grows out of its parent, and shaded by the depth cue at its
// centre
export const softColor: ColorNode = Fn(() => {
  // From 0 through the centre to 1 at the edge, two standard deviations out
  const out = ellipsoidReach.toVar()
  const edge = coverage(out).toVar()
  If(out.greaterThan(1), () => {
    Discard()
  })
  const falloff = exp(pow(out, pow(hardestExponent, hardness)).mul(-2))
  // A hard disc's rim is the edge's fade, and a Gaussian has faded out before it
  const rim = mix(1, edge, hardness)
  const alpha = falloff.mul(ellipsoidPaint.a).mul(ellipsoidDimming).mul(opacity).mul(rim).mul(cutFade).mul(ellipsoidShare)
  return vec4(ellipsoidPaint.rgb.mul(depthShade(ellipsoidDepth)), alpha)
})()

// A surface's colour under the pixel, from its atom's colour and how directly it faces the viewer, from 1 to 0 where
// it turns edge on: shaded by its facing, with its highlight and its ink rim. The light comes from the viewer, so the
// side in view is always lit, and every surface, an ellipsoid's or the mesh's, is lit the same
function lit(colour: Node<'vec3'>, facing: Node<'float'>) {
  const shade = facing.mul(shading).add(shading.oneMinus())
  const glint = pow(facing, shininess).mul(highlight)
  const rgb = colour.mul(shade).add(glint).toVar()
  // Outline inks the part of a surface that turns furthest from the viewer black, and at 0 leaves the colour
  // untouched. On a sphere that's the outermost part of its radius, which is the sine of the angle its facing is the
  // cosine of
  If(outline.greaterThan(0), () => {
    const inner = outline.oneMinus()
    const turned = sqrt(max(facing.mul(facing).oneMinus(), 0))
    rgb.mulAssign(smoothstep(inner.sub(inkFade), inner, turned).oneMinus())
  })
  return rgb
}

// The surface style's colour: each vertex's colour, lit by how directly the mesh faces the pixel's ray, on either
// side, with the depth cue at the pixel's own depth
export const meshColor: ColorNode = Fn(() => {
  const facing = abs(dot(normalize(normalView), normalize(positionView)))
  const rgb = lit(attribute('color', 'vec3'), facing)
  return vec4(rgb.mul(depthShade(positionView.z.negate())), 1)
})()

// The layers the spheres style draws its ellipsoids in, none of which is sorted, so that nothing flips as the view
// turns. At full Opacity each pixel shows the nearest solid surface, under the nearest see-through one in front of
// it. Below it nothing is solid, and each pixel shows the nearest see-through surface, over the back shell, the
// farthest one, where that's on:
// - solid: the atoms at full alpha, which write their surface's depth and hide what's behind them
// - ghost: the atoms below full alpha, by Opacity, Fade or an alternate's occupancy, of which only the nearest
//   surface under each pixel is drawn, laid over what's behind it, which it hides by its cover, below. Its depth goes
//   first, in ghostDepth, and its colour then passes only where it's that nearest surface
// - back: the far side of the see-through atoms, where the pixel's ray leaves the last of them, under the ghost layer.
//   Its depth goes first too, in backDepth. It's never drawn with the solid layer, which would hide it wherever a
//   solid lay under the pixel, in front of it or behind
export type Layer = 'solid' | 'ghost' | 'ghostDepth' | 'back' | 'backDepth'

// The alpha, of the atom's own times Opacity, from which an atom is solid, and the alpha below which it isn't drawn
// at all, which is half a step of the paint's byte: Fade at 0 hides the atoms out of focus
const solidAlpha = 0.999
const leastAlpha = 0.002
// The exponent a display encodes light by, which is near enough how the eye weighs it: a tenth of an atom's light
// looks a third as bright as all of it
const displayGamma = 2.2
// How bright a cut ellipsoid's flat face is, of its atom's colour
const capShade = 0.6
// How much farther a depth layer writes its depth than its colour layer then tests with, so that the colour passes
// where it's the surface the depth kept, whatever the two shaders' arithmetic rounds to
const layerGap = 2e-6
// How far behind the cut a cut face sinks, in ångströms: nothing where the cut passes through its ellipsoid's centre,
// and this at the ellipsoid's surface. Every ellipsoid the cut crosses would otherwise put its face at the cut's own
// depth, and which face showed where they overlap would be left to rounding, and change from frame to frame. Sunk by
// how far out of its ellipsoid each point lies, a point of the cut shows the ellipsoid it lies deepest inside
const capDish = 0.1
// The least half-chord to divide by, in ångströms, where a ray passes outside the outline
const leastChord = 1e-6

// How much of what's behind it a see-through surface hides, from the share of its own light that Fade or an
// alternate's occupancy leaves it: as much as it looks to be there. Hiding only that share, a faint atom shows plainly
// against the dark and yet leaves a bright solid behind it all but untouched, so that the solid reads as lying in
// front of it. So it hides what it would were the two blended as the display encodes them, as the eye weighs them:
// nothing at 0, everything at 1, and more than its own share between, six tenths at a tenth. A power of a number
// below 0 is undefined, so the share's own power is kept from rounding past 1
function coverOf(share: Node<'float'>) {
  return pow(max(pow(share, 1 / displayGamma).oneMinus(), 0), displayGamma).oneMinus()
}

// A layer's colour node: the surface's shading where the atom belongs to the layer, and nothing elsewhere. Clip cuts
// each ellipsoid where it crosses the cut: what's in front goes, and a front layer shows the solid's flat face there,
// in its atom's colour, so that the cut moves across each atom as the view turns
function layerColor(layer: Layer, passage: Passage, front: boolean): ColorNode {
  const depthOnly = layer === 'ghostDepth' || layer === 'backDepth'
  return Fn(() => {
    const through = passage.toVar()
    const edge = coverage(through.z).toVar()
    If(through.z.greaterThan(1), () => {
      Discard()
    })
    const alpha = ellipsoidPaint.a.mul(opacity).toVar()
    if (layer === 'solid') {
      If(alpha.lessThan(solidAlpha), () => {
        Discard()
      })
    } else {
      If(alpha.greaterThanEqual(solidAlpha).or(alpha.lessThan(leastAlpha)), () => {
        Discard()
      })
    }
    // Wholly in front of the cut under this pixel
    If(through.y.lessThan(cutAlong), () => {
      Discard()
    })
    // A depth layer writes no colour
    if (depthOnly) return vec4(0)
    const rgb = lit(ellipsoidPaint.rgb, through.w).toVar()
    if (front) {
      If(through.x.lessThan(cutAlong), () => {
        rgb.assign(ellipsoidPaint.rgb.mul(capShade))
      })
    }
    // The depth cue is taken at the surface the pixel shows
    const along = front ? max(through.x, cutAlong) : through.y
    const shaded = rgb.mul(depthShade(along.mul(rayDirection.z.negate())))
    // A solid hides what's behind it, so its alpha is its edge's fade alone, which sets how much of each pixel it
    // covers
    if (layer === 'solid') return vec4(shaded, edge)
    // A see-through surface adds its alpha's share of its colour, and hides its cover of what's behind it: the
    // blend weighs its colour by the alpha it's given, so the colour is dimmed by as much as the cover exceeds its
    // share. Opacity thins the light and the cover alike, as glass that shows its far side through its near one
    const cover = coverOf(ellipsoidPaint.a).toVar()
    return vec4(shaded.mul(ellipsoidPaint.a.div(cover)), cover.mul(opacity).mul(edge))
  })()
}

// How far along the pixel's ray a layer's surface lies, for its depth: where the ray leaves the ellipsoid for a back
// layer, and for a front layer where it enters, or its cut face where the cut has taken that. How far out of the
// ellipsoid a point of the ray lies grows as the square of its distance from the middle of the chord, from how far
// out the ray passes at the middle to 1 at either end, which sinks the cut face as above. A child still growing out of
// its parent, not the one carrying it, sinks its cut face further, by what its share still lacks, a whole dish's depth
// as it starts: inside its parent the parent's face sinks less than that, so the parent's face shows wherever the cut
// crosses both, and the child's comes through only as it grows. Every front layer's depth is taken here, the ambient
// occlusion's pass among them, so that every pass places the cut face alike
function surfaceAlong(passage: Passage, front: boolean) {
  if (!front) return passage.y
  const half = max(passage.y.sub(passage.x).mul(0.5), leastChord)
  const fromMiddle = cutAlong.sub(passage.x.add(passage.y).mul(0.5)).div(half)
  const outAtCut = passage.z.add(passage.z.oneMinus().mul(fromMiddle.mul(fromMiddle)))
  const sunk = outAtCut.add(ellipsoidShare.oneMinus())
  return select(passage.x.lessThan(cutAlong), cutAlong.add(sunk.mul(capDish)), passage.x)
}

// A layer's depth node: the depth of the surface under each pixel, so that solids that meet cut into one another
// along the curve where they cross. A front layer's is where the pixel's ray enters the ellipsoid, or the cut where
// that's farther, and a back layer's is where the ray leaves it.
// While the back shell is drawn, the depth buffer is shared in halves: the back layers write the far half, turned
// round, so that the usual test, which keeps the nearest, keeps the farthest leaving point instead, and every other
// layer writes the near half, so that it passes over whatever the back layers left. A solid would write the near
// half too, and hide the back shell behind it and in front of it alike, which is why the two are never drawn together
function layerDepth(layer: Layer, passage: Passage, front: boolean, halved: boolean): Node<'float'> {
  const depth = viewZToPerspectiveDepth(surfaceAlong(passage, front).mul(rayDirection.z), cameraNear, cameraFar)
  const gap = layer === 'ghostDepth' || layer === 'backDepth' ? layerGap : 0
  if (!front) return depth.mul(0.5).oneMinus().add(gap)
  return (halved ? depth.mul(0.5) : depth).add(gap)
}

// A layer's colour and depth nodes, on one passage of the pixel's ray: through the near side for a front layer, and
// the far side for the back shell's. The depth buffer is halved while the back shell is drawn
export function layerNodes(layer: Layer, halved: boolean) {
  const front = layer === 'solid' || layer === 'ghost' || layer === 'ghostDepth'
  const passage = ellipsoidPassage(front ? 'near' : 'far')
  return { colorNode: layerColor(layer, passage, front), depthNode: layerDepth(layer, passage, front, halved) }
}
