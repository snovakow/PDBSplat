import type { ViewOptions } from '../options.ts'
import { softColor, sphereColor, type SplatShading } from './shading.ts'

// The styles' ids, each of which has an entry in styles below. The type is written out rather than read from the
// entries, so that the options' type, which the shading reads its defaults through, doesn't lean on the shading
export type Style = 'soft' | 'spheres' | 'surface' | 'field'

// The ways the panel's Style chooser can draw the atoms, in its order; an entry added here, with its id in Style,
// appears there.
// A splats style draws GaussianSplats, shaded by its colorNode in place of three's own, built for each splat on its
// read of the atom table.
// The surface style meshes the atoms by marching cubes instead, and the volume style draws the density the mesher
// marches as a cloud, by a ray march through the grid it's sampled on
type StyleEntry =
  | { id: Style; label: string; kind: 'splats'; colorNode: SplatShading }
  | { id: Style; label: string; kind: 'surface' }
  | { id: Style; label: string; kind: 'volume' }

export type StyleKind = StyleEntry['kind']

export const styles = [
  { id: 'soft', label: 'soft', kind: 'splats', colorNode: softColor },
  { id: 'spheres', label: 'spheres', kind: 'splats', colorNode: sphereColor },
  { id: 'surface', label: 'surface', kind: 'surface' },
  { id: 'field', label: 'field', kind: 'volume' },
] as const satisfies readonly StyleEntry[]

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

// Whether the splats are summed by weight rather than laid over one another: the weighted Blend, in a splat style, as
// the surface takes no Blend
export function isWeighted(options: Pick<ViewOptions, 'style' | 'blend'>) {
  return options.blend === 'weighted' && styleOf(options.style).kind === 'splats'
}
