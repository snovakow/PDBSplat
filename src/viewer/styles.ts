import type { NodeMaterial } from 'three/webgpu'
import { sphereColor } from './sphereColor.ts'

// The ways the panel's Style chooser can draw the atoms, in its order; an entry added here appears there.
// A splats style draws GaussianSplats, whose shading colorNode replaces, or null keeps as a soft Gaussian falloff.
// The surface style meshes the atoms by marching cubes instead
type StyleEntry =
  | { id: string; label: string; kind: 'splats'; colorNode: NodeMaterial['colorNode'] }
  | { id: string; label: string; kind: 'surface' }

export const styles = [
  { id: 'soft', label: 'soft', kind: 'splats', colorNode: null },
  { id: 'spheres', label: 'spheres', kind: 'splats', colorNode: sphereColor },
  { id: 'surface', label: 'surface', kind: 'surface' },
] as const satisfies readonly StyleEntry[]

export type Style = (typeof styles)[number]['id']

export function styleOf(style: Style): StyleEntry {
  return styles.find((entry) => entry.id === style) ?? styles[0]
}
