import type { EntryHolds, ViewOptions } from '../options.ts'

// The styles' ids, each of which has an entry in styles below. The type is written out rather than read from the
// entries, as the options' type is built on it
export type Style = 'soft' | 'spheres' | 'surface' | 'field'

// How a style draws the atoms: a splats style draws each as an ellipsoid, the surface style meshes them by marching
// cubes instead, and the volume style draws the density the mesher marches as a cloud, by a ray march through the grid
// it's sampled on
export type StyleKind = 'splats' | 'surface' | 'volume'

interface StyleEntry {
  id: Style
  label: string
  kind: StyleKind
}

// The ways the panel's Style chooser can draw the atoms, in its order; an entry added here, with its id in Style,
// appears there
export const styles = [
  { id: 'soft', label: 'soft', kind: 'splats' },
  { id: 'spheres', label: 'spheres', kind: 'splats' },
  { id: 'surface', label: 'surface', kind: 'surface' },
  { id: 'field', label: 'field', kind: 'volume' },
] as const satisfies readonly StyleEntry[]

export function styleOf(style: Style): StyleEntry {
  return styles.find((entry) => entry.id === style) ?? styles[0]
}

// How a splat style lays its splats over one another, none of which needs them sorted, so that nothing flips as the
// view turns:
// - layered: each pixel shows the nearest surface, solid or see-through, by its depth. Only the spheres have a
//   surface to give a depth to, as do the ellipsoids and blobs drawn in their style
// - summed: the splats' colours are summed by how near and how opaque each is
// - glow: the splats' light is added together
export type Composite = 'layered' | 'summed' | 'glow'

// Whether a style's splats are layered: the spheres, always. They take no Blend, as a sphere summed or glowing would
// be a disc, as a soft splat is at full Hardness, and with its lighting off the same picture would have two settings
function isLayered(options: Pick<ViewOptions, 'style'>) {
  return options.style === 'spheres'
}

// The composite a style gives, which their Blend chooses for the soft splats, as they have no surface to layer, or
// null for the surface and the field, which draw no splats
export function compositeOf(options: Pick<ViewOptions, 'style' | 'blend'>): Composite | null {
  if (isLayered(options)) return 'layered'
  if (styleOf(options.style).kind !== 'splats') return null
  return options.blend === 'glow' ? 'glow' : 'summed'
}

// Whether the splats are summed by weight: the soft splats under the normal Blend
export function isWeighted(options: Pick<ViewOptions, 'style' | 'blend'>) {
  return compositeOf(options) === 'summed'
}

// The options that decide which layers the layered spheres are drawn in
type LayerOptions = Pick<ViewOptions, 'style' | 'opacity' | 'focus' | 'fade' | 'conformations'>

// Whether an entry has alternates to draw, which is all the layers ask of it
type Alternates = Pick<EntryHolds, 'alternates'>

// Whether the layered spheres have a see-through layer: below full Opacity, where every atom is see-through, or with
// atoms that Focus fades but doesn't hide, or with Alternates on all in an entry that has them, whose atoms keep their
// occupancy's share. Fade at 0 hides the atoms out of focus, and at 1 leaves them whole, so neither makes a layer. A
// picked Focus counts before any atom is picked, so that a pick paints the atoms without building them again
export function hasGhosts(options: LayerOptions, entry: Alternates) {
  return (
    isLayered(options) &&
    (options.opacity < 1 ||
      (options.focus !== 'all' && options.fade > 0 && options.fade < 1) ||
      (options.conformations === 'all' && entry.alternates))
  )
}

// Whether the layered spheres have a solid layer: at full Opacity, where an atom nothing fades is solid
export function hasSolids(options: LayerOptions) {
  return isLayered(options) && options.opacity === 1
}

// The options that decide whether the far side is drawn: the layers' and the Back shell switch
type BackShellOptions = LayerOptions & Pick<ViewOptions, 'backShell'>

// Whether the far side of what's see-through is drawn under its near side, so that it reads as hollow glass: the Back
// shell switch on, with a see-through layer of spheres or the surface below full Opacity. At full Opacity the surface
// is opaque and hides its far side, as solid spheres do theirs, so the switch draws nothing
export function isBackShell(options: BackShellOptions, entry: Alternates) {
  return options.backShell && (hasGhosts(options, entry) || (options.style === 'surface' && options.opacity < 1))
}

// Whether everything drawn hides what's behind it, so that the depth of what's in view is all there is to see: the
// layered spheres with no see-through layer, or the surface at full Opacity
export function isOpaque(options: LayerOptions, entry: Alternates) {
  return (hasSolids(options) && !hasGhosts(options, entry)) || (options.style === 'surface' && options.opacity === 1)
}
