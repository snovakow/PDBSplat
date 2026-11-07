import {
  abs,
  cameraFar,
  cameraNear,
  cameraViewMatrix,
  dFdx,
  dFdy,
  Discard,
  dot,
  exp,
  float,
  Fn,
  If,
  length,
  max,
  mix,
  normalize,
  positionView,
  pow,
  renderGroup,
  smoothstep,
  sqrt,
  uniform,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  viewZToPerspectiveDepth,
} from 'three/tsl'
import type { Node, NodeMaterial } from 'three/webgpu'
import { defaultOptions, type ViewOptions } from '../options.ts'

// The splat styles' colour nodes, which replace GaussianSplat's own, and the depth cue every style shares.
// Each is built on the read of its atom's texel from the atom table: the texel's rgb is the atom's colour, and its
// alpha carries Fade, the models' share and an alternate's occupancy. They read the splat's own varyings by name: its
// position across the splat, in standard deviations, and its colour, whose bytes carry the atom's index and whose
// alpha is then three's antialiasing compensation alone.
// three cuts splats off at two standard deviations, so each style's edge is where the soft splat's is
const splatUv = varyingProperty('vec2', 'vSplatUv')
const splatColor = varyingProperty('vec4', 'vSplatColor')

// A splat style's colour node, built on the read of its atom's texel
export type SplatShading = (texel: Node<'vec4'>) => NonNullable<NodeMaterial['colorNode']>

// A uniform three refreshes on every render for every material. One in an object's own group refreshes only when
// that object's material or transform changes, so the surface's plain material would miss a new value through fog
const sharedUniform = (value: number) => uniform(value).setGroup(renderGroup)

// The panel's shading options, by their names in the view options, which the scene copies in as they change,
// so a slider never rebuilds the splats
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
// The width of the ink rim's inner fade, as a fraction of the sphere's radius
const inkFade = 0.02
// smoothstep is undefined when its edges meet, so the depth cue spans at least this, in ångströms, before an entry loads
const minimumSpan = 0.001

// The structure sits at the origin, so its centre's view depth follows the camera as it orbits, zooms or pans
const centreDepth = cameraViewMatrix.mul(vec4(0, 0, 0, 1)).z.negate()
const span = max(structureRadius, minimumSpan)
// The view depths of the structure's nearest and farthest points, which the depth cue darkens between
export const cueNear = centreDepth.sub(span)
export const cueFar = centreDepth.add(span)

// What the depth cue leaves of a splat's colour, from 1 at the structure's nearest point to 1 − Depth cue at its farthest.
// Every pixel of a splat has its centre's view depth, as three rebuilds the fragment's position from a clip position
// whose depth all four corners share
const depthShade = float(1).sub(depthCue.mul(smoothstep(cueNear, cueFar, positionView.z.negate())))

// A soft Gaussian falloff, as three's own colour node draws it, which Hardness sharpens into a flat disc
export const softColor: SplatShading = (texel) =>
  Fn(() => {
    const r2 = dot(splatUv, splatUv).toVar()
    If(r2.greaterThan(4), () => {
      Discard()
    })
    // From 0 at the centre to 1 at the edge
    const q = r2.div(4)
    const falloff = exp(pow(q, pow(hardestExponent, hardness)).mul(-2))
    // A thin fade at the rim softens a hard disc's stair-steps
    const rim = mix(1, smoothstep(0.96, 1, q).oneMinus(), hardness)
    return vec4(texel.rgb.mul(depthShade), falloff.mul(texel.a.mul(splatColor.a)).mul(opacity).mul(rim))
  })()

// A shaded sphere with a hard edge.
// Round splats are turned to arbitrary angles, so the light comes from the viewer, which needs no direction on the splat.
// A solid sphere is drawn whole, so its texel's alpha is full, and it hides what's behind it, so its alpha is the rim's
// fade alone, which only smooths its edge. A translucent sphere may be cut: its alpha is also multiplied by the cut,
// 1 where its surface lies under the pixel and 0 where the cut takes it away
function sphereShading(solid: boolean, cut?: Node<'float'>): SplatShading {
  return (texel) =>
    Fn(() => {
      // From 0 at the centre to 1 at the edge
      const q = dot(splatUv, splatUv).div(4).toVar()
      If(q.greaterThan(1), () => {
        Discard()
      })
      // How directly the sphere's surface faces the viewer, from 1 at the centre to 0 at the edge
      const facing = sqrt(q.oneMinus()).toVar()
      const shade = facing.mul(shading).add(shading.oneMinus())
      const glint = pow(facing, shininess).mul(highlight)
      const rgb = texel.rgb.mul(shade).add(glint).toVar()
      // Outline inks the outermost part of the radius black, and at 0 leaves the colour untouched
      If(outline.greaterThan(0), () => {
        const inner = outline.oneMinus()
        rgb.mulAssign(smoothstep(inner.sub(inkFade), inner, sqrt(q)).oneMinus())
      })
      // A thin fade at the rim softens its stair-steps
      const edge = smoothstep(0.96, 1, q).oneMinus()
      const translucent = texel.a.mul(splatColor.a).mul(opacity).mul(edge)
      return vec4(rgb.mul(depthShade), solid ? edge : cut ? translucent.mul(cut) : translucent)
    })()
}

