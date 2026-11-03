import { Discard, dot, Fn, If, pow, smoothstep, sqrt, varyingProperty, vec4 } from 'three/tsl'

// Replaces GaussianSplat's colour node to draw each splat as a shaded sphere with a hard edge.
// It reads the splat's own varyings by name: its position across the splat, in standard deviations, and its colour.
// three cuts splats off at two standard deviations, so the sphere's edge is where the soft splat's is.
// Round splats are turned to arbitrary angles, so the light comes from the viewer, which needs no direction on the splat
const splatUv = varyingProperty('vec2', 'vSplatUv')
const splatColor = varyingProperty('vec4', 'vSplatColor')

export const sphereColor = Fn(() => {
  // From 0 at the centre to 1 at the edge
  const r2 = dot(splatUv, splatUv).div(4).toVar()
  If(r2.greaterThan(1), () => {
    Discard()
  })
  // How directly the sphere's surface faces the viewer, from 1 at the centre to 0 at the edge
  const facing = sqrt(r2.oneMinus()).toVar()
  const shade = facing.mul(0.75).add(0.25)
  const highlight = pow(facing, 24).mul(0.35)
  // A thin fade at the rim softens its stair-steps
  const edge = smoothstep(1, 0.96, r2)
  return vec4(splatColor.rgb.mul(shade).add(highlight), splatColor.a.mul(edge))
})()
