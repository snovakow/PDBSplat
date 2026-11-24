import { optionKeys, type EntryHolds, type ViewOptions } from './options.ts'
import { optionShows } from './shownOptions.ts'

// The panel's presets: looks set together, each of which shows off one thing the renderer draws, named for what that
// is, and chosen by eye on the antibody, the entry the page opens on, then checked on haemoglobin, crambin and the DNA.
// A preset sets every option of the look, so that it shows the same whatever was set before. It leaves as they are the
// options that choose which atoms are shown, as what's shown is the entry's to say, and Spin, which moves the view
// without changing how anything is drawn. The page opens on the first of them, as the defaults are its options

export interface Preset {
  // Its name in the panel's Preset list
  name: string
  options: ViewOptions
}

// What each preset starts from: plain solid spheres in their chains' colours with every effect off, and the settings
// that matter only while something else is on, Bloom's radius and threshold, AO's radius and Fade, as the page opens
// with them. The options that choose the atoms shown, and Spin, are here only to make a whole set, as a preset never
// applies them
const plain: ViewOptions = {
  style: 'spheres',
  resolution: 2,
  scale: 1,
  opacity: 1,
  backShell: false,
  hardness: 0,
  shading: 0.75,
  highlight: 0.35,
  shininess: 24,
  outline: 0,
  blend: 'normal',
  detail: 'auto',
  colorBy: 'chain',
  burial: 0,
  hydrogens: true,
  waters: false,
  models: 'first',
  conformations: 'first',
  thermal: 0,
  ellipsoids: false,
  focus: 'all',
  fade: 0.1,
  spin: true,
  depthCue: 0,
  clip: 0,
  bloom: 0,
  bloomRadius: 0.25,
  bloomThreshold: 0.9,
  ao: 0,
  aoRadius: 6,
}

