import type { Style, StyleKind } from './viewer/styles.ts'

// The view options, what the panel sets and the scene draws, in one table that the store's defaults and the panel's
// controls are both built from. Each entry gives the panel folder it sits in, its label, its default, its range and
// step or its choices by their labels or that it's a switch, which styles show it, and, where another control or what's
// drawn would leave it nothing to change, the test it shows by, so that the panel never offers a control that draws
// the same picture wherever it's set. The entries are in the panel's order.
// This module imports nothing at run time: the shading reads the defaults as it loads, so a table that read anything
// built on the shading would close a cycle

export type ColorBy = 'element' | 'chain' | 'bfactor' | 'rainbow' | 'structure'

// Which atoms the splat styles keep in focus, fading the rest: residue and chain keep the picked atom's
export type Focus = 'all' | 'ligands' | 'backbone' | 'residue' | 'chain'

// How the soft splats are laid over one another: summed, by how near and how opaque each is, or added to what's behind
// so dense parts glow. Neither depends on the order the splats are drawn in, so nothing flips as the view turns
export type Blend = 'normal' | 'glow'

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

// What an entry holds that a control acts on: more than one model, residues recorded in more than one conformation,
// waters, and hydrogens
export interface EntryHolds {
  models: boolean
  alternates: boolean
  waters: boolean
  hydrogens: boolean
}

// An entry that holds all of them, for which no control hides by the entry
export const wholeEntry: EntryHolds = { models: true, alternates: true, waters: true, hydrogens: true }

// What hides a control. Another control, by its key in the table: this one shows only while that control shows and its
// value is the one given, isn't it, or is above or below it. Or what's drawn: this one shows only while everything
// drawn hides what's behind it. Or the entry: this one shows only while the entry holds what it acts on
export type Dependence =
  | { option: string; is: boolean }
  | { option: string; isNot: string }
  | { option: string; above: number }
  | { option: string; below: number }
  | { opaque: true }
  | { entryHolds: keyof EntryHolds }

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

const slider = (entry: Omit<Slider, 'kind'>): Slider => ({ kind: 'slider', ...entry })
const toggle = (entry: Omit<Switch, 'kind'>): Switch => ({ kind: 'switch', ...entry })
const choice = <T extends string>(entry: Omit<Choice<T>, 'kind'>): Choice<T> => ({ kind: 'choice', ...entry })
const styleChoice = (entry: Omit<StyleChoice, 'kind'>): StyleChoice => ({ kind: 'style', ...entry })

const every: ShownFor = 'every'
const splats: ShownFor = { kind: 'splats' }
const soft: ShownFor = { styles: ['soft'] }
const spheresAndSurface: ShownFor = { styles: ['spheres', 'surface'] }
const surfaceAndField: ShownFor = { styles: ['surface', 'field'] }

// Bloom's spread and threshold until the panel moves them, chosen with the opening look below: a tight glow around the
// spheres' highlights and their brightest atoms, rather than a haze over the whole window
const bloomRadiusDefault = 0.25
const bloomThresholdDefault = 0.8
// Ambient occlusion's reach until the panel moves it, in ångströms, chosen with the opening look below: a little more
// than an atom's width, so that the contacts between neighbouring atoms and the hollows among them darken while open
// faces stay bright
const aoRadiusDefault = 4

