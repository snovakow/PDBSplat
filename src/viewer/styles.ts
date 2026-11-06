import type { NodeMaterial } from 'three/webgpu'
import type { ViewOptions } from '../store.ts'
import { softColor, sphereColor } from './shading.ts'

// The ways the panel's Style chooser can draw the atoms, in its order; an entry added here appears there.
// A splats style draws GaussianSplats, shaded by its colorNode in place of three's own.
// The surface style meshes the atoms by marching cubes instead
type StyleEntry =
  | { id: string; label: string; kind: 'splats'; colorNode: NonNullable<NodeMaterial['colorNode']> }
  | { id: string; label: string; kind: 'surface' }

export const styles = [
  { id: 'soft', label: 'soft', kind: 'splats', colorNode: softColor },
  { id: 'spheres', label: 'spheres', kind: 'splats', colorNode: sphereColor },
  { id: 'surface', label: 'surface', kind: 'surface' },
] as const satisfies readonly StyleEntry[]

export type Style = (typeof styles)[number]['id']

export function styleOf(style: Style): StyleEntry {
  return styles.find((entry) => entry.id === style) ?? styles[0]
}

// The options that decide whether the spheres write their depth, and whether they're solid
type SphereOptions = Pick<
  ViewOptions,
  'style' | 'blend' | 'opacity' | 'focus' | 'fade' | 'models' | 'conformations' | 'ellipsoids'
>

// Whether every atom is drawn as a whole, round sphere: in the spheres style and normal blending, with Focus on all or
// Fade at full, and Models and Alternates on first, so that no atom is drawn faint by Focus, by every model at once or
// by its occupancy, and with Ellipsoids off, as a sphere's depth is worked out for round splats. Only then can the
// spheres write their depth, since a faint or stretched one would hide what's behind it
export function isWholeSpheres(options: SphereOptions) {
  return (
    options.style === 'spheres' &&
    options.blend === 'normal' &&
    (options.focus === 'all' || options.fade === 1) &&
    options.models === 'first' &&
    options.conformations === 'first' &&
    !options.ellipsoids
  )
}

// The Opacity from which translucent spheres write their depth. The splats are re-sorted only once the view has turned
// enough, so until then a pair of overlapping spheres whose order has changed is drawn in the stale order. Drawn as flat
// discs at alpha a, their overlap then pops by a² of the two colours' difference at the next re-sort. With their depth
// written, the stale pair instead loses the farther sphere's share under the nearer one, a(1 − a) of its colour, which
// is the smaller of the two from a half up, and at most half the discs' pop from two thirds up
export const depthWriteOpacity = 2 / 3

// Whether the spheres are drawn solid, each hiding what's behind it and cutting into the spheres it meets: whole and
// round, at full Opacity
export function isSolid(options: SphereOptions) {
  return isWholeSpheres(options) && options.opacity === 1
}

// Whether the spheres are translucent but write their depth, so that they keep their creases and each lets through only
// what lies behind its surface: whole and round, from the depth-write Opacity up to but not including full
export function isDepthWritten(options: SphereOptions) {
  return isWholeSpheres(options) && options.opacity >= depthWriteOpacity && options.opacity < 1
}

// Whether everything drawn hides what's behind it, so that the depth of what's in view is all there is to see: solid
// spheres, or the surface at full Opacity
export function isOpaque(options: SphereOptions) {
  return isSolid(options) || (options.style === 'surface' && options.opacity === 1)
}
