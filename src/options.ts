import type { Style, StyleKind } from './viewer/styles.ts'

// The view options, what the panel sets and the scene draws, in one table that the store's defaults and the panel's
// controls are both built from. Each entry gives the panel folder it sits in, its label, its default, its range and
// step or its choices by their labels or that it's a switch, which styles show it, and, where another control hides it,
// the test on that control's value. The entries are in the panel's order.
// This module imports nothing at run time: the shading reads the defaults as it loads, and the styles are built from
// the shading, so a table that read the styles would close a cycle

export type ColorBy = 'element' | 'chain' | 'bfactor' | 'rainbow' | 'structure'

// Which atoms the splat styles keep in focus, fading the rest: residue and chain keep the picked atom's
export type Focus = 'all' | 'ligands' | 'backbone' | 'residue' | 'chain'

// How the splat styles lay splats over one another: in front of what's behind, or added to it so dense parts glow, or
// summed by how near and how opaque each is, so that the order they're drawn in never matters
export type Blend = 'normal' | 'glow' | 'weighted'

// Which level of detail the splat styles draw: the atoms, one Gaussian per residue or per chain, or whichever is still
// a few pixels across at the view's distance
export type Detail = 'auto' | 'atoms' | 'residues' | 'chains'

// Which of an entry's models are shown: the first, every one at once, or each in turn
export type Models = 'first' | 'all' | 'play'

// Which conformations are shown of the residues that have alternate locations: the first each lists, or every one
export type Conformations = 'first' | 'all'

// The panel's folders that hold options; Info holds the read-outs and the backend switch alone
export type Folder = 'Look' | 'Colour' | 'Atoms' | 'Scene'

// Which styles show a control: every style, the styles of one kind, or the styles named
export type ShownFor = 'every' | { kind: StyleKind } | { styles: readonly Style[] }

// Another control that hides this one, by its key in the table: this one shows only while that control's value is
// the one given, isn't it, or is above it
export type Dependence =
  | { option: string; is: boolean }
  | { option: string; isNot: string }
  | { option: string; above: number }

interface Control<T> {
  folder: Folder
  label: string
  default: T
  shownFor: ShownFor
  shownWhile?: Dependence
}

// A number in a range, moved by steps
export interface Slider extends Control<number> {
  kind: 'slider'
  min: number
  max: number
  step: number
}

export interface Switch extends Control<boolean> {
  kind: 'switch'
}

// One of the values listed, each by its label in the panel
export interface Choice<T extends string> extends Control<T> {
  kind: 'choice'
  choices: Record<string, T>
}

// The style, whose choices the panel lists from the styles themselves
export interface StyleChoice extends Control<Style> {
  kind: 'style'
}

export type OptionEntry = Slider | Switch | Choice<string> | StyleChoice

const slider = (entry: Omit<Slider, 'kind'>): Slider => ({ kind: 'slider', ...entry })
const toggle = (entry: Omit<Switch, 'kind'>): Switch => ({ kind: 'switch', ...entry })
const choice = <T extends string>(entry: Omit<Choice<T>, 'kind'>): Choice<T> => ({ kind: 'choice', ...entry })
const styleChoice = (entry: Omit<StyleChoice, 'kind'>): StyleChoice => ({ kind: 'style', ...entry })

const every: ShownFor = 'every'
const splats: ShownFor = { kind: 'splats' }
const soft: ShownFor = { styles: ['soft'] }
const spheres: ShownFor = { styles: ['spheres'] }
const spheresAndSurface: ShownFor = { styles: ['spheres', 'surface'] }
const surfaceAndField: ShownFor = { styles: ['surface', 'field'] }

// Bloom's spread and threshold until the panel moves them, chosen by eye on the antibody example in glow: a halo
// that hazes the space around the structure, from its dense core and bright atoms but not its faint edges
const bloomRadiusDefault = 0.4
const bloomThresholdDefault = 0.3
// Ambient occlusion's reach until the panel moves it, in ångströms, chosen by eye on the crambin and antibody examples:
// about an atom's width, so the contacts between neighbouring atoms darken while open faces stay bright
const aoRadiusDefault = 3

