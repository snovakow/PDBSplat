import {
  cameraViewMatrix,
  Discard,
  dot,
  exp,
  float,
  Fn,
  If,
  max,
  mix,
  positionView,
  pow,
  renderGroup,
  smoothstep,
  sqrt,
  uniform,
  varyingProperty,
  vec4,
} from 'three/tsl'
import { defaultOptions, type ViewOptions } from '../store.ts'

// The splat styles' colour nodes, which replace GaussianSplat's own, and the depth cue every style shares.
// They read the splat's own varyings by name: its position across the splat, in standard deviations, and its colour.
// three cuts splats off at two standard deviations, so each style's edge is where the soft splat's is
const splatUv = varyingProperty('vec2', 'vSplatUv')
const splatColor = varyingProperty('vec4', 'vSplatColor')

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
export const softColor = Fn(() => {
  const r2 = dot(splatUv, splatUv).toVar()
  If(r2.greaterThan(4), () => {
    Discard()
  })
  // From 0 at the centre to 1 at the edge
  const q = r2.div(4)
  const falloff = exp(pow(q, pow(hardestExponent, hardness)).mul(-2))
  // A thin fade at the rim softens a hard disc's stair-steps
  const rim = mix(1, smoothstep(0.96, 1, q).oneMinus(), hardness)
  return vec4(splatColor.rgb.mul(depthShade), falloff.mul(splatColor.a).mul(opacity).mul(rim))
})()

// A shaded sphere with a hard edge.
// Round splats are turned to arbitrary angles, so the light comes from the viewer, which needs no direction on the splat
export const sphereColor = Fn(() => {
  // From 0 at the centre to 1 at the edge
  const q = dot(splatUv, splatUv).div(4).toVar()
  If(q.greaterThan(1), () => {
    Discard()
  })
  // How directly the sphere's surface faces the viewer, from 1 at the centre to 0 at the edge
  const facing = sqrt(q.oneMinus()).toVar()
  const shade = facing.mul(shading).add(shading.oneMinus())
  const glint = pow(facing, shininess).mul(highlight)
  const rgb = splatColor.rgb.mul(shade).add(glint).toVar()
  // Outline inks the outermost part of the radius black, and at 0 leaves the colour untouched
  If(outline.greaterThan(0), () => {
    const inner = outline.oneMinus()
    rgb.mulAssign(smoothstep(inner.sub(inkFade), inner, sqrt(q)).oneMinus())
  })
  // A thin fade at the rim softens its stair-steps
  const edge = smoothstep(0.96, 1, q).oneMinus()
  return vec4(rgb.mul(depthShade), splatColor.a.mul(opacity).mul(edge))
})()
