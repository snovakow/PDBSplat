import type { NodeMaterial } from 'three/webgpu'
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