// In the panel's order: the opening look and the other solid ellipsoids, the see-through layers, the surface, the soft
// splats and the field
export const presets: readonly Preset[] = [
  // The opening look, a space-filling model: every atom a solid, glossy sphere of its van der Waals radius, cut into
  // its neighbours pixel by pixel, in its chain's colour. The buried atoms and the far side are in shadow, ambient
  // occlusion darkens the contacts and the clefts between domains, and the brightest highlights glow
  {
    name: 'space-filling',
    options: {
      ...plain,
      shading: 0.9,
      highlight: 0.7,
      shininess: 40,
      burial: 0.5,
      depthCue: 0.5,
      bloom: 1,
      ao: 1,
    },
  },
  // Each atom coloured by its B-factor and swollen by it, so that the mobile loops bulge red around a still, blue core
  {
    name: 'B-factor',
    options: {
      ...plain,
      highlight: 0.5,
      shininess: 32,
      colorBy: 'bfactor',
      thermal: 1,
      depthCue: 0.5,
      ao: 1,
    },
  },
  // One solid, glossy ellipsoid per residue, each the merged shape of its atoms, with the contacts between them in
  // shadow
  {
    name: 'residue ellipsoids',
    options: {
      ...plain,
      highlight: 0.7,
      shininess: 40,
      detail: 'residues',
      burial: 0.4,
      depthCue: 0.6,
      bloom: 1,
      ao: 1,
    },
  },
  // See-through spheres as two layers: the nearest surface under each pixel over the farthest, the back shell, with
  // bright, tight highlights that glow
  {
    name: 'transparent shell',
    options: {
      ...plain,
      opacity: 0.4,
      backShell: true,
      highlight: 1,
      shininess: 56,
      depthCue: 0.4,
      bloom: 1.2,
      bloomRadius: 0.3,
      bloomThreshold: 0.75,
    },
  },
  // The backbone in focus, as solid beads coloured along each chain, inside the see-through layer of the side chains
  // around it: the nearest faded surface under each pixel, as faint dark glass that dims the beads it lies in front
  // of, so that a bead reads as deep in the structure as it is
  {
    name: 'backbone focus',
    options: {
      ...plain,
      highlight: 0.7,
      shininess: 40,
      colorBy: 'rainbow',
      focus: 'backbone',
      fade: 0.05,
      depthCue: 0.5,
      bloom: 0.6,
      bloomThreshold: 0.85,
    },
  },
  // The ligands and the residues that hold them in focus, solid and bright, with the rest of the structure faint dark
  // glass around them, which dims them where it lies in front of them. An entry without ligands keeps every atom in
  // focus, and so solid, which is where the look's ambient occlusion acts
  {
    name: 'ligand focus',
    options: {
      ...plain,
      highlight: 0.7,
      shininess: 40,
      focus: 'ligands',
      fade: 0.05,
      depthCue: 0.5,
      bloom: 1.2,
      bloomThreshold: 0.85,
      ao: 1,
    },
  },
  // The molecular surface, softly lit, its grooves shaded by burial and ambient occlusion
  {
    name: 'molecular surface',
    options: {
      ...plain,
      style: 'surface',
      burial: 0.5,
      depthCue: 0.6,
      ao: 1,
    },
  },
  // The surface in flat colour, inked black wherever it turns edge on, so that every fold is outlined as in an
  // illustration
  {
    name: 'outlined surface',
    options: {
      ...plain,
      style: 'surface',
      shading: 0.5,
      highlight: 0,
      outline: 0.12,
      depthCue: 0.5,
      ao: 1,
    },
  },
  // Every atom a soft Gaussian, summed by how near and how opaque each is, so that the structure reads as a cloud of
  // density, darker in its core and on its far side. The atoms are a little under their size and their edges a little
  // firmed, so that the cloud keeps its grain
  {
    name: 'Gaussian splats',
    options: {
      ...plain,
      style: 'soft',
      scale: 0.75,
      hardness: 0.3,
      burial: 0.7,
      depthCue: 0.6,
      bloom: 0.4,
      bloomThreshold: 0.85,
    },
  },
  // The backbone alone, as small Gaussians that add their light together and glow, coloured along each chain. Detail
  // stays on the atoms, since under auto a large entry, whose atoms are only a pixel or two across at its framing,
  // would draw its residues' blobs in their place
  {
    name: 'backbone glow',
    options: {
      ...plain,
      style: 'soft',
      scale: 0.5,
      opacity: 0.5,
      blend: 'glow',
      detail: 'atoms',
      colorBy: 'rainbow',
      focus: 'backbone',
      fade: 0,
      depthCue: 0.5,
      bloom: 1,
      bloomRadius: 0.3,
      bloomThreshold: 0.6,
    },
  },
  // The atoms' density as a cloud, marched ray by ray, from atoms at little more than half their size so that the
  // chains show as strands within it, coloured along each chain
  {
    name: 'density field',
    options: {
      ...plain,
      style: 'field',
      scale: 0.6,
      colorBy: 'rainbow',
      depthCue: 0.5,
    },
  },
]

// The options with a preset chosen: its look, with Hydrogens, Waters, Models, Alternates and Spin as they were, as the
// first four choose the atoms shown and Spin moves the view, rather than any of them setting how the atoms are drawn
export function withPreset(
  { hydrogens, waters, models, conformations, spin }: ViewOptions,
  preset: Preset,
): ViewOptions {
  return { ...preset.options, hydrogens, waters, models, conformations, spin }
}

// The preset whose look the options have, or undefined once a control of the look has moved from every preset's. A
// look is what its controls show for the entry, as the panel shows them: an option whose control the look hides
// changes nothing that's drawn, so it may hold anything. Which controls show can turn on the entry, as Alternates left
// on all makes a see-through layer only in an entry that has alternates
export function presetOf(options: ViewOptions, entry: EntryHolds) {
  return presets.find((preset) => {
    const look = withPreset(options, preset)
    return optionKeys.every((key) => look[key] === options[key] || !optionShows(key, look, entry))
  })
}

// What the Preset list reads once the options are no preset's
export const customLook = 'custom'

const presetNames = presets.map((preset) => preset.name)
const namesWithCustom = [...presetNames, customLook]

// The Preset list for a set of options and what the entry holds: what it reads, and what it lists, which is each
// preset by its name, and custom only while that's what it reads, as choosing custom would set nothing. Each of the
// two lists is the same array every time
export function presetList(options: ViewOptions, entry: EntryHolds) {
  const name = presetOf(options, entry)?.name
  return name === undefined ? { reads: customLook, names: namesWithCustom } : { reads: name, names: presetNames }
}