// The defaults are the page's opening look, set together and chosen by eye on haemoglobin, the entry the page opens on,
// to show a structure at its most striking: solid, glossy spheres in their chains' colours, their buried atoms and the
// far side of the structure in shadow, ambient occlusion in the contacts between them, and a glow around their
// brightest highlights, over the page's black, turning slowly so that its depth shows as it moves. Opacity starts at
// full, as the spheres are solid only there, and ambient occlusion acts on them only while they're solid
export const viewOptions = {
  style: styleChoice({ folder: 'Look', label: 'Style', default: 'spheres', shownFor: every }),
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
  // Opacity stops short of 0, where nothing would be drawn whatever else was set
  opacity: slider({ folder: 'Look', label: 'Opacity', default: 1, min: 0.05, max: 1, step: 0.05, shownFor: every }),
  // The far side of the spheres or of the surface below full Opacity, drawn under the near side, so that the
  // structure reads as hollow glass. At full Opacity the far side is hidden, or lies among solid spheres, where it
  // isn't drawn, so the switch shows only below it
  backShell: toggle({
    folder: 'Look',
    label: 'Back shell',
    default: false,
    shownFor: spheresAndSurface,
    shownWhile: { option: 'opacity', below: 1 },
  }),
  // The soft style's edge, from a Gaussian falloff at 0 to a flat disc at 1
  hardness: slider({ folder: 'Look', label: 'Hardness', default: 0, min: 0, max: 1, step: 0.05, shownFor: soft }),
  // The lighting of the spheres and the surface, which is one: how much the shade falls off where a surface turns
  // from the viewer, the highlight's strength, how tight the highlight is, and the width of an ink rim where it turns
  // edge on, as a fraction of a sphere's radius. With no highlight there's nothing to tighten, so Shininess shows only
  // while Highlight is above 0
  shading: slider({
    folder: 'Look',
    label: 'Shading',
    default: 0.75,
    min: 0,
    max: 1,
    step: 0.05,
    shownFor: spheresAndSurface,
  }),
  highlight: slider({
    folder: 'Look',
    label: 'Highlight',
    default: 0.7,
    min: 0,
    max: 1,
    step: 0.05,
    shownFor: spheresAndSurface,
  }),
  shininess: slider({
    folder: 'Look',
    label: 'Shininess',
    default: 40,
    min: 1,
    max: 64,
    step: 1,
    shownFor: spheresAndSurface,
    shownWhile: { option: 'highlight', above: 0 },
  }),
  outline: slider({
    folder: 'Look',
    label: 'Outline',
    default: 0,
    min: 0,
    max: 0.3,
    step: 0.01,
    shownFor: spheresAndSurface,
  }),
  // Blending is the soft splats' alone. The spheres are always layered by their surfaces' depths: summed or glowing
  // they'd be discs, which the soft splats already are at full Hardness
  blend: choice<Blend>({
    folder: 'Look',
    label: 'Blend',
    default: 'normal',
    choices: { normal: 'normal', glow: 'glow' },
    shownFor: soft,
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
    default: 'chain',
    choices: { element: 'element', chain: 'chain', 'B-factor': 'bfactor', rainbow: 'rainbow', structure: 'structure' },
    shownFor: every,
  }),
  // How far buried atoms darken, from none at 0 to black for the most buried at 1
  burial: slider({ folder: 'Colour', label: 'Burial', default: 0.5, min: 0, max: 1, step: 0.05, shownFor: every }),
  // The four that choose which atoms are shown, in every style: the hydrogens, the waters, an NMR entry's models, and
  // the alternate conformations some residues have. Each shows only for an entry that holds what it chooses among,
  // as it would otherwise show the same atoms however it was set
  hydrogens: toggle({
    folder: 'Atoms',
    label: 'Hydrogens',
    default: true,
    shownFor: every,
    shownWhile: { entryHolds: 'hydrogens' },
  }),
  waters: toggle({
    folder: 'Atoms',
    label: 'Waters',
    default: false,
    shownFor: every,
    shownWhile: { entryHolds: 'waters' },
  }),
  models: choice<Models>({
    folder: 'Atoms',
    label: 'Models',
    default: 'first',
    choices: { first: 'first', all: 'all', play: 'play' },
    shownFor: every,
    shownWhile: { entryHolds: 'models' },
  }),
  conformations: choice<Conformations>({
    folder: 'Atoms',
    label: 'Alternates',
    default: 'first',
    choices: { first: 'first', all: 'all' },
    shownFor: every,
    shownWhile: { entryHolds: 'alternates' },
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
  // What an atom out of focus keeps of its alpha, down to none at 0, where it's hidden. It stops short of 1, where
  // nothing would fade, as with every atom in focus
  fade: slider({
    folder: 'Atoms',
    label: 'Fade',
    default: 0.15,
    min: 0,
    max: 0.95,
    step: 0.05,
    shownFor: splats,
    shownWhile: { option: 'focus', isNot: 'all' },
  }),
  // Turns the structure slowly about its y axis, upright as it's framed, by orbiting the camera round it, and holds the
  // turn while a drag moves the view. It moves the view without changing how anything is drawn, so a preset leaves it
  // as it is
  spin: toggle({ folder: 'Scene', label: 'Spin', default: true, shownFor: every }),
  // How far the far side of the structure darkens, from none at 0 to black at 1
  depthCue: slider({ folder: 'Scene', label: 'Depth cue', default: 0.85, min: 0, max: 1, step: 0.05, shownFor: every }),
  // How far the cut reaches into the structure from its front, from none at 0. It stops short of 1, where it would
  // cut all of it away
  clip: slider({ folder: 'Scene', label: 'Clip', default: 0, min: 0, max: 0.95, step: 0.05, shownFor: every }),
  // The strength of a glow spread around bright parts of the scene, how far it spreads, from 0 to 1, and the
  // brightness, from 0 to 1, below which nothing glows. The spread and threshold matter only while it's on, and show
  // just below it, each named for it as the occlusion's radius is for AO
  bloom: slider({ folder: 'Scene', label: 'Bloom', default: 1, min: 0, max: 3, step: 0.05, shownFor: every }),
  bloomRadius: slider({
    folder: 'Scene',
    label: 'Bloom radius',
    default: bloomRadiusDefault,
    min: 0,
    max: 1,
    step: 0.05,
    shownFor: every,
    shownWhile: { option: 'bloom', above: 0 },
  }),
  bloomThreshold: slider({
    folder: 'Scene',
    label: 'Bloom threshold',
    default: bloomThresholdDefault,
    min: 0,
    max: 1,
    step: 0.01,
    shownFor: every,
    shownWhile: { option: 'bloom', above: 0 },
  }),
  // How far ambient occlusion darkens the crevices of solid spheres or an opaque surface, from none at 0 to all of it
  // at 1, and how far around each point it looks for what shades it, in ångströms. It reads the depth of what's in
  // view, so it needs everything opaque: the spheres while none of them is see-through, or the surface at full
  // Opacity. The soft splats are never opaque. It shows only while it acts, and its radius only while it does
  ao: slider({
    folder: 'Scene',
    label: 'AO',
    default: 1,
    min: 0,
    max: 1,
    step: 0.05,
    shownFor: spheresAndSurface,
    shownWhile: { opaque: true },
  }),
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
  backShell: viewOptions.backShell.default,
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
  spin: viewOptions.spin.default,
  depthCue: viewOptions.depthCue.default,
  clip: viewOptions.clip.default,
  bloom: viewOptions.bloom.default,
  bloomRadius: viewOptions.bloomRadius.default,
  bloomThreshold: viewOptions.bloomThreshold.default,
  ao: viewOptions.ao.default,
  aoRadius: viewOptions.aoRadius.default,
}