export const sphereColor = sphereShading(false)
export const solidSphereColor = sphereShading(true)
// A translucent sphere cut where its surface lies inside its neighbours, by a cut of 1 or 0 under each pixel
export const cutSphereColor = (cut: Node<'float'>) => sphereShading(false, cut)

// three widens every splat's projected variance by this, in square pixels, so that none is drawn thinner than a pixel
const screenVariance = 0.3
// three draws each splat out to two standard deviations, so a sphere's edge is at twice its splat's scale
const kernelCutoff = 2

// The direction of the pixel's ray from the camera, in view space
export const rayDirection = normalize(positionView)

// How far along the pixel's ray it enters a sphere, from the sphere's centre and radius in view space, or, where the
// drawn edge reaches past the sphere, how far along it passes nearest. The discriminant is taken as the radius squared
// less the ray's miss squared, which keeps its precision at the structure's distance. The sphere's depth and the cut
// both build on it. It builds its nodes in place rather than as a shader function: as a function, the compiled
// arithmetic rounded differently, which moved a few pixels along the solid spheres' creases
export function sphereEntry(centre: Node<'vec3'>, radius: Node<'float'>) {
  const along = dot(rayDirection, centre)
  const across = centre.sub(rayDirection.mul(along))
  return along.sub(sqrt(max(radius.mul(radius).sub(dot(across, across)), 0)))
}

// The depth of a solid sphere's surface under each pixel, so that spheres that meet cut into one another along the
// curve where they cross. A splat is drawn flat at its centre's depth, so the sphere is found from how the splat's
// coordinates and the view position change across the screen. Those rates come first, ahead of any discard, as WGSL
// allows them only where every pixel of a group takes the same path; three builds a material's depth before its colour.
// Both are rates per screen pixel, so which way the screen's y runs makes no difference
export const sphereDepth = Fn(() => {
  const acrossX = dFdx(splatUv).toVar()
  const acrossY = dFdy(splatUv).toVar()
  const viewAcrossX = dFdx(positionView.xy).toVar()
  const viewAcrossY = dFdy(positionView.xy).toVar()
  // The pixel's view position lies on its ray at the centre's depth, so the centre is that less the pixel's offset
  // from it: the splat coordinates taken back through their rates give the offset in pixels, and the view position's
  // rates give it in view units
  const det = acrossX.x.mul(acrossY.y).sub(acrossX.y.mul(acrossY.x))
  const pixels = vec2(
    acrossY.y.mul(splatUv.x).sub(acrossY.x.mul(splatUv.y)),
    acrossX.x.mul(splatUv.y).sub(acrossX.y.mul(splatUv.x)),
  ).div(det)
  const centre = vec3(positionView.xy.sub(viewAcrossX.mul(pixels.x)).sub(viewAcrossY.mul(pixels.y)), positionView.z)
  // three draws a sphere away from the view's centre stretched towards it but not across it, so the splat's narrowest
  // scale in pixels, the inverse of its coordinates' steepest rate, holds the true radius once the widening is taken
  // off, in view units per pixel at the centre's depth
  const sum = length(vec2(acrossX.x.add(acrossY.y), acrossY.x.sub(acrossX.y)))
  const difference = length(vec2(acrossX.x.sub(acrossY.y), acrossY.x.add(acrossX.y)))
  const narrowest = float(2).div(sum.add(difference))
  const perPixel = sqrt(abs(viewAcrossX.x.mul(viewAcrossY.y).sub(viewAcrossX.y.mul(viewAcrossY.x))))
  const radius = sqrt(max(narrowest.mul(narrowest).sub(screenVariance), 0)).mul(kernelCutoff).mul(perPixel)
  return viewZToPerspectiveDepth(sphereEntry(centre, radius).mul(rayDirection.z), cameraNear, cameraFar)
})()