export const viewOptions = {
  style: styleChoice({ folder: 'Look', label: 'Style', default: 'soft', shownFor: every }),
  // The surface and field styles' grid points per ångström: higher meshes or samples more finely, and more slowly
  resolution: slider({
    folder: 'Look',
    label: 'Resolution',
    default: 2,
    min: 0.5,
    max: 4,
    step: 0.1,
    shownFor: surfaceAndField,
  }),
  // Times each atom's van der Waals radius
  scale: slider({ folder: 'Look', label: 'Size', default: 1, min: 0.25, max: 2, step: 0.05, shownFor: every }),
  opacity: slider({ folder: 'Look', label: 'Opacity', default: 0.9, min: 0, max: 1, step: 0.05, shownFor: every }),
  // The soft style's edge, from a Gaussian falloff at 0 to a flat disc at 1. Spheres always keep a hard edge
  hardness: slider({ folder: 'Look', label: 'Hardness', default: 0, min: 0, max: 1, step: 0.05, shownFor: soft }),
  // The spheres style's lighting: how much the shade falls off towards the rim, the highlight's strength,
  // how tight the highlight is, and the width of an ink rim, as a fraction of each sphere's radius
  shading: slider({ folder: 'Look', label: 'Shading', default: 0.75, min: 0, max: 1, step: 0.05, shownFor: spheres }),
  highlight: slider({ folder: 'Look', label: 'Highlight', default: 0.35, min: 0, max: 1, step: 0.05, shownFor: spheres }),
  shininess: slider({ folder: 'Look', label: 'Shininess', default: 24, min: 1, max: 64, step: 1, shownFor: spheres }),
  outline: slider({ folder: 'Look', label: 'Outline', default: 0, min: 0, max: 0.3, step: 0.01, shownFor: spheres }),
  // Blending acts on splats, so the surface leaves it out
  blend: choice<Blend>({
    folder: 'Look',
    label: 'Blend',
    default: 'normal',
    choices: { normal: 'normal', glow: 'glow', weighted: 'weighted' },
    shownFor: splats,
  }),
  // The atoms merged into one blob per residue or per chain, or the atoms themselves, or whichever is still a few
  // pixels across as the view zooms, which the surface leaves out
  detail: choice<Detail>({
    folder: 'Look',
    label: 'Detail',
    default: 'auto',
    choices: { auto: 'auto', atoms: 'atoms', residues: 'residues', chains: 'chains' },
    shownFor: splats,
  }),
  colorBy: choice<ColorBy>({
    folder: 'Colour',
    label: 'Colour by',
    default: 'element',
    choices: { element: 'element', chain: 'chain', 'B-factor': 'bfactor', rainbow: 'rainbow', structure: 'structure' },
    shownFor: every,
  }),
  // How far buried atoms darken, from none at 0 to black for the most buried at 1
  burial: slider({ folder: 'Colour', label: 'Burial', default: 0, min: 0, max: 1, step: 0.05, shownFor: every }),
  hydrogens: toggle({ folder: 'Atoms', label: 'Hydrogens', default: true, shownFor: every }),
  waters: toggle({ folder: 'Atoms', label: 'Waters', default: false, shownFor: every }),
  // An NMR entry's models, and the alternate conformations some residues have, in every style. An entry with one
  // model, or no alternates, shows the same atoms for each choice
  models: choice<Models>({
    folder: 'Atoms',
    label: 'Models',
    default: 'first',
    choices: { first: 'first', all: 'all', play: 'play' },
    shownFor: every,
  }),
  conformations: choice<Conformations>({
    folder: 'Atoms',
    label: 'Alternates',
    default: 'first',
    choices: { first: 'first', all: 'all' },
    shownFor: every,
  }),
  // Thermal, Ellipsoids, Focus and Fade act on splats, so the surface leaves them out. Thermal is how far each splat
  // spreads with its atom's thermal motion, as a multiple of the variance its B-factor gives. An ellipsoid is drawn
  // from the atom's motion alone, so Thermal steps aside while Ellipsoids is on
  thermal: slider({
    folder: 'Atoms',
    label: 'Thermal',
    default: 0,
    min: 0,
    max: 3,
    step: 0.05,
    shownFor: splats,
    shownWhile: { option: 'ellipsoids', is: false },
  }),
  // Draws each atom as its thermal ellipsoid in place of its round splat, which Thermal then doesn't act on
  ellipsoids: toggle({ folder: 'Atoms', label: 'Ellipsoids', default: false, shownFor: splats }),
  focus: choice<Focus>({
    folder: 'Atoms',
    label: 'Focus',
    default: 'all',
    choices: { all: 'all', ligands: 'ligands', backbone: 'backbone', 'picked residue': 'residue', 'picked chain': 'chain' },
    shownFor: splats,
  }),
  // What an atom out of focus keeps of its alpha
  fade: slider({
    folder: 'Atoms',
    label: 'Fade',
    default: 0.15,
    min: 0,
    max: 1,
    step: 0.05,
    shownFor: splats,
    shownWhile: { option: 'focus', isNot: 'all' },
  }),
  // How far the far side of the structure darkens, from none at 0 to black at 1
  depthCue: slider({ folder: 'Scene', label: 'Depth cue', default: 0, min: 0, max: 1, step: 0.05, shownFor: every }),
  // How far the near plane cuts into the structure from its front, from none at 0 to all of it at 1
  clip: slider({ folder: 'Scene', label: 'Clip', default: 0, min: 0, max: 1, step: 0.05, shownFor: every }),
  // The strength of a glow spread around bright parts of the scene, how far it spreads, from 0 to 1, and the
  // brightness, from 0 to 1, below which nothing glows. The spread and threshold matter only while it's on. They show
  // just below it, which says what they belong to, so their labels stay short enough for the panel's label column
  bloom: slider({ folder: 'Scene', label: 'Bloom', default: 0, min: 0, max: 3, step: 0.05, shownFor: every }),
  bloomRadius: slider({
    folder: 'Scene',
    label: 'Radius',
    default: bloomRadiusDefault,
    min: 0,
    max: 1,
    step: 0.05,
    shownFor: every,
    shownWhile: { option: 'bloom', above: 0 },
  }),
  bloomThreshold: slider({
    folder: 'Scene',
    label: 'Threshold',
    default: bloomThresholdDefault,
    min: 0,
    max: 1,
    step: 0.01,
    shownFor: every,
    shownWhile: { option: 'bloom', above: 0 },
  }),
  // How far ambient occlusion darkens the crevices of solid spheres or an opaque surface, from none at 0 to all of it
  // at 1, and how far around each point it looks for what shades it, in ångströms. It reads the depth of what's in
  // view, so it needs everything opaque: the spheres while they're solid, or the surface at full Opacity. The soft
  // splats are never opaque
  ao: slider({ folder: 'Scene', label: 'AO', default: 0, min: 0, max: 1, step: 0.05, shownFor: spheresAndSurface }),
  aoRadius: slider({
    folder: 'Scene',
    label: 'AO radius',
    default: aoRadiusDefault,
    min: 0.5,
    max: 10,
    step: 0.5,
    shownFor: spheresAndSurface,
    shownWhile: { option: 'ao', above: 0 },
  }),
}

