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

// Whether the spheres are drawn solid, each hiding what's behind it and cutting into the spheres it meets: at full
// Opacity in normal blending, with Focus on all or Fade at full, and Models and Alternates on first, so that no atom
// is drawn faint by Focus, by every model at once or by its occupancy. Their depth is worked out for round splats, so
// ellipsoids stay as they are
export function isSolid(
  options: Pick<
    ViewOptions,
    'style' | 'blend' | 'opacity' | 'focus' | 'fade' | 'models' | 'conformations' | 'ellipsoids'
  >,
) {
  return (
    options.style === 'spheres' &&
    options.blend === 'normal' &&
    options.opacity === 1 &&
    (options.focus === 'all' || options.fade === 1) &&
    options.models === 'first' &&
    options.conformations === 'first' &&
    !options.ellipsoids
  )
}

// Whether everything drawn hides what's behind it, so that the depth of what's in view is all there is to see: solid
// spheres, or the surface at full Opacity
export function isOpaque(options: Parameters<typeof isSolid>[0]) {
  return isSolid(options) || (options.style === 'surface' && options.opacity === 1)
}
