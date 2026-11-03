import type { NodeMaterial } from 'three/webgpu'
import { sphereColor } from './sphereColor.ts'

// The ways the panel's Style chooser can draw the splats, in its order; an entry added here appears there.
// colorNode replaces GaussianSplat's own shading, or null keeps its soft Gaussian falloff
export const styles = [
  { id: 'soft', label: 'soft', colorNode: null },
  { id: 'spheres', label: 'spheres', colorNode: sphereColor },
] as const satisfies readonly { id: string; label: string; colorNode: NodeMaterial['colorNode'] }[]

export type Style = (typeof styles)[number]['id']

export function styleColorNode(style: Style) {
  return styles.find((entry) => entry.id === style)?.colorNode ?? null
}