// Each option's value, of the type its entry's default has: a slider's is any number, and a choice's one of its values
export type ViewOptions = { [K in keyof typeof viewOptions]: (typeof viewOptions)[K]['default'] }

// Whether a key names an option in the table
export function isOption(key: string): key is keyof ViewOptions {
  return Object.hasOwn(viewOptions, key)
}

// The options' keys, in the panel's order
export const optionKeys = Object.keys(viewOptions).filter(isOption)

// The options at their defaults, each taken from the table by name, as a loop over its keys can't be typed as the options
export const defaultOptions: ViewOptions = {
  style: viewOptions.style.default,
  resolution: viewOptions.resolution.default,
  scale: viewOptions.scale.default,
  opacity: viewOptions.opacity.default,
  hardness: viewOptions.hardness.default,
  shading: viewOptions.shading.default,
  highlight: viewOptions.highlight.default,
  shininess: viewOptions.shininess.default,
  outline: viewOptions.outline.default,
  blend: viewOptions.blend.default,
  detail: viewOptions.detail.default,
  colorBy: viewOptions.colorBy.default,
  burial: viewOptions.burial.default,
  hydrogens: viewOptions.hydrogens.default,
  waters: viewOptions.waters.default,
  models: viewOptions.models.default,
  conformations: viewOptions.conformations.default,
  thermal: viewOptions.thermal.default,
  ellipsoids: viewOptions.ellipsoids.default,
  focus: viewOptions.focus.default,
  fade: viewOptions.fade.default,
  depthCue: viewOptions.depthCue.default,
  clip: viewOptions.clip.default,
  bloom: viewOptions.bloom.default,
  bloomRadius: viewOptions.bloomRadius.default,
  bloomThreshold: viewOptions.bloomThreshold.default,
  ao: viewOptions.ao.default,
  aoRadius: viewOptions.aoRadius.default,
}
